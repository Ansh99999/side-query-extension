#!/usr/bin/env bash
# Build an isolated Pi-Bolt 1.0.7 native .mjs host from verified release inputs.
set -euo pipefail

usage() {
  printf '%s\n' 'Usage: scripts/build-patched-host.sh OUTPUT_DIR [ARCHIVE_CACHE_DIR]' \
    'OUTPUT_DIR must not exist. Cached archives may use their release filenames' \
    'or the first 16 checksum characters followed by the release filename.' \
    'SQ_STOCK_ARCHIVE may select a local stock archive; its pinned hash is checked.'
}
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
if [[ ${1:-} == --help || ${1:-} == -h ]]; then usage; exit 0; fi
[[ $# -ge 1 && $# -le 2 ]] || { usage >&2; exit 1; }
[[ $(uname -s) == Linux ]] || fail 'this build requires Linux ARM64'
case $(uname -m) in aarch64|arm64) ;; *) fail 'this build requires an ARM64 host';; esac

for command_name in git python3 tar gzip sha256sum; do
  command -v "$command_name" >/dev/null || fail "missing command: $command_name"
done
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
output=$(python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "$1")
cache=${2:-}
[[ ! -e $output ]] || fail "output already exists: $output"
mkdir -p -- "$output/stock" "$output/downloads"
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT

upstream_commit=7306219f2070af4429816e8879613057602ef814
upstream_tag=bolt-v1.0.7
release_tag=pi-bolt-1.0.7-native-loader-r2
base_url="https://github.com/opensec-git/Pi-Bolt/releases/download/$upstream_tag"
stock_archive=pi-bolt-linux-arm64.tar.gz
kit_archive=pi-bolt-kit-linux-arm64.tar.gz
runtime_archive=pi-bolt-runtime-linux-arm64.tar.gz
stock_sha=f794e8063f1806d0eec6997df825c68b9afb13d50929b00504376c7a3e8a8cd3
kit_sha=146aff9f595fb53208e238d90554778bf17d7599a8fa02cef234bcebcfa12e86
runtime_sha=a7177cf427235c4b2c811c2b88399d76f05979a3a6600751ecb22b7590c6d8a6

get_archive() {
  local name=$1 expected=$2 candidate=""
  if [[ $name == "$stock_archive" && -n ${SQ_STOCK_ARCHIVE:-} ]]; then
    candidate=$SQ_STOCK_ARCHIVE
    [[ -f $candidate ]] || fail "stock archive does not exist: $candidate"
  elif [[ -n $cache ]]; then
    if [[ -f $cache/$name ]]; then candidate="$cache/$name"
    elif [[ -f $cache/${expected:0:16}-$name ]]; then candidate="$cache/${expected:0:16}-$name"
    fi
  fi
  if [[ -n $candidate ]]; then
    cp -- "$candidate" "$output/downloads/$name"
  else
    command -v curl >/dev/null || fail 'curl is required for uncached release inputs'
    curl --fail --location --retry 3 --proto '=https' --tlsv1.2 \
      "$base_url/$name" --output "$output/downloads/$name"
  fi
  printf '%s  %s\n' "$expected" "$output/downloads/$name" | sha256sum --check --status \
    || fail "checksum mismatch: $name"
}
get_archive "$stock_archive" "$stock_sha"
get_archive "$kit_archive" "$kit_sha"
get_archive "$runtime_archive" "$runtime_sha"

tar -xzf "$output/downloads/$stock_archive" -C "$output/stock"
tar -xzf "$output/downloads/$kit_archive" -C "$work"
tar -xzf "$output/downloads/$runtime_archive" -C "$work"
stock="$output/stock/pi-bolt-linux-arm64"
kit="$work/pi-bolt-kit-linux-arm64"
runtime="$work/pi-bolt-runtime-linux-arm64/bun"
[[ -x $stock/pi && -f $kit/kit.json && -x $runtime ]] || fail 'unexpected upstream archive layout'
git -C "$kit/tree" apply --no-index --check \
  --include=packages/coding-agent/dist/core/extensions/loader.js \
  "$repo/patches/pi-bolt-native-mjs.patch"
git -C "$kit/tree" apply --no-index \
  --include=packages/coding-agent/dist/core/extensions/loader.js \
  "$repo/patches/pi-bolt-native-mjs.patch"

