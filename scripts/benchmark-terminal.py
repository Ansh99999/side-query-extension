#!/usr/bin/env python3
"""Measure offline Pi-Bolt interactive startup and child peak RSS through a real PTY.

Requires native PI_STARTUP_BENCHMARK and PI_TTI_TRACE support. No prompt is sent.
First PTY output can be a capability query; it is separate from the native first
frame trace. Process lifetime and peak RSS include the native 150 ms post-init
dwell, shutdown, and any work performed during that dwell. These are instrumented
startup measurements, not a claim that every background service is fully ready.
"""

import argparse
import errno
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import pty
import re
import select
import shutil
import signal
import statistics
import struct
import subprocess
import sys
import tempfile
import termios
import time


REPO = Path(__file__).resolve().parents[1]
FLAGS = ["--offline", "--no-session", "--no-mcp", "--no-skills",
         "--no-prompt-templates", "--no-context-files"]
LOADOUTS = ("baseline", "side", "mixed")
TRACE_LINE = re.compile(r"^pi-tti ([\d.]+) \+(-?[\d.]+) (\S+)(?: (.*))?$")
QUERIES = re.compile(
    rb"\x1b(?:\[(?:[>]?0?c|\?u|[56]n|1[468]t|\?996n|\?2026\$p)"
    rb"|\](?:10;\?|11;\?|4;\d+;\?)(?:\x07|\x1b\\)"
    rb"|_G[^\x1b]*\x1b\\)"
)
ANSI = re.compile(rb"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[=>78]")
PALETTE = ("000000", "cd0000", "00cd00", "cdcd00", "0000ee", "cd00cd", "00cdcd", "e5e5e5",
           "7f7f7f", "ff0000", "00ff00", "ffff00", "5c5cff", "ff00ff", "00ffff", "ffffff")


class BenchmarkError(Exception):
    pass


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_private(path, text):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        stream.write(text)
    path.chmod(0o600)


def stage_package(source, destination):
    manifest = json.loads((source / "package.json").read_text())
    entries = manifest.get("pi", {}).get("extensions", [])
    if not entries or not all(isinstance(entry, str) for entry in entries):
        raise BenchmarkError("--package must contain package.json with nonempty pi.extensions")
    roots = {"package.json", *entries}
    for name in ("index.mjs", "dist"):
        if (source / name).exists():
            roots.add(name)
    destination.mkdir(mode=0o700)
    for name in sorted(roots):
        relative = Path(name)
        if relative.is_absolute() or ".." in relative.parts:
            raise BenchmarkError(f"Package runtime entry escapes its package: {name}")
        original, staged = source / relative, destination / relative
        if not original.exists():
            raise BenchmarkError(f"Missing built package runtime entry: {original}")
        for candidate in [original, *original.rglob("*")] if original.is_dir() else [original]:
            if candidate.is_symlink():
                raise BenchmarkError(f"Use a built package with no runtime symlinks: {candidate}")
        staged.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if original.is_dir():
            shutil.copytree(original, staged, dirs_exist_ok=True,
                            ignore=shutil.ignore_patterns("node_modules", ".git", "__pycache__"))
        else:
            shutil.copyfile(original, staged)
    files = {str(path.relative_to(destination)): sha256(path)
             for path in sorted(destination.rglob("*")) if path.is_file()}
    return {"name": manifest.get("name"), "version": manifest.get("version"),
            "extensions": entries, "stagedWithoutNodeModules": True, "filesSha256": files}


