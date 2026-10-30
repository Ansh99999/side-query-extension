# Startup and Termux

The extension ships plain JavaScript and has no runtime dependencies. Its entry
registers `/btw`, Ctrl+/, and event handlers; the side-chat code loads when used.
The empty `typebox` import is a compatibility anchor to Pi's existing SDK. On
stock Pi-Bolt it makes jiti supply the host modules to later lazy imports, even
when the package has no `node_modules`. It installs no package.

Shipping `.mjs` alone does **not** eliminate stock Pi-Bolt's jiti initialization.
The included host patch adds a native `.mjs` path before that initialization and
uses Pi-Bolt's existing module bridge. This is a proposed Pi-Bolt change; installing
this extension on an unmodified release does not apply the patch.

## Measured startup

These figures describe extension v0.1.0. The v0.2.0 prerelease includes fresh
[raw benchmark results](patched-host.md) for the native UI/session changes.

Measured on **Linux ARM64**, Neoverse-N1, Pi-Bolt 1.0.7 / Pi 1.4.0, JIT off, on
2026-10-30. **Android/Termux has not been measured or tested on a device.**

| Case | Warm median | Warm p95 | Cold-loader median | Cold-loader p95 |
| --- | ---: | ---: | ---: | ---: |
| Stock baseline | 44.16 ms | 46.86 ms | 43.55 ms | 47.20 ms |
| Stock + extension | 77.88 ms | 90.18 ms | 106.69 ms | 118.30 ms |
| Patched baseline | 45.29 ms | 49.98 ms | 45.98 ms | 49.04 ms |
| Patched + extension | 53.36 ms | 55.77 ms | 53.11 ms | 56.17 ms |

The extension added 33.71 ms to the stock warm median and 8.07 ms to the patched
warm median. The native path removes the fixed jiti startup work; package discovery,
factory registration, and the compatibility anchor still have a measurable cost.
The rebuilt host has its own baseline, so compare each extension row with its
matching baseline. These figures measure offline process startup, not interactive
time to first rendered frame or provider response time.

Each case has 24 measured runs plus two excluded warmups, rotating and reversing
case order. The Node harness measures process spawn to close using `hrtime`, with
stdout/stderr piped. It uses the real package manifest through temporary agent
`settings.packages`, not `-e`. It stages `index.mjs`, `dist`, and the manifest into
a clean package with no development `node_modules`. Every process has temporary
settings, an in-memory main session, and one dummy model. The local dummy provider
received **zero HTTP requests**. “Cold-loader” removes the jiti filesystem cache
before each run; it does not flush the operating system's page cache.

[Raw samples and SHA-256 provenance](benchmark-results.json) include platform,
CPU, flags, binary hashes, package-file hashes, versions, and cache-file counts.
[Native build provenance](benchmark-results-native-build.json) records the source
commit, copied-kit/runtime hashes, patch hash, and inactive build sentinel.
The original test executable was `/tmp/side-query-native-pi/pi`. The [patched host prerelease](patched-host.md) builds the same patch from verified release inputs, runs the revised extension's checks, and includes new provenance and measurements.

## Reproduce the checks

From this package, with Node 22.19 or newer and Pi-Bolt available:

```sh
node scripts/check-native-loader.mjs --binary pi-bolt --allow-jiti
node scripts/benchmark.mjs --binary pi-bolt --runs 24 --out results.json
```

To compare a separately built patched host:

```sh
node scripts/check-native-loader.mjs --binary /absolute/path/to/patched/pi
node scripts/benchmark.mjs --binary pi-bolt \
  --native-binary /absolute/path/to/patched/pi --runs 24 --out results.json
```

The loader check proves actual manifest discovery and `/btw` registration, an
unloaded core at startup, lazy imports of Pi's bundled SDK without dependencies,
SDK alias identity, native Input/Text rendering, command registration after reload,
and native import failure reported without a second evaluation. No provider request
is needed. Its SDK proof uses a bounded fixture; the real overlay needs an
interactive terminal and is covered separately by the UI checks.

