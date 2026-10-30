#!/usr/bin/env bash
# Build an isolated Pi-Bolt 1.0.7 native .mjs host from verified release inputs.
set -euo pipefail

usage() {
  printf '%s\n' 'Usage: scripts/build-patched-host.sh OUTPUT_DIR [ARCHIVE_CACHE_DIR]' \
    'OUTPUT_DIR must not exist. Cached archives may use their release filenames' \
    'or the first 16 checksum characters followed by the release filename.'
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
release_tag=pi-bolt-1.0.7-native-loader
base_url="https://github.com/opensec-git/Pi-Bolt/releases/download/$upstream_tag"
stock_archive=pi-bolt-linux-arm64.tar.gz
kit_archive=pi-bolt-kit-linux-arm64.tar.gz
runtime_archive=pi-bolt-runtime-linux-arm64.tar.gz
stock_sha=f794e8063f1806d0eec6997df825c68b9afb13d50929b00504376c7a3e8a8cd3
kit_sha=146aff9f595fb53208e238d90554778bf17d7599a8fa02cef234bcebcfa12e86
runtime_sha=a7177cf427235c4b2c811c2b88399d76f05979a3a6600751ecb22b7590c6d8a6

get_archive() {
  local name=$1 expected=$2 candidate=""
  if [[ -n $cache ]]; then
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
stock="$output/stock/pi-bolt-linux-arm64"
kit="$work/pi-bolt-kit-linux-arm64"
[[ -x $stock/pi && -f $kit/kit.json ]] || fail 'unexpected upstream archive layout'
git -C "$kit/tree" apply --no-index --check \
  --include=packages/coding-agent/dist/core/extensions/loader.js \
  "$repo/patches/pi-bolt-native-mjs.patch"
git -C "$kit/tree" apply --no-index \
  --include=packages/coding-agent/dist/core/extensions/loader.js \
  "$repo/patches/pi-bolt-native-mjs.patch"

mkdir -p "$work/agent" "$work/cwd" "$work/sentinel" "$work/tmp"
python3 - "$work" <<'PY'
import json
import pathlib
import sys
root = pathlib.Path(sys.argv[1])
(root / 'sentinel/package.json').write_text(json.dumps({
    'name': 'native-build-sentinel', 'type': 'module',
    'pi': {'extensions': ['./index.mjs']},
}) + '\n')
(root / 'sentinel/index.mjs').write_text('export default function () {}\n')
(root / 'agent/settings.json').write_text(json.dumps({
    'packages': [str(root / 'sentinel')],
}) + '\n')
PY

# No inherited account settings, provider keys, or GitHub token reach compilation.
(
  cd "$work/cwd"
  env -i PATH="$PATH" HOME="$HOME" LANG="${LANG:-C.UTF-8}" TMPDIR="$work/tmp" \
    PI_CODING_AGENT_DIR="$work/agent" PI_OFFLINE=1 \
    "$stock/pi" compile --kit "$kit" \
    --runtime "$output/downloads/$runtime_archive" --out "$output/pi-bolt-linux-arm64"
)
build="$output/pi-bolt-linux-arm64"
[[ -x $build/pi ]] || fail 'compiler did not produce a host executable'

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
python3 - "$repo" "$build" "$source_commit" "$upstream_commit" "$dirty" <<'PY'
import datetime
import hashlib
import json
import pathlib
import sys
repo, build = map(pathlib.Path, sys.argv[1:3])
source_commit, upstream_commit, dirty = sys.argv[3:]
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
    'buildArrangement': 'An empty native-build-sentinel factory satisfies the compile planner. The side-query extension is loaded from disk and is not compiled into this host.',
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

The empty native-build-sentinel factory is compiled into the host solely because
the upstream compiler requires an extension. It has no registrations or actions.
The side-query extension remains a separate package loaded from disk.
The optional DOOM example is omitted; its prebuilt WASM's matching source and
license files are not present in the upstream release archive.

Native ESM modules may remain cached after /reload. Restart after editing them.
No Android device testing or Android performance measurements are claimed.
EOF
cp -- "$build/build-provenance.json" "$output/build-provenance.json"
archive_name=pi-bolt-1.0.7-native-loader-linux-arm64.tar.gz
tar --sort=name --mtime="@$source_epoch" --owner=0 --group=0 --numeric-owner \
  -C "$output" -cf - pi-bolt-linux-arm64 | gzip -n > "$output/$archive_name"
(
  cd "$output"
  sha256sum "$archive_name" build-provenance.json > SHA256SUMS
)
cat > "$output/release-notes.md" <<EOF
Experimental Pi-Bolt 1.0.7 / Pi 1.4.0 host with the native .mjs loader patch,
built for Linux ARM64 with baseline CPU settings and JIT off.

Keep the executable beside all files in the archive. The side-query extension
is installed separately. The host and extension source commit is $source_commit;
build-provenance.json records the verified upstream inputs and new binary hash.

[Download the Linux ARM64 archive](https://github.com/Ansh99999/side-query-extension/releases/download/$release_tag/$archive_name).
[Install and platform notes](https://github.com/Ansh99999/side-query-extension/blob/$source_commit/docs/patched-host.md).

This release is published only after type checking, extension tests, both real
host loader proofs, both terminal smoke tests, and fresh 24-run benchmarks pass
in GitHub Actions. Raw Linux ARM64 measurements are attached as benchmark-results.json.
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
