#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const startupFlags = ["--offline", "--no-session", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-tools"];

// Pass execution/runtime plumbing, never inherited provider credentials. Preserve
// Termux's launcher variables and the managed environment's proxy/CA settings.
export function environmentFor(agentDir, temporaryDir, extra = {}) {
  const names = ["PATH", "HOME", "SHELL", "TERM", "COLORTERM", "LANG", "LC_ALL", "TZ", "PREFIX", "TERMUX_VERSION", "TERMUX_APK_RELEASE", "LD_LIBRARY_PATH", "LD_PRELOAD", "GLIBC_LD_PRELOAD", "PIBOLT_TERMUX_LD_PRELOAD", "GLIBC_TUNABLES", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"];
  const env = {};
  for (const name of names) if (process.env[name] !== undefined) env[name] = process.env[name];
  return { ...env, PI_CODING_AGENT_DIR: agentDir, TMPDIR: temporaryDir, PI_OFFLINE: "1", NO_COLOR: "1", ...extra };
}

export async function runBinary(binary, args, { cwd, env, timeout = 15000 }) {
  const started = process.hrtime.bigint();
  return await new Promise((done, reject) => {
    const child = spawn(binary, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [], stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const result = { ms: Number(process.hrtime.bigint() - started) / 1e6, code, signal, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
      if (code !== 0) reject(new Error(`${binary} exited ${code ?? signal}: ${result.stderr.trim()}`));
      else if (/Failed to load extension|Extension error|Error loading extension/i.test(result.stderr)) reject(new Error(result.stderr.trim()));
      else done(result);
    });
  });
}

export async function createFixture(root, name, packages, origin) {
  const base = join(root, name), agentDir = join(base, "agent"), cwd = join(base, "cwd"), temporaryDir = join(base, "tmp");
  await Promise.all([agentDir, cwd, temporaryDir].map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages, defaultProvider: "benchmark", defaultModel: "offline-model" }), { mode: 0o600 });
  await writeFile(join(agentDir, "auth.json"), "{}", { mode: 0o600 });
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { benchmark: { baseUrl: `${origin}/v1`, api: "openai-completions", apiKey: "benchmark-dummy-key", models: [{ id: "offline-model", name: "Offline benchmark", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }] } } }), { mode: 0o600 });
  return { agentDir, cwd, temporaryDir };
}

export async function localRequestCounter() {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    response.writeHead(500, { "content-type": "application/json" }).end('{"error":"Benchmark must not make provider requests"}');
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, requests, close: async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); } };
}

export async function filesBelow(root) {
  const result = [];
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) result.push(...await filesBelow(path));
      else result.push(path);
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return result;
}

export async function stagePackage(source, destination, manifest) {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const files = new Set(["package.json", "index.mjs", "dist", ...(manifest.pi?.extensions ?? [])]);
  for (const file of files) {
    const from = resolve(source, file), to = resolve(destination, file);
    if (!from.startsWith(`${resolve(source)}/`) || !to.startsWith(`${resolve(destination)}/`)) throw new Error("Package entry must stay within its package");
    await mkdir(dirname(to), { recursive: true });
    try { await cp(from, to, { recursive: true, dereference: true }); }
    catch (error) { if (error.code !== "ENOENT" || manifest.pi.extensions.includes(file) || file === "package.json") throw error; }
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function statistics(samples) {
  const sorted = [...samples].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return { count: sorted.length, medianMs: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2, p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], minMs: sorted[0], maxMs: sorted.at(-1) };
}

function options(argv) {
  const result = { binary: "pi-bolt", package: repo, runs: 24, warmup: 2, out: undefined, nativeBinary: undefined, compiledBinary: undefined, keepTemp: false };
  const fields = { "--binary": "binary", "--package": "package", "--runs": "runs", "--warmup": "warmup", "--out": "out", "--native-binary": "nativeBinary", "--compiled-binary": "compiledBinary" };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--keep-temp") { result.keepTemp = true; continue; }
    if (arg === "--help") { console.log("node scripts/benchmark.mjs [--binary pi-bolt] [--native-binary PATH] [--compiled-binary PATH] [--package DIR] [--runs 24] [--warmup 2] [--out results.json] [--keep-temp]"); return; }
    const field = fields[arg];
    if (!field || argv[index + 1] === undefined) throw new Error(`Unknown option or missing value: ${arg}`);
    result[field] = ["runs", "warmup"].includes(field) ? Number(argv[++index]) : argv[++index];
  }
  if (!Number.isInteger(result.runs) || result.runs < 20) throw new Error("--runs must be an integer of at least 20");
  if (!Number.isInteger(result.warmup) || result.warmup < 0) throw new Error("--warmup must be a non-negative integer");
  result.package = resolve(result.package);
  return result;
}