The request counter proves no traffic to the configured dummy provider; it is not
a packet capture of every system endpoint. The harness uses Pi's offline mode and
passes runtime/proxy plumbing without inherited provider credential variables.

`--compiled-binary PATH` adds matching compiled-host baseline and extension cases.
That case uses the original `--package` path because Pi-Bolt fingerprints compiled
extensions by source files. Compile that exact path first. The normal stock/native
cases always use the clean staged package. `--keep-temp` retains fixtures for
inspection; otherwise the scripts remove their temporary files.

## Native loader patch

[pi-bolt-native-mjs.patch](../patches/pi-bolt-native-mjs.patch) targets upstream
commit `7306219f2070af4429816e8879613057602ef814` and the matching 1.0.7 compile kit.
The source hunk changes `packages/coding-agent/src/core/extensions/loader.ts`.
The distribution hunk changes that kit's corresponding `dist/.../loader.js`.
Apply one hunk appropriate to the build input; a source build regenerates `dist`.

The first uncached `.mjs` entry in a Pi-Bolt Bun binary imports natively and gets
the existing bundled module bridge. `.js`, `.ts`, ordinary Pi runtimes, and cached
factory handling retain the existing loader. A native import error reaches the
existing extension error boundary without falling back during the same load,
so top-level side effects are not evaluated twice.

After explicit `/reload`, a previously attempted native entry returns to the stock
jiti route. Jiti may reuse native ESM modules, so **restart Pi-Bolt after editing
native `.mjs` or its JavaScript dependencies**. Reload calls the factory again;
the extension keeps mutable application state inside that factory. The patch
does not promise recursive native ESM cache invalidation.