build="$output/pi-bolt-linux-arm64"
mkdir -p "$work/agent" "$work/tmp" "$build"
# Use the original release entry and all original worker entries. No generated
# extension wrapper, compiled-in extension, or inherited credential is involved.
python3 - "$stock" "$kit" "$runtime" "$build" "$work" "$output" <<'PY'
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time
stock, kit_dir, runtime, build, work, output = map(pathlib.Path, sys.argv[1:])
kit = json.loads((kit_dir / 'kit.json').read_text())
expected_entries = ['./dist/bun/cli.js', './src/utils/image-resize-worker.ts', './src/extensions/codemode/worker.ts']
assert kit['piBolt'] == '1.0.7' and kit['pi'] == '1.4.0' and kit['platform'] == 'linux-arm64'
assert kit['entries'] == expected_entries, 'The release entry and worker entries must be preserved'
assert kit['env']['BUN_AOT_CPU'] == 'baseline' and kit['env']['BUN_AOT_JIT'] == '0'
assert kit['env']['BUN_JSC_omitBytecodeFromStaticHeap'] == '1'
assert '--splitting' in kit['args']
macros = set(re.findall(rb'1\.0\.7 arm64 jit-off [a-f0-9]{16}', (stock / 'pi').read_bytes()))
assert len(macros) == 1, 'Could not identify the verified stock build macro'
macro = macros.pop().decode()
base_env = {key: os.environ[key] for key in ('PATH', 'HOME', 'LANG', 'LC_ALL') if key in os.environ}
base_env.update({'TMPDIR': str(work / 'tmp'), 'PI_CODING_AGENT_DIR': str(work / 'agent'), 'PI_OFFLINE': '1'})
compiler_env = {**base_env, **{key: value.replace('@KIT@', str(kit_dir)) for key, value in kit['env'].items()}}
args = [str(runtime), *[arg.replace('@KIT@', str(kit_dir)) for arg in kit['args']],
        '--define', f'PIBOLT_BUILD={json.dumps(macro)}', *kit['entries'], '--outfile', str(build / 'pi')]
started = time.monotonic()
log_path = output / 'build.log'
with log_path.open('w') as log:
    result = subprocess.run(args, cwd=kit_dir / kit['agent'], env=compiler_env, stdout=log, stderr=subprocess.STDOUT)
if result.returncode:
    print('\n'.join(log_path.read_text().splitlines()[-24:]), file=sys.stderr)
    raise SystemExit(result.returncode)
assert (build / 'pi').is_file(), 'Compiler did not produce the executable'
for path in stock.iterdir():
    if path.name == 'pi':
        continue
    target = build / path.name
    if path.is_dir():
        shutil.copytree(path, target, symlinks=True)
    else:
        shutil.copy2(path, target, follow_symlinks=False)
digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
sibling_files = [path for path in stock.rglob('*') if path.is_file() and path != stock / 'pi']
for path in sibling_files:
    copied = build / path.relative_to(stock)
    assert copied.is_file() and digest(path) == digest(copied), f'Missing or altered stock resource: {path.relative_to(stock)}'

def diagnose(binary):
    result = subprocess.run([str(binary), '--version'], cwd=work, env={**base_env, 'BUN_STATIC_HEAP_VERBOSE': '1'},
                            text=True, capture_output=True, check=True)
    heap = re.search(r'\[static heap\] (\d+) bytes in executable, mapped: true', result.stderr)
    image = re.search(r'\[aot\] image of (\d+) bytes mapped, (\d+) of them code', result.stderr)
    assert heap and image and '[aot] image registered: true' in result.stderr, result.stderr
    return {'version': result.stdout.strip(), 'staticHeapBytes': int(heap[1]), 'aotImageBytes': int(image[1]),
            'aotCodeBytes': int(image[2]), 'mappedAndRegistered': True, 'rawDiagnostics': result.stderr.strip()}

