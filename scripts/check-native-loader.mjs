#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFixture, environmentFor, filesBelow, localRequestCounter, runBinary, stagePackage, startupFlags } from "./benchmark.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
let binary = "pi-bolt", packageDir = repo, native = true;
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--binary") binary = args[++index];
  else if (args[index] === "--package") packageDir = resolve(args[++index]);
  else if (args[index] === "--allow-jiti") native = false;
  else if (args[index] === "--help") { console.log("node scripts/check-native-loader.mjs --binary PATH [--package DIR] [--allow-jiti]"); process.exit(0); }
  else throw new Error(`Unknown option: ${args[index]}`);
}

const root = await mkdtemp(join(tmpdir(), "side-query-native-proof-"));
const server = await localRequestCounter();
try {
  const probe = join(root, "probe");
  await mkdir(probe);
  await writeFile(join(probe, "package.json"), JSON.stringify({ name: "native-loader-probe", type: "module", pi: { extensions: ["./index.mjs"] } }));
  await writeFile(join(probe, "index.mjs"), `
import {} from "typebox";
globalThis.__nativeProbeEntries = (globalThis.__nativeProbeEntries ?? 0) + 1;
export default function (pi) {
  pi.registerFlag("native-loader-startup-proof", { type: "boolean", description: "Native entry factory registration proof" });
  pi.registerCommand("native-loader-proof", { handler: async (_args, ctx) => {
    const { prove } = await import("./core.mjs");
    console.log("native-loader-proof " + JSON.stringify(prove(ctx)));
  }});
  pi.registerCommand("native-loader-reload", { handler: async (_args, ctx) => { console.log("native-loader-reload start"); await ctx.reload(); console.log("native-loader-reload done"); }});
}
`);
  await writeFile(join(probe, "core.mjs"), `
import { appendFileSync } from "node:fs";
import { Input, Text } from "@earendil-works/pi-tui";
import { Input as LegacyInput } from "@mariozechner/pi-tui";
import { Agent } from "@earendil-works/pi-agent-core";
import { Agent as LegacyAgent } from "@mariozechner/pi-agent-core";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { complete } from "@earendil-works/pi-ai/compat";
globalThis.__nativeProbeCores = (globalThis.__nativeProbeCores ?? 0) + 1;
appendFileSync(process.env.PI_NATIVE_PROOF_FILE, "core imported\\n");
export function prove(ctx) {
  const input = new Input(), text = new Text("native component", 0, 0);
  return { entries: globalThis.__nativeProbeEntries, cores: globalThis.__nativeProbeCores,
    sameInput: Input === LegacyInput, sameAgent: Agent === LegacyAgent,
    nativeInput: input instanceof Input, renderedText: text.render(30).join("\\n").includes("native component"),
    agentDirMatches: getAgentDir() === process.env.PI_CODING_AGENT_DIR,
    modelRegistry: ctx.modelRegistry.getAll().some(model => model.id === "offline-model"),
    completionFunction: typeof complete === "function" };
}
`);
  const fixture = await createFixture(root, "native", [probe], server.origin);
  const cache = join(fixture.temporaryDir, "jiti"), marker = join(root, "core-loaded.txt");
  const env = environmentFor(fixture.agentDir, fixture.temporaryDir, { JITI_FS_CACHE: cache, JITI_DEBUG: "1", PI_NATIVE_PROOF_FILE: marker });
  const startup = await runBinary(binary, [...startupFlags, "--help"], { cwd: fixture.cwd, env });
  assert.ok(startup.stdout.includes("--native-loader-startup-proof"), "Factory must register its flag through real package discovery");
  assert.equal((await filesBelow(root)).includes(marker), false, "Core must remain unloaded at startup");
  if (native) {
    assert.equal((await filesBelow(cache)).length, 0, "Native first load must not create a jiti cache");
    assert.ok(!`${startup.stdout}${startup.stderr}`.includes("[jiti]"), "Native first load must not execute jiti");
  }
  console.log("PASS manifest discovery, factory registration, and lazy core at startup");
  await rm(cache, { recursive: true, force: true });
  const execution = await runBinary(binary, [...startupFlags, "-p", "/native-loader-proof", "/native-loader-reload", "/native-loader-proof"], { cwd: fixture.cwd, env });
  const reports = execution.stdout.split("\n").filter(line => line.startsWith("native-loader-proof ")).map(line => JSON.parse(line.slice("native-loader-proof ".length)));
  assert.equal(reports.length, 2, `Both registered command runs must complete: ${execution.stdout}\n${execution.stderr}`);
  for (const report of reports) for (const [field, value] of Object.entries(report)) if (!["entries", "cores"].includes(field)) assert.equal(value, true, field);
  assert.equal(reports[0].entries, 1); assert.equal(reports[0].cores, 1);
  if (!native) {
    assert.equal(reports[1].entries, 2); assert.equal(reports[1].cores, 2);
    assert.equal((await readFile(marker, "utf8")).trim().split("\n").length, 2);
    assert.ok((await filesBelow(cache)).length > 0, "Stock fallback must transform ESM without installed SDK dependencies");
  } else {
    assert.ok(`${execution.stdout}${execution.stderr}`.includes("[jiti] [init]"), "Explicit reload must return to the stock jiti loader");
  }
  console.log("PASS lazy SDK imports, native component rendering, alias identity, and command registration after reload");

  const failure = join(root, "failure"); await mkdir(failure);
  const failureMarker = join(root, "failure-count.txt");
  await writeFile(join(failure, "package.json"), JSON.stringify({ name: "native-failure-probe", type: "module", pi: { extensions: ["./index.mjs"] } }));
  await writeFile(join(failure, "index.mjs"), `import { appendFileSync } from "node:fs"; appendFileSync(process.env.PI_NATIVE_FAILURE_FILE, "evaluated\\n"); throw new Error("native failure proof"); export default function () {}`);
  const failedFixture = await createFixture(root, "failure-case", [failure], server.origin);
  let failed = false;
  try { await runBinary(binary, [...startupFlags, "--help"], { cwd: failedFixture.cwd, env: environmentFor(failedFixture.agentDir, failedFixture.temporaryDir, { PI_NATIVE_FAILURE_FILE: failureMarker }) }); }
  catch (error) { failed = /native failure proof/.test(error.message); }
  assert.equal(failed, true, "Failed native entry must reach the extension error boundary");
  if (native) assert.equal((await readFile(failureMarker, "utf8")).trim().split("\n").length, 1, "Native failure must evaluate top-level side effects once");
  console.log(`PASS import failure is reported${native ? " without duplicate evaluation" : " by stock loader"}`);

  const driver = join(root, "registration"); await mkdir(driver);
  await writeFile(join(driver, "package.json"), JSON.stringify({ name: "side-query-registration-probe", type: "module", pi: { extensions: ["./index.mjs"] } }));
  await writeFile(join(driver, "index.mjs"), `export default function (pi) { pi.registerCommand("side-query-registration-proof", { handler: async () => { const commands = pi.getCommands(); if (!commands.some(command => command.name === "btw")) throw new Error("/btw was not registered"); console.log("side-query-registration-proof /btw registered"); }}); }`);
  const actualPackage = join(root, "actual-package");
  await stagePackage(packageDir, actualPackage, JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")));
  const actual = await createFixture(root, "actual-extension", [actualPackage, driver], server.origin);
  const registered = await runBinary(binary, [...startupFlags, "-p", "/side-query-registration-proof"], { cwd: actual.cwd, env: environmentFor(actual.agentDir, actual.temporaryDir) });
  assert.ok(registered.stdout.includes("side-query-registration-proof /btw registered"));
  assert.equal(server.requests.length, 0, "Neither startup nor SDK/command proof may call the dummy provider");
  console.log("PASS actual side-query package registers /btw; zero provider requests across all checks");
} catch (error) {
  console.error(error.stack); process.exitCode = 1;
} finally {
  await server.close(); await rm(root, { recursive: true, force: true });
}
