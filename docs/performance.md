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

## Interactive startup and memory

The command benchmarks below do not establish an interactive startup or memory
benefit. They measure an isolated `--list-models` process with one extension and
do not collect RSS. A mixed extension loadout can still initialize jiti for other
TypeScript/JavaScript entries even when side-query takes the native path.

The user supplied this separate device report on 2026-10-30: three runs per host,
the same installed extensions and settings, offline, through a pseudo-terminal.

| Host | Median first terminal output | Approximate median peak RSS |
| --- | ---: | ---: |
| Stock | 120 ms | 66 MB |
| Custom patched build (as reported) | 126 ms | 82 MB |

This report shows no meaningful startup improvement and about 16 MB (24%) more
peak resident memory for the patched build in that workload. First output is a
startup proxy, not a precise fully-ready measurement; three runs and an
unspecified device do not support general performance claims. The report excludes
model response/network time. [The supplied report](user-startup-resource-report.json)
records these limitations; its raw samples, device identity and binary hashes
were not supplied.

The released host was rebuilt through `pi-bolt compile` with a generated entry
wrapper and an inactive sentinel extension. It is not a build that differs from
stock only in the loader patch. The matching unpatched rebuild below controls for
that build route. Its local RSS was similar to stock, so the wrapper is not an established explanation of the
reported 16 MB increase. Do not assume the patched download is faster or uses
less memory with an arbitrary installed extension loadout.

## Matched interactive controls

Measured locally on Linux ARM64 with four logical CPUs on 2026-10-30: 12 measured
runs per host/loadout after two warmups, rotating launch order. The hosts share
identical isolated dummy-model settings and staged runtime package files. Native
UI, tools and themes are enabled; MCP, skills, prompt templates and context-file
discovery are disabled. No question is submitted and no model response is timed.
These are separate laboratory measurements, not a reproduction on the user's device.

Each cell is **native first-frame median in ms / peak RSS median in MiB**.

| Loadout | Stock | Unpatched wrapper rebuild | Original patched release | Stock-entry patched prototype |
| --- | ---: | ---: | ---: | ---: |
| No extensions | 56.9 / 65.9 | 56.1 / 65.8 | 56.3 / 65.7 | 56.7 / 66.0 |
| Side-query only | 86.3 / 88.8 | 85.4 / 88.8 | 61.1 / 70.4 | 60.7 / 70.6 |
| Side-query + one TypeScript fixture | 86.4 / 88.9 | 86.3 / 89.0 | 85.9 / 88.4 | 86.3 / 88.3 |

The patch helped the isolated side-query-only loadout here. Adding a harmless
TypeScript extension caused jiti to initialize in both hosts; the startup and
RSS advantage then disappeared. The unpatched wrapper rebuild did not show a
meaningful RSS increase over stock in these fixtures. The device's reported
16 MB increase remains unexplained; these local numbers do not invalidate it.

Revision 2 preserves the stock CLI entry, worker entries, compiler options, CPU
settings and runtime stamp, with no generated wrapper or sentinel. This removes
a build difference and matches stock's static heap/image dimensions; it is not
a demonstrated fix for the device-specific RSS report.

[Raw samples, hashes, flags and memory snapshots](terminal-resource-results.json)
include first terminal output, native `frame.written 1`, native `startup.done`,
and peak RSS from `wait4` plus sampled `/proc` high-water marks. First output may
be a capability query. A native frame/startup event does not guarantee every
background service is ready. The trace and `/proc` sampling add instrumentation
overhead; peak RSS includes the native 150 ms post-init dwell and shutdown.
Jiti cache is warm and the OS page cache is not flushed.

```sh
python3 scripts/benchmark-terminal.py \
  --case stock=/absolute/path/to/stock/pi \
  --case patched=/absolute/path/to/patched/pi \
  --runs 12 --warmups 2 --out terminal-results.json
```

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
SQ_BUILD=$(mktemp -d)
bash "$SQ_PACKAGE/scripts/build-patched-host.sh" "$SQ_BUILD/host"
node "$SQ_PACKAGE/scripts/check-native-loader.mjs" --binary "$SQ_BUILD/host/pi-bolt-linux-arm64/pi"
python3 "$SQ_PACKAGE/scripts/benchmark-terminal.py" \
  --case stock="$SQ_BUILD/host/stock/pi-bolt-linux-arm64/pi" \
  --case patched="$SQ_BUILD/host/pi-bolt-linux-arm64/pi" \
  --runs 12 --out "$SQ_BUILD/terminal-results.json"
```

The script verifies the matching full stock, kit and runtime archives. It applies
only the loader distribution hunk and calls the bundled runtime with the kit's
original CLI and worker entries, compiler options and AOT settings with resolved
paths, and the build macro extracted from verified stock. The base environment
is sanitized. It does not use `pi-bolt compile` or compile
in an inactive extension. Stock version, static heap and AOT image dimensions and
copied runtime assets are checked independently. Keep the executable beside all
its runtime assets. The earlier v0.1.0 and first-release builds used a generated
wrapper with a sentinel, as recorded in their original provenance files.

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