stock_info, patched_info = diagnose(stock / 'pi'), diagnose(build / 'pi')
assert stock_info == patched_info, f'Direct build must preserve stock version and heap/image dimensions: {stock_info} / {patched_info}'
state = {'originalEntries': kit['entries'], 'stockBuildMacro': macro, 'runtimeStamp': macro.rsplit(' ', 1)[1],
         'compilerArguments': args, 'kitEnvironment': kit['env'], 'sentinelCompiledIn': False,
         'generatedExtensionWrapper': False, 'stockBinarySha256': digest(stock / 'pi'),
         'stockBinaryBytes': (stock / 'pi').stat().st_size, 'binaryBytes': (build / 'pi').stat().st_size,
         'stockSiblingFileCount': len(sibling_files), 'stockSiblingsMatchedBeforeOptionalOmission': True,
         'runtimeValidation': {'stock': stock_info, 'patched': patched_info, 'matchesStock': True},
         'buildSeconds': time.monotonic() - started}
(work / 'direct-build.json').write_text(json.dumps(state, indent=2) + '\n')
print(f'Direct original-entry build completed in {state["buildSeconds"]:.1f}s; stock heap and AOT image dimensions match')
PY

# These are the full release's copied siblings. Only the optional DOOM demo is
# omitted: its shipped WASM does not include matching source and license files.
rm -rf -- "$build/examples/extensions/doom-overlay"
mkdir -p "$build/patches"
cp -- "$repo/patches/pi-bolt-native-mjs.patch" "$build/patches/"
cp -- "$repo/LICENSE" "$build/LICENSE.side-query"
cp -- "$repo/docs/patched-host.md" "$build/PATCHED_HOST.md"