export async function benchmark(argv = process.argv.slice(2)) {
  const opt = options(argv); if (!opt) return;
  const manifest = JSON.parse(await readFile(join(opt.package, "package.json"), "utf8"));
  if (!manifest.pi?.extensions?.length) throw new Error("Package needs its real pi.extensions manifest");
  for (const entry of manifest.pi.extensions) await readFile(resolve(opt.package, entry));
  const root = await mkdtemp(join(tmpdir(), "side-query-benchmark-"));
  const server = await localRequestCounter();
  const stagedPackage = join(root, "package");
  const cases = [
    { name: "stock-baseline", binary: opt.binary, extension: false },
    { name: "stock-extension", binary: opt.binary, extension: true },
    ...(opt.nativeBinary ? [{ name: "native-baseline", binary: opt.nativeBinary, extension: false }, { name: "native-extension", binary: opt.nativeBinary, extension: true }] : []),
    ...(opt.compiledBinary ? [{ name: "compiled-baseline", binary: opt.compiledBinary, extension: false }, { name: "compiled-extension", binary: opt.compiledBinary, extension: true }] : []),
  ];
  try {
    await stagePackage(opt.package, stagedPackage, manifest);
    const packageFiles = {};
    for (const file of (await filesBelow(stagedPackage)).sort()) packageFiles[file.slice(stagedPackage.length + 1)] = await sha256File(file);
    const binaryHashes = {};
    for (const binary of new Set(cases.map(mode => mode.binary))) {
      if (binary.includes("/")) binaryHashes[binary] = await sha256File(resolve(binary));
    }
    const flags = [...startupFlags, "--list-models", "offline-model"];
    const results = [];
    for (const scenario of ["warm", "cold-loader"]) {
      const fixtures = new Map();
      for (const mode of cases) fixtures.set(mode.name, await createFixture(root, `${scenario}-${mode.name}`, mode.extension ? [opt.compiledBinary && mode.name === "compiled-extension" ? opt.package : stagedPackage] : [], server.origin));
      const samples = Object.fromEntries(cases.map(({ name }) => [name, []]));
      for (let round = 0; round < opt.runs + opt.warmup; round++) {
        // Rotate and reverse order to reduce drift favouring any one binary.
        const offset = round % cases.length, order = [...cases.slice(offset), ...cases.slice(0, offset)];
        if (round % 2) order.reverse();
        for (const mode of order) {
          const fixture = fixtures.get(mode.name), cache = join(fixture.temporaryDir, "jiti");
          if (scenario === "cold-loader") await rm(cache, { recursive: true, force: true });
          const env = environmentFor(fixture.agentDir, fixture.temporaryDir, { JITI_FS_CACHE: cache });
          const run = await runBinary(mode.binary, flags, { cwd: fixture.cwd, env });
          if (!run.stdout.includes("offline-model")) throw new Error(`${mode.name} did not list the isolated dummy model: ${run.stdout}\n${run.stderr}`);
          if (server.requests.length) throw new Error(`Unexpected provider traffic: ${JSON.stringify(server.requests)}`);
          samples[mode.name].push({ round, warmup: round < opt.warmup, ms: run.ms });
        }
      }
      for (const mode of cases) {
        const fixture = fixtures.get(mode.name), env = environmentFor(fixture.agentDir, fixture.temporaryDir);
        const version = (await runBinary(mode.binary, ["--version"], { cwd: fixture.cwd, env })).stdout.trim();
        const raw = samples[mode.name];
        results.push({ scenario, mode: mode.name, binary: mode.binary, version, discovery: mode.extension ? "temporary settings.packages -> package.json pi.extensions" : "temporary settings.packages = []", ...statistics(raw.filter(({ warmup }) => !warmup).map(({ ms }) => ms)), raw, jitiCacheFiles: (await filesBelow(join(fixture.temporaryDir, "jiti"))).map((path) => path.slice(fixture.temporaryDir.length + 1)) });
      }
    }
    const output = { measuredAt: new Date().toISOString(), metric: "parent hrtime, spawn to process close, stdout/stderr piped", machine: { platform: platform(), architecture: arch(), kernel: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, benchmarkRuntime: process.version, termuxVersion: process.env.TERMUX_VERSION ?? null, actualAndroidDeviceTested: platform() === "android" || Boolean(process.env.TERMUX_VERSION) }, package: { name: manifest.name, version: manifest.version, entries: manifest.pi.extensions, stagedWithoutNodeModules: true, filesSha256: packageFiles, compiledCaseUsesOriginalPathForFingerprint: Boolean(opt.compiledBinary) }, binaryHashes, flags, runsPerCase: opt.runs, excludedWarmupsPerCase: opt.warmup, coldLoaderDefinition: "jiti filesystem cache directory removed before each process; OS page cache is not flushed", providerRequestCount: server.requests.length, results };
    if (opt.out) await writeFile(resolve(opt.out), `${JSON.stringify(output, null, 2)}\n`);
    for (const result of results) console.log(`${result.scenario.padEnd(12)} ${result.mode.padEnd(20)} median ${result.medianMs.toFixed(2)} ms; p95 ${result.p95Ms.toFixed(2)} ms`);
    console.log(`Provider requests: ${server.requests.length}. ${opt.out ? `Raw results: ${resolve(opt.out)}` : "Use --out to save raw results."}`);
    if (opt.keepTemp) console.log(`Temporary fixtures: ${root}`);
    return output;
  } finally {
    await server.close();
    if (!opt.keepTemp) await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  benchmark().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