class Fixture:
    def __init__(self, root, packages):
        self.root, self.agent, self.cwd = root, root / "agent", root / "cwd"
        self.temporary, self.home = root / "tmp", root / "home"
        for path in (self.agent, self.cwd, self.temporary, self.home):
            path.mkdir(parents=True, mode=0o700)
        self.seed = {
            "settings.json": {"packages": packages, "defaultProvider": "benchmark",
                              "defaultModel": "offline-model", "quietStartup": True,
                              "lastChangelogVersion": "9999.0.0", "cacheWarming": "off"},
            "auth.json": {},
            "models.json": {"providers": {"benchmark": {
                "baseUrl": "http://127.0.0.1:9/v1", "api": "openai-completions",
                "apiKey": "unused-benchmark-dummy-key", "models": [{
                    "id": "offline-model", "name": "Offline benchmark", "reasoning": False,
                    "input": ["text"], "contextWindow": 8192, "maxTokens": 1024,
                    "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                }],
            }}},
        }
        self.reset()

    def reset(self):
        for name, value in self.seed.items():
            write_private(self.agent / name, json.dumps(value, sort_keys=True) + "\n")

    def environment(self):
        # Execution plumbing only; never pass provider credentials from the caller.
        names = ("PATH", "SHELL", "LANG", "LC_ALL", "TZ", "PREFIX", "TERMUX_VERSION",
                 "TERMUX_APK_RELEASE", "LD_LIBRARY_PATH", "LD_PRELOAD", "GLIBC_LD_PRELOAD",
                 "PIBOLT_TERMUX_LD_PRELOAD", "GLIBC_TUNABLES", "HTTP_PROXY", "HTTPS_PROXY",
                 "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
                 "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS")
        env = {name: os.environ[name] for name in names if name in os.environ}
        env.update({"HOME": str(self.home), "XDG_CONFIG_HOME": str(self.home / ".config"),
                    "XDG_CACHE_HOME": str(self.home / ".cache"), "PI_CODING_AGENT_DIR": str(self.agent),
                    "TMPDIR": str(self.temporary), "JITI_FS_CACHE": str(self.temporary / "jiti"),
                    "PI_OFFLINE": "1", "PI_TELEMETRY": "0", "TERM": "xterm-256color",
                    "COLORTERM": "truecolor", "PI_PROGRAM_STATUS": "0",
                    "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull})
        return env


class TerminalQueries:
    def __init__(self, rows, columns):
        self.rows, self.columns, self.pending, self.counts = rows, columns, b"", {}

    def feed(self, data):
        self.pending += data
        responses, end = [], 0
        for match in QUERIES.finditer(self.pending):
            query = match.group()
            response = self.reply(query)
            if response:
                responses.append(response)
                key = query.decode("ascii", "backslashreplace")
                self.counts[key] = self.counts.get(key, 0) + 1
            end = match.end()
        self.pending = self.pending[end:][-8192:]
        return b"".join(responses)

    def reply(self, query):
        if query in (b"\x1b[c", b"\x1b[0c"):
            return b"\x1b[?62;22c"
        if query in (b"\x1b[>c", b"\x1b[>0c"):
            return b"\x1b[>0;136;0c"
        if query == b"\x1b[?u":
            return b"\x1b[?0u"  # Same modifyOtherKeys fallback as the xterm smoke fixture.
        if query == b"\x1b[6n":
            return b"\x1b[1;1R"
        if query == b"\x1b[5n":
            return b"\x1b[0n"
        if query == b"\x1b[18t":
            return f"\x1b[8;{self.rows};{self.columns}t".encode()
        if query == b"\x1b[14t":
            return f"\x1b[4;{self.rows * 20};{self.columns * 10}t".encode()
        if query == b"\x1b[16t":
            return b"\x1b[6;20;10t"
        if query == b"\x1b[?996n":
            return b"\x1b[?997;1n"
        if query == b"\x1b[?2026$p":
            return b"\x1b[?2026;2$y"
        if query.startswith(b"\x1b]"):
            parts = query[2:].rstrip(b"\x07").removesuffix(b"\x1b\\").split(b";")
            if parts[0] == b"10":
                prefix, color = b"10", "cccccc"
            elif parts[0] == b"11":
                prefix, color = b"11", "000000"
            else:
                index = int(parts[1])
                if not 0 <= index < len(PALETTE):
                    return b""
                prefix, color = b"4;" + parts[1], PALETTE[index]
            channels = [f"{int(color[index:index + 2], 16) * 257:04x}" for index in (0, 2, 4)]
            return b"\x1b]" + prefix + b";rgb:" + "/".join(channels).encode() + b"\x1b\\"
        if query.startswith(b"\x1b_G") and b"a=q" in query.split(b";", 1)[0]:
            identifier = re.search(rb"(?:^|,)i=(\d+)", query[3:].split(b";", 1)[0])
            return b"\x1b_Gi=" + (identifier.group(1) if identifier else b"31") + b";ENOTSUP\x1b\\"
        return b""


def memory_fields(path, keys):
    try:
        text = path.read_text()
    except OSError:
        return {}
    fields = {}
    for line in text.splitlines():
        name, _, value = line.partition(":")
        if name in keys:
            parts = value.split()
            if parts and parts[0].isdigit():
                fields[name + "KiB"] = int(parts[0])
    return fields


def trace_events(path):
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return []
    events = []
    for line in lines:
        match = TRACE_LINE.match(line)
        if match:
            events.append({"runtimeMs": float(match[1]), "deltaMs": float(match[2]),
                           "event": match[3], "detail": match[4] or ""})
    return events


def trace_times(events, parent_wall_ms):
    origin = next((event for event in events if event["event"] == "runtime.start"), None)
    frame = next((event for event in events if event["event"] == "frame.written" and event["detail"] == "1"), None)
    done = next((event for event in events if event["event"] == "startup.done"), None)
    if not all((origin, frame, done)):
        missing = [name for name, value in (("runtime.start", origin), ("frame.written 1", frame), ("startup.done", done)) if value is None]
        raise BenchmarkError("Native PI_TTI_TRACE is unsupported or incomplete; missing " + ", ".join(missing))
    try:
        epoch_ms = float(origin["detail"])
    except ValueError as error:
        raise BenchmarkError("Native runtime.start did not provide its epoch timestamp") from error
    if not math.isfinite(epoch_ms):
        raise BenchmarkError("Native runtime.start epoch is not finite")
    offset = epoch_ms - parent_wall_ms
    return {"runtimeEpochMs": epoch_ms, "runtimeStartFromParentMs": offset,
            "firstFrameRuntimeMs": frame["runtimeMs"], "startupDoneRuntimeMs": done["runtimeMs"],
            "firstFrameMs": offset + frame["runtimeMs"], "startupDoneMs": offset + done["runtimeMs"]}


def run_sample(case, loadout, fixture, round_number, warmup, order, options):
    fixture.reset()
    trace = fixture.temporary / f"trace-{round_number:04d}.log"
    stderr = fixture.temporary / f"stderr-{round_number:04d}.log"
    trace.unlink(missing_ok=True)
    write_private(stderr, "")
    env = fixture.environment()
    env.update({"PI_STARTUP_BENCHMARK": "1", "PI_TTI_TRACE": str(trace)})
    responder = TerminalQueries(options.rows, options.columns)
    parent_wall_ms, start = time.time_ns() / 1e6, time.perf_counter_ns()
    pid, master = pty.fork()
    if pid == 0:
        try:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", options.rows, options.columns, 0, 0))
            os.chdir(fixture.cwd)
            error_fd = os.open(stderr, os.O_WRONLY | os.O_TRUNC, 0o600)
            os.dup2(error_fd, 2)
            if error_fd != 2:
                os.close(error_fd)
            os.execve(case["binary"], [case["binary"], *FLAGS], env)
        except BaseException as error:
            os.write(2, f"Benchmark child exec failed: {error}\n".encode())
            os._exit(127)
    os.set_blocking(master, False)
    first_output, byte_count, proc_samples, hwm = None, 0, 0, 0
    ready_memory, tail, usage, status, closed = None, b"", None, None, False
    outgoing, terminal_hash = b"", hashlib.sha256()
    timed_out = False
    try:
        while status is None:
            elapsed = (time.perf_counter_ns() - start) / 1e9
            if elapsed > options.timeout:
                timed_out = True
                os.killpg(pid, signal.SIGKILL)
                _, status, usage = os.wait4(pid, 0)
                break
            fields = memory_fields(Path(f"/proc/{pid}/status"), ("VmRSS", "VmHWM", "RssAnon", "RssFile", "RssShmem"))
            if fields:
                proc_samples += 1
                hwm = max(hwm, fields.get("VmHWMKiB", 0))
            if ready_memory is None and trace.exists():
                events = trace_events(trace)
                if any(event["event"] == "startup.done" for event in events):
                    timing = trace_times(events, parent_wall_ms)
                    ready_memory = {**fields, **memory_fields(Path(f"/proc/{pid}/smaps_rollup"),
                        ("Rss", "Pss", "Pss_Anon", "Pss_File", "Pss_Shmem", "Anonymous")),
                        "observedAtMs": (time.perf_counter_ns() - start) / 1e6,
                        "delayFromStartupDoneMs": time.time_ns() / 1e6 - timing["runtimeEpochMs"] - timing["startupDoneRuntimeMs"]}
            readable, writable, _ = select.select([] if closed else [master], [master] if outgoing and not closed else [], [], options.poll_ms / 1000)
            if writable:
                try:
                    outgoing = outgoing[os.write(master, outgoing):]
                except OSError as error:
                    if error.errno not in (errno.EIO, errno.EAGAIN):
                        raise
            if readable:
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        data = b""
                    elif error.errno == errno.EAGAIN:
                        data = None
                    else:
                        raise
                if data:
                    if first_output is None:
                        first_output = (time.perf_counter_ns() - start) / 1e6
                    byte_count += len(data)
                    terminal_hash.update(data)
                    tail = (tail + data)[-16384:]
                    outgoing += responder.feed(data)
                    if outgoing:
                        try:
                            outgoing = outgoing[os.write(master, outgoing):]
                        except OSError as error:
                            if error.errno not in (errno.EIO, errno.EAGAIN):
                                raise
                elif data == b"":
                    closed = True
            waited, child_status, child_usage = os.wait4(pid, os.WNOHANG)
            if waited:
                status, usage = child_status, child_usage
        lifetime = (time.perf_counter_ns() - start) / 1e6
    finally:
        if status is None:
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            _, status, usage = os.wait4(pid, 0)
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.close(master)
    error_text = stderr.read_text(errors="replace")[-12000:]
    context = f"{case['name']}/{loadout}, round {round_number}"
    if timed_out:
        raise BenchmarkError(f"{context}: native startup benchmark did not exit within {options.timeout}s; PI_STARTUP_BENCHMARK may be unsupported")
    exit_code = os.waitstatus_to_exitcode(status)
    if exit_code != 0:
        raise BenchmarkError(f"{context}: binary exited {exit_code}: {error_text.strip()}")
    if re.search(r"Failed to load extension|Extension error|Error loading extension", error_text, re.I):
        raise BenchmarkError(f"{context}: {error_text.strip()}")
    if first_output is None:
        raise BenchmarkError(f"{context}: no PTY output was observed")
    terminal_text = ANSI.sub(b"", tail).decode("utf-8", "replace")
    if "offline-model" not in terminal_text:
        raise BenchmarkError(f"{context}: isolated offline model was not shown in the interactive terminal: {terminal_text[-2000:]}")
    events = trace_events(trace)
    try:
        timing = trace_times(events, parent_wall_ms)
    except BenchmarkError as error:
        raise BenchmarkError(f"{context}: {error}; stderr: {error_text.strip()}") from error
    rss = float(usage.ru_maxrss) / (1024 if sys.platform == "darwin" else 1)
    return {"case": case["name"], "loadout": loadout, "round": round_number,
            "warmup": warmup, "order": order, "parentWallStartMs": parent_wall_ms,
            "firstTerminalOutputMs": first_output, **timing, "lifetimeMs": lifetime,
            "peakRssKiB": max(rss, hwm), "wait4PeakRssKiB": rss,
            "sampledVmHwmKiB": hwm or None, "procSamples": proc_samples,
            "startupMemory": ready_memory, "userCpuSeconds": usage.ru_utime,
            "systemCpuSeconds": usage.ru_stime, "terminalOutputBytes": byte_count,
            "terminalOutputSha256": terminal_hash.hexdigest(), "terminalQueries": responder.counts,
            "trace": events, "stderr": error_text or None}


def describe_machine():
    cpu = platform.processor()
    try:
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            name, _, value = line.partition(":")
            if name.strip() in ("model name", "Model", "Hardware"):
                cpu = value.strip()
                break
    except OSError:
        pass
    return {"system": platform.system(), "architecture": platform.machine(),
            "kernel": platform.release(), "cpu": cpu or platform.machine(),
            "logicalCpus": os.cpu_count(), "python": sys.version.split()[0],
            "loadAverage": list(os.getloadavg()), "termuxVersion": os.environ.get("TERMUX_VERSION"),
            "actualAndroidDeviceTested": "TERMUX_VERSION" in os.environ or sys.platform == "android"}


def distribution(values):
    values = sorted(values)
    return {"count": len(values), "median": statistics.median(values),
            "min": values[0], "max": values[-1], "p95": values[math.ceil(len(values) * .95) - 1]}


def summaries(samples, cases, loadouts):
    result = []
    for loadout in loadouts:
        for case in cases:
            raw = [sample for sample in samples if sample["case"] == case["name"] and sample["loadout"] == loadout and not sample["warmup"]]
            if not raw:
                continue
            metrics = {key: distribution([sample[key] for sample in raw]) for key in
                       ("firstTerminalOutputMs", "firstFrameMs", "startupDoneMs", "lifetimeMs", "peakRssKiB")}
            result.append({"case": case["name"], "loadout": loadout, "metrics": metrics})
    return result


def save_report(path, report):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    write_private(temporary, json.dumps(report, indent=2) + "\n")
    temporary.replace(path)


def options(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--case", action="append", required=True, metavar="NAME=/ABS/BINARY")
    parser.add_argument("--package", type=Path, default=REPO, help="built side-query package; default: this repository")
    parser.add_argument("--runs", type=int, default=16)
    parser.add_argument("--warmups", type=int, default=2)
    parser.add_argument("--loadout", action="append", choices=[*LOADOUTS, "all"], help="repeat to select loadouts; default: all three")
    parser.add_argument("--out", type=Path, default=Path("benchmark-terminal.json"))
    parser.add_argument("--timeout", type=float, default=15, help="seconds per native startup process")
    parser.add_argument("--poll-ms", type=float, default=2, help="PTY/proc sampling interval; overhead applies equally to cases")
    parser.add_argument("--rows", type=int, default=32)
    parser.add_argument("--columns", type=int, default=92)
    opt = parser.parse_args(argv)
    if opt.runs < 1 or opt.warmups < 0 or opt.timeout <= 0 or opt.poll_ms <= 0 or opt.rows < 4 or opt.columns < 16:
        parser.error("runs >= 1, warmups >= 0, timeout/poll-ms > 0, rows >= 4, columns >= 16 are required")
    cases = []
    for value in opt.case:
        name, separator, binary = value.partition("=")
        path = Path(binary)
        if not separator or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}", name) or not path.is_absolute():
            parser.error("each --case must be NAME=/absolute/executable with a simple unique name")
        if any(case["name"] == name for case in cases):
            parser.error(f"duplicate case name: {name}")
        if not path.is_file() or not os.access(path, os.X_OK):
            parser.error(f"binary is missing or not executable: {path}")
        cases.append({"name": name, "binary": str(path.resolve())})
    opt.package, opt.out = opt.package.resolve(), opt.out.resolve()
    opt.loadouts = list(dict.fromkeys(LOADOUTS if not opt.loadout or "all" in opt.loadout else opt.loadout))
    return opt, cases


def main(argv=None):
    if not hasattr(os, "wait4") or not hasattr(pty, "fork"):
        raise BenchmarkError("This benchmark requires a Unix PTY and os.wait4; Windows is unsupported")
    opt, cases = options(argv)
    report = {"schemaVersion": 1, "complete": False, "measuredAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "machine": describe_machine(), "flags": FLAGS, "runsPerCaseAndLoadout": opt.runs,
              "excludedWarmupsPerCaseAndLoadout": opt.warmups, "pollIntervalMs": opt.poll_ms,
              "terminal": {"rows": opt.rows, "columns": opt.columns, "term": "xterm-256color",
                           "cellPixels": [10, 20], "kittyKeyboardFlags": 0, "kittyGraphics": False},
              "method": {"firstTerminalOutputMs": "parent perf_counter from PTY fork to first master read; may be a capability query",
                         "firstFrameMs": "native runtime.start epoch minus parent wall start plus first frame.written 1 runtime offset",
                         "startupDoneMs": "same epoch alignment for native startup.done; not a fully-ready guarantee",
                         "peakRssKiB": "max sampled /proc child VmHWM and wait4 ru_maxrss; Darwin bytes normalized to KiB",
                         "startupMemory": "best-effort /proc status and smaps_rollup after observing startup.done; includes recorded observation delay",
                         "lifetimeMs": "fork to wait4; includes native 150 ms post-init dwell and shutdown",
                         "overhead": "native trace file appends, PTY query replies, periodic proc/trace reads, one smaps_rollup snapshot, pre-exec PTY handoff",
                         "cache": "case/loadout fixtures keep their own JITI_FS_CACHE across warmups and measured runs; OS page cache is not flushed",
                         "order": "rotate and reverse case/loadout combinations every round; run processes serially"},
              "isolation": {"generatedAgentSettingsAndAuth": True, "inheritedProviderCredentials": False,
                            "promptSent": False, "offlineFlags": True, "cacheWarming": "off",
                            "providerRequestCounter": "not instrumented; no server or prompts are used",
                            "dummyEndpoint": "http://127.0.0.1:9/v1"}, "cases": cases, "samples": []}
    with tempfile.TemporaryDirectory(prefix="side-query-pty-benchmark-") as temporary:
        root = Path(temporary)
        package, fixture_package = root / "package", root / "typescript-fixture"
        report["package"] = stage_package(opt.package, package)
        fixture_package.mkdir(mode=0o700)
        write_private(fixture_package / "package.json", json.dumps({"name": "side-query-pty-inert-fixture", "type": "module", "pi": {"extensions": ["./index.ts"]}}))
        write_private(fixture_package / "index.ts", 'export default function fixture(pi: { registerCommand(name: string, options: { description: string; handler(): void }): void }) {\n  pi.registerCommand("benchmark-fixture", { description: "Inert benchmark fixture", handler() {} });\n}\n')
        report["mixedFixtureSha256"] = sha256(fixture_package / "index.ts")
        packages = {"baseline": [], "side": [str(package)], "mixed": [str(package), str(fixture_package)]}
        fixtures = {}
        for index, case in enumerate(cases):
            for number, loadout in enumerate(opt.loadouts):
                fixtures[(case["name"], loadout)] = Fixture(root / f"fixture-{index:02d}-{number:02d}", packages[loadout])
        for case in cases:
            fixture = fixtures[(case["name"], opt.loadouts[0])]
            version = subprocess.run([case["binary"], "--version"], cwd=fixture.cwd, env=fixture.environment(),
                                     stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=opt.timeout)
            if version.returncode:
                raise BenchmarkError(f"{case['name']}: --version exited {version.returncode}: {version.stderr.strip()}")
            case.update({"version": version.stdout.strip(), "sha256": sha256(Path(case["binary"])),
                         "sizeBytes": Path(case["binary"]).stat().st_size})
        combinations = [(case, loadout) for loadout in opt.loadouts for case in cases]
        try:
            for round_number in range(opt.warmups + opt.runs):
                offset = round_number % len(combinations)
                ordered = combinations[offset:] + combinations[:offset]
                if round_number % 2:
                    ordered.reverse()
                for order, (case, loadout) in enumerate(ordered):
                    report["samples"].append(run_sample(case, loadout, fixtures[(case["name"], loadout)],
                        round_number, round_number < opt.warmups, order, opt))
                print(f"Completed {'warmup' if round_number < opt.warmups else 'measured'} round {round_number + 1}/{opt.warmups + opt.runs}", flush=True)
            report["complete"] = True
        except (BenchmarkError, OSError, KeyboardInterrupt) as error:
            report["error"] = str(error) or "Interrupted"
            raise
        finally:
            report["results"] = summaries(report["samples"], cases, opt.loadouts)
            save_report(opt.out, report)
        for result in report["results"]:
            metric = result["metrics"]
            print(f"{result['loadout']:8} {result['case']:18} first-output {metric['firstTerminalOutputMs']['median']:.2f} ms; "
                  f"native first-frame {metric['firstFrameMs']['median']:.2f} ms; startup.done {metric['startupDoneMs']['median']:.2f} ms; "
                  f"peak RSS {metric['peakRssKiB']['median'] / 1024:.2f} MiB")
        print(f"Raw samples and metadata: {opt.out}")
        return report


if __name__ == "__main__":
    try:
        main()
    except (BenchmarkError, OSError, subprocess.TimeoutExpired, KeyboardInterrupt) as error:
        print(f"Benchmark failed: {error or 'Interrupted'}", file=sys.stderr)
        sys.exit(1)