source_commit=$(git -C "$repo" rev-parse HEAD)
source_epoch=$(git -C "$repo" show -s --format=%ct HEAD)
dirty=$(git -C "$repo" status --porcelain --untracked-files=normal)
python3 - "$repo" "$build" "$source_commit" "$upstream_commit" "$dirty" "$work/direct-build.json" <<'PY'
import datetime
import hashlib
import json
import pathlib
import sys
repo, build = map(pathlib.Path, sys.argv[1:3])
source_commit, upstream_commit, dirty, state_path = sys.argv[3:]
state = json.loads(pathlib.Path(state_path).read_text())
digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
provenance = {
    'piBoltVersion': '1.0.7', 'piVersion': '1.4.0',
    'platform': 'linux-arm64', 'aotCpu': 'baseline', 'jit': False,
    'upstreamTag': 'bolt-v1.0.7', 'upstreamCommit': upstream_commit,
    'extensionSourceCommit': source_commit,
    'extensionSourceTreeClean': not bool(dirty),
    'buildTimeUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'inputArchiveSha256': {
        'pi-bolt-linux-arm64.tar.gz': 'f794e8063f1806d0eec6997df825c68b9afb13d50929b00504376c7a3e8a8cd3',
        'pi-bolt-kit-linux-arm64.tar.gz': '146aff9f595fb53208e238d90554778bf17d7599a8fa02cef234bcebcfa12e86',
        'pi-bolt-runtime-linux-arm64.tar.gz': 'a7177cf427235c4b2c811c2b88399d76f05979a3a6600751ecb22b7590c6d8a6',
    },
    'patchSha256': digest(repo / 'patches/pi-bolt-native-mjs.patch'),
    'binarySha256': digest(build / 'pi'),
    'buildArrangement': 'Direct runtime build reusing kit compiler options and AOT settings with resolved paths, the original CLI entry and all worker entries. The compiler receives a sanitized base environment. No generated extension wrapper or compiled-in sentinel. The side-query extension is loaded from disk.',
    **state,
    'omittedOptionalAssets': ['examples/extensions/doom-overlay'],
    'actualAndroidDeviceTested': False,
}
(build / 'build-provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
PY

cat > "$build/SOURCE.md" <<EOF
# Patched host source and notices

Pi-Bolt 1.0.7 / Pi 1.4.0, Linux ARM64, baseline CPU, JIT off.
This is an experimental distribution maintained by Ansh99999.

The upstream application and unchanged compiler runtime come from
[Pi-Bolt $upstream_tag](https://github.com/opensec-git/Pi-Bolt/releases/tag/$upstream_tag),
at [source commit $upstream_commit](https://github.com/opensec-git/Pi-Bolt/tree/$upstream_commit).
The additional host change is distributed in patches/pi-bolt-native-mjs.patch.
The source checkout and build recipe are
[side-query-extension $source_commit](https://github.com/Ansh99999/side-query-extension/tree/$source_commit).
build-provenance.json records all input hashes and the output executable's hash.

Retain LICENSE, LICENSE.pi, THIRD_PARTY_NOTICES.md and LICENSE.side-query.
The bundled JavaScriptCore is modified upstream and is under LGPL-2.0 and
BSD licenses as described in THIRD_PARTY_NOTICES.md. Its exact source revisions
and patches are listed in
[sources.json](https://github.com/opensec-git/Pi-Bolt/blob/$upstream_commit/sources.json).
The corresponding runtime patches and build scripts are available in the same
[source tree](https://github.com/opensec-git/Pi-Bolt/tree/$upstream_commit/patches),
with [build instructions](https://github.com/opensec-git/Pi-Bolt/blob/$upstream_commit/docs/BUILDING.md).
The runtime is not changed by the native extension loader patch.

This build reuses kit compiler options and AOT settings with resolved paths,
preserves the original CLI and worker entries, and appends the verified stock
PIBOLT_BUILD definition and output path. The compiler receives a sanitized base
environment rather than the original release job's complete process environment.
It includes no generated extension wrapper or compiled-in extension sentinel.
Separate version diagnostics verify that its static heap and AOT image dimensions
match stock. These dimensions are not a measurement of resident process memory.
The side-query extension remains a separate package loaded from disk.
The optional DOOM example is omitted; its prebuilt WASM's matching source and
license files are not present in the upstream release archive.

Native ESM modules may remain cached after /reload. Restart after editing them.
No Android device testing or Android performance measurements are claimed.
EOF
cp -- "$build/build-provenance.json" "$output/build-provenance.json"
archive_name=pi-bolt-1.0.7-native-loader-r2-linux-arm64.tar.gz
tar --sort=name --mtime="@$source_epoch" --owner=0 --group=0 --numeric-owner \
  -C "$output" -cf - pi-bolt-linux-arm64 | gzip -n > "$output/$archive_name"
(
  cd "$output"
  sha256sum "$archive_name" build-provenance.json > SHA256SUMS
)
cat > "$output/release-notes.md" <<EOF
Experimental Pi-Bolt 1.0.7 / Pi 1.4.0 native .mjs host, revision 2, built for
Linux ARM64 with baseline CPU settings and JIT off. This revision preserves the
original release entry and has no generated wrapper or compiled-in sentinel.

A user reported roughly 16 MB more peak RSS in the first release, with roughly
unchanged startup time. Revision 2 changes the build route, but that result has
not been verified as resolved on the reported device. Matching compiled heap
dimensions does not prove process resident-memory parity.

Keep the executable beside all files in the archive. The side-query extension
is installed separately. The build recipe and extension come from $source_commit;
build-provenance.json records the verified upstream inputs and new binary hash.

[Download the Linux ARM64 archive](https://github.com/Ansh99999/side-query-extension/releases/download/$release_tag/$archive_name).
[Install and platform notes](https://github.com/Ansh99999/side-query-extension/blob/$source_commit/docs/patched-host.md).

Publication requires successful type checking, extension tests, both real host
loader proofs, both terminal smoke tests, and complete 24-run CLI and 12-run
terminal measurement runs in GitHub Actions. Completion of the measurements
does not automatically enforce an RSS or latency budget.
benchmark-results.json measures piped CLI spawn to exit;
terminal-resource-results.json records interactive startup and memory loadouts.
Static heap and AOT image dimensions are checked separately against stock.
Use the raw terminal measurements to assess resident memory and startup behavior.
Android/Termux remains experimental and has not been tested on an Android device.
Its glibc loader and launcher setup are required; the Linux executable cannot be
run directly in a default Termux installation. Restart after changing native ESM.

The archive includes upstream licenses and source links plus the loader patch.
The optional prebuilt DOOM demo is omitted as described in SOURCE.md.
EOF
if [[ -n ${GITHUB_OUTPUT:-} ]]; then
  {
    printf 'stock_binary=%s\n' "$stock/pi"
    printf 'patched_binary=%s\n' "$build/pi"
    printf 'release_dir=%s\n' "$output"
  } >> "$GITHUB_OUTPUT"
fi
printf 'Built %s\n' "$output/$archive_name"
