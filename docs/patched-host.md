# Patched Pi-Bolt host

The experimental native loader host is built from Pi-Bolt 1.0.7 / Pi 1.4.0 for
**Linux ARM64**, with baseline CPU settings and JIT off. It loads the extension's
`.mjs` entry directly on its first load. The side-query extension stays a separate
package on disk. Restart Pi-Bolt after changing native ESM files; `/reload` can
retain cached modules.

The prerelease is created after GitHub Actions passes the extension's type check,
tests and build, real stock and patched host loader checks, and both terminal
smoke tests, followed by fresh 24-run benchmarks of both hosts. An existing
prerelease's files are preserved. These links become
available only when that first build succeeds:

- [Patched host prerelease](https://github.com/Ansh99999/side-query-extension/releases/tag/pi-bolt-1.0.7-native-loader)
- [Linux ARM64 archive](https://github.com/Ansh99999/side-query-extension/releases/download/pi-bolt-1.0.7-native-loader/pi-bolt-1.0.7-native-loader-linux-arm64.tar.gz)
- [SHA256SUMS](https://github.com/Ansh99999/side-query-extension/releases/download/pi-bolt-1.0.7-native-loader/SHA256SUMS)
- [Build provenance](https://github.com/Ansh99999/side-query-extension/releases/download/pi-bolt-1.0.7-native-loader/build-provenance.json)
- [Fresh benchmark results](https://github.com/Ansh99999/side-query-extension/releases/download/pi-bolt-1.0.7-native-loader/benchmark-results.json)

The attached benchmark measures the source included in this release. The older
figures in `docs/benchmark-results.json` remain the v0.1.0 reference. Both are
Linux ARM64 measurements; they do not establish Android performance.

## Linux ARM64

Use a Linux ARM64 system with glibc 2.17 or later. Download the archive and
SHA256SUMS into the same directory, then verify and extract it into a separate
installation directory:

```sh
sha256sum --ignore-missing --check SHA256SUMS
mkdir -p "$HOME/.local/share/side-query-patched-pi"
tar -xzf pi-bolt-1.0.7-native-loader-linux-arm64.tar.gz \
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
runtime from upstream `bolt-v1.0.7`, patches only the copied kit, and builds using
an isolated agent directory without inherited credentials. The compiler runtime
and kit contain the build tools and dependencies; no runtime source compilation
is required.

The empty `native-build-sentinel` factory satisfies the upstream compiler's
requirement for an extension set and has no registrations or actions. It does
not embed side-query. `build-provenance.json` records upstream and extension source
commits, input and output hashes, CPU settings and whether the source checkout
was clean. Binary hashes can differ across rebuilds because the compiler records
temporary paths and build metadata.

The archive retains upstream `LICENSE`, `LICENSE.pi`, and `THIRD_PARTY_NOTICES.md`,
adds `LICENSE.side-query`, the exact loader patch, and `SOURCE.md` with pinned
runtime source and build links. The optional prebuilt DOOM example is omitted
because its matching source and license files are absent from the upstream
archive. All other copied runtime assets remain in place.