Upstream references:
[filesystem loader](https://github.com/opensec-git/Pi-Bolt/blob/7306219f2070af4429816e8879613057602ef814/packages/coding-agent/src/core/extensions/loader.ts#L607),
[bundled module bridge](https://github.com/opensec-git/Pi-Bolt/blob/7306219f2070af4429816e8879613057602ef814/packages/coding-agent/src/core/extensions/compiled-modules.ts#L59), and
[manifest discovery](https://github.com/opensec-git/Pi-Bolt/blob/7306219f2070af4429816e8879613057602ef814/packages/coding-agent/src/core/package-manager.ts#L596).

## Build a separate patched Linux host

Use the **matching trusted release's** runtime and compile-kit archives. The
following recipe modifies only an unpacked kit in a new temporary folder, reads
no existing agent configuration, and writes a separate executable. It does not
change the installed Pi-Bolt. The example requires Linux ARM64 and Pi-Bolt 1.0.7.

```sh
SQ_PACKAGE=/absolute/path/to/side-query-extension
SQ_KIT_ARCHIVE=/absolute/path/to/pi-bolt-kit-linux-arm64.tar.gz
SQ_RUNTIME_ARCHIVE=/absolute/path/to/pi-bolt-runtime-linux-arm64.tar.gz
SQ_BUILD=$(mktemp -d)
export SQ_BUILD
tar -xzf "$SQ_KIT_ARCHIVE" -C "$SQ_BUILD"
git -C "$SQ_BUILD/pi-bolt-kit-linux-arm64/tree" apply --no-index \
  --include=packages/coding-agent/dist/core/extensions/loader.js \
  "$SQ_PACKAGE/patches/pi-bolt-native-mjs.patch"
node --input-type=module <<'JS'
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.SQ_BUILD;
for (const name of ['agent', 'cwd', 'sentinel']) mkdirSync(join(root, name));
writeFileSync(join(root, 'sentinel', 'package.json'), JSON.stringify({
  name: 'native-build-sentinel', type: 'module', pi: { extensions: ['./index.mjs'] }
}));
writeFileSync(join(root, 'sentinel', 'index.mjs'), 'export default function () {}\n');
writeFileSync(join(root, 'agent', 'settings.json'), JSON.stringify({
  packages: [join(root, 'sentinel')]
}));
JS
cd "$SQ_BUILD/cwd"
PI_CODING_AGENT_DIR="$SQ_BUILD/agent" pi-bolt compile \
  --kit "$SQ_BUILD/pi-bolt-kit-linux-arm64" \
  --runtime "$SQ_RUNTIME_ARCHIVE" --out "$SQ_BUILD/output"
node "$SQ_PACKAGE/scripts/check-native-loader.mjs" --binary "$SQ_BUILD/output/pi"
node "$SQ_PACKAGE/scripts/benchmark.mjs" --binary pi-bolt \
  --package "$SQ_PACKAGE" --native-binary "$SQ_BUILD/output/pi" \
  --runs 24 --out "$SQ_BUILD/results.json"
```

Pi-Bolt's compile planner rejects an empty extension set. The one-line sentinel
satisfies that build requirement. Benchmark configurations never discover its
package, so its factory is not loaded; **the side-query extension is not compiled
into this native-path test host**. The measured build retained the release kit's
`bun-linux-arm64` target and baseline CPU settings. Keep the executable beside
the assets Pi-Bolt copies into its output directory.

For a normal source checkout instead, check/apply only the source hunk, rebuild
Pi's distribution, then use the upstream build workflow:

```sh
git -C /absolute/path/to/Pi-Bolt apply --check \
  --include=packages/coding-agent/src/core/extensions/loader.ts \
  "$SQ_PACKAGE/patches/pi-bolt-native-mjs.patch"
git -C /absolute/path/to/Pi-Bolt apply \
  --include=packages/coding-agent/src/core/extensions/loader.ts \
  "$SQ_PACKAGE/patches/pi-bolt-native-mjs.patch"
```

## Termux

The stock extension works without `pi-bolt compile`. Stock Pi-Bolt 1.0.7 explicitly
rejects that command in Termux in
[pi-bolt-compile.ts](https://github.com/opensec-git/Pi-Bolt/blob/7306219f2070af4429816e8879613057602ef814/packages/coding-agent/src/pi-bolt-compile.ts#L2198).
The native loader patch is a host solution that can load installed `.mjs` packages
without compiling them on the Android device. It requires a Pi-Bolt executable
built with that patch; this package cannot patch an installed binary itself.

Build the host on Linux ARM64 using the release's portable runtime and baseline
settings, then distribute/install it through Pi-Bolt's Termux-aware installer
workflow. That workflow selects Termux's glibc interpreter, restores child-process
environment handling, and writes the launcher. Upstream's ARM64 runtime handles
4 KB, 16 KB, and 64 KB kernel pages and Android's smaller address space; using a
host-native runtime or a generic Bun build would need its own compatibility
verification. See
[Android installation](https://github.com/opensec-git/Pi-Bolt/blob/7306219f2070af4429816e8879613057602ef814/README.md#android-termux) and
[portable ARM64 build requirements](https://github.com/opensec-git/Pi-Bolt/blob/7306219f2070af4429816e8879613057602ef814/docs/BUILDING.md#linux-arm64-in-a-container).

On an actual Termux device, collect its own measurements with the same scripts:

```sh
node scripts/check-native-loader.mjs --binary pi-bolt --allow-jiti
node scripts/benchmark.mjs --binary pi-bolt --runs 24 --out termux-stock.json
node scripts/check-native-loader.mjs --binary /absolute/path/to/patched/pi-termux
node scripts/benchmark.mjs --binary pi-bolt \
  --native-binary /absolute/path/to/patched/pi-termux \
  --runs 24 --out termux-comparison.json
```

Use the Termux launcher for the patched build and keep its sibling assets. These
are reproducible device checks, not results already obtained on Android.
