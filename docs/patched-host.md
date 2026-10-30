# Patched Pi-Bolt host

The experimental native loader host is built from Pi-Bolt 1.0.7 / Pi 1.4.0 for
**Linux ARM64**, with baseline CPU settings and JIT off. It loads the extension's
`.mjs` entry directly on its first load. The side-query extension stays a separate
package on disk. Restart Pi-Bolt after changing native ESM files; `/reload` can
retain cached modules.

Revision 2 builds from the release kit's original CLI entry and worker entries,
with the original compiler options. It includes no generated extension wrapper
or compiled-in sentinel. The first prerelease remains available unchanged.

This download is experimental and has no established general interactive startup
or RSS advantage across arbitrary extension loadouts or on the reported device.
A user-reported three-run device comparison found roughly
the same startup time and about 16 MB more peak RSS. See the
[interactive startup and memory report](performance.md#interactive-startup-and-memory)
before choosing it as a performance optimization.

That report predates revision 2; its binaries were not identified by hash.
Revision 2 changes the first release's build route; its terminal resource results
are published separately for comparison.

The prerelease is created after GitHub Actions passes the extension's type check,
tests and build, real stock and patched host loader checks, and both terminal
smoke tests, then completes a fresh 24-run CLI microbenchmark and 12-run terminal
resource measurements of both hosts. Completing these measurements does not
require a particular performance improvement. Existing prerelease files are
preserved. These links become available when the revision 2 build succeeds:

- [Revision 2 prerelease](https://github.com/Ansh99999/side-query-extension/releases/tag/pi-bolt-1.0.7-native-loader-r2)
- [Linux ARM64 revision 2 archive](https://github.com/Ansh99999/side-query-extension/releases/download/pi-bolt-1.0.7-native-loader-r2/pi-bolt-1.0.7-native-loader-r2-linux-arm64.tar.gz)
- [SHA256SUMS](https://github.com/Ansh99999/side-query-extension/releases/download/pi-bolt-1.0.7-native-loader-r2/SHA256SUMS)
- [Build provenance](https://github.com/Ansh99999/side-query-extension/releases/download/pi-bolt-1.0.7-native-loader-r2/build-provenance.json)
- [CLI microbenchmark](https://github.com/Ansh99999/side-query-extension/releases/download/pi-bolt-1.0.7-native-loader-r2/benchmark-results.json)
- [Terminal startup and resource results](https://github.com/Ansh99999/side-query-extension/releases/download/pi-bolt-1.0.7-native-loader-r2/terminal-resource-results.json)

The terminal benchmark measures first output, native first frame and startup
completion events, resident memory, and peak RSS across baseline, side-query,
and mixed extension loadouts. These events do not guarantee that every background
service is ready. The CLI
microbenchmark measures piped process startup through `--list-models` and exit.
The older figures in `docs/benchmark-results.json` remain the v0.1.0 reference.
These are Linux ARM64 measurements; they do not establish Android performance.

## Linux ARM64

Use a Linux ARM64 system with glibc 2.17 or later. Download the archive and
SHA256SUMS into the same directory, then verify and extract it into a separate
installation directory:

```sh
sha256sum --ignore-missing --check SHA256SUMS
mkdir -p "$HOME/.local/share/side-query-patched-pi"
tar -xzf pi-bolt-1.0.7-native-loader-r2-linux-arm64.tar.gz \
  -C "$HOME/.local/share/side-query-patched-pi"
"$HOME/.local/share/side-query-patched-pi/pi-bolt-linux-arm64/pi" --version
"$HOME/.local/share/side-query-patched-pi/pi-bolt-linux-arm64/pi"
```

The final command uses the installed side-query package in your usual Pi agent
configuration. For a checkout loaded only for this invocation, use its absolute
entry path:

```sh
"$HOME/.local/share/side-query-patched-pi/pi-bolt-linux-arm64/pi" \
  --extension /absolute/path/to/side-query-extension/index.mjs
```

Keep `pi` beside all its archive files: `package.json`, `theme/`, `assets/`,
`export-html/`, `native/`, `photon_rs_bg.wasm`, documentation, examples and notices.
Moving only the executable loses the runtime's assets. The separate path leaves
your usual `pi-bolt` executable in place. Pi's agent settings are shared by default;
`PI_CODING_AGENT_DIR` can select another configuration directory.

The bundled upstream updater installs stock Pi-Bolt and would remove the loader
patch from this separate installation. Download a new patched release to update
this host.

## Android / Termux

**Experimental; no Android device has been tested.** The available download is a
Linux glibc executable, not an Android/Bionic binary. Default Termux cannot run it
directly. Use a 64-bit ARM device and a Termux installation that supplies the glibc
packages required by [upstream's Android instructions](https://github.com/opensec-git/Pi-Bolt/tree/7306219f2070af4429816e8879613057602ef814#android-termux).

Termux support requires the upstream installer's setup:

- Install `glibc-repo`, then `glibc`, so the loader exists at
  `$PREFIX/glibc/lib/ld-linux-aarch64.so.1`.
- After checking the downloaded archive's checksum, set the copied executable's
  ELF `PT_INTERP` to that loader using the upstream in-place installer routine.
  The ARM64 build reserves space for it. The routine must leave the executable's
  other bytes and segment locations intact.
- Use a launcher that preserves `LD_PRELOAD` as `PIBOLT_TERMUX_LD_PRELOAD`, removes
  `LD_PRELOAD` before starting Pi, and sets `TZ` from Android when needed. Pi
  restores the preload for child tools. Copy Termux's `resolv.conf` and `hosts`
  into `$PREFIX/glibc/etc` if those files are missing there.

The precise routines are in
[the pinned installer](https://github.com/opensec-git/Pi-Bolt/blob/7306219f2070af4429816e8879613057602ef814/install.sh#L1137).
Keep the patched host in a separate directory and use its own launcher. This
archive does not run the Termux setup automatically. The stock side-query
extension also works in upstream Pi-Bolt without rebuilding or compiling on the
Android device. Linux timing results are not Android measurements.

## Build and provenance

```sh
bash scripts/build-patched-host.sh /absolute/path/to/new-output-directory
```

The script requires Linux ARM64, Git, Python 3, tar, gzip, sha256sum, and curl for
uncached inputs. An optional second argument selects a local archive cache. It
verifies fixed SHA-256 hashes for the **full** baseline host, compile kit and
runtime from upstream `bolt-v1.0.7` and patches only the copied kit. It invokes the
trusted runtime with the kit's compiler options and AOT settings, resolving kit
paths and preserving the original CLI and worker entries. It appends the output
path and `PIBOLT_BUILD` value extracted from the verified stock executable.
The compiler receives a sanitized base environment; no existing agent settings
or inherited credentials are used.
The compiler runtime and kit contain the build tools and dependencies; no runtime
source compilation is required. `SQ_STOCK_ARCHIVE` can select a local stock
archive separately from the cache directory; the same pinned checksum applies.

Separate `--version` diagnostics verify that the direct build uses its AOT image
and preserves stock's static heap and AOT image dimensions. All stock sibling
resources are copied and checked before the optional DOOM example is omitted.
These checks describe the executable; resident memory still requires the terminal
measurements. Side-query remains on disk, and there is no compiled-in sentinel.

`build-provenance.json` records upstream and extension source commits, original
entries and compiler arguments, stock build macro, input and output hashes, CPU
settings, heap/image checks, and whether the source checkout was clean. Binary
hashes can differ across rebuilds because the compiler records temporary paths
and build metadata.

The archive retains upstream `LICENSE`, `LICENSE.pi`, and `THIRD_PARTY_NOTICES.md`,
adds `LICENSE.side-query`, the exact loader patch, and `SOURCE.md` with pinned
runtime source and build links. The optional prebuilt DOOM example is omitted
because its matching source and license files are absent from the upstream
archive. All other copied runtime assets remain in place.
