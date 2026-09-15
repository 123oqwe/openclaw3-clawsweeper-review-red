import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { closeDecision, item } from "./helpers.ts";
import { writeFakeScanner } from "./agent-input-scan-helpers.ts";

// R05-A: actual runCodexForTest -> runCodex -> runAgentProcess ->
// runCodexProcess -> spawnCodex. Only the external provider and scanner are fixtures.
// This proves process-boundary behavior, not job isolation or real model inference.
const forbidden = {
  GH_TOKEN: "oc3-r05-forbidden-gh-7d923a",
  GITHUB_TOKEN: "oc3-r05-forbidden-github-083dea",
  REPO_TOKEN: "oc3-r05-forbidden-repo-c19afd",
  CLAWSWEEPER_APP_PRIVATE_KEY: "oc3-r05-forbidden-app-key-945cba",
  CLAWSWEEPER_WEBHOOK_SECRET: "oc3-r05-forbidden-webhook-270ecd",
};
const inspectionToken = "oc3-r05-readonly-inspection-6ab384";
const prompt = "Return a keep_open review decision for this synthetic checkout.";
const trackedContent = "tracked checkout content\n";
const trackedFingerprint = "8b9382c9009cdc46cb69d59eb0078522d45023b2";
type Observation = {
  phase: string;
  pid: number;
  schemaArgument: boolean;
  promptReceived: boolean;
  inspectionAsGh: boolean;
  originalInspectionPresent: boolean;
  forbidden: Record<string, { env: boolean; argv: boolean; stdin: boolean }>;
};

function generatedFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const file = join(directory, name);
    const stat = lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false, "generated review artifacts must not redirect inspection");
    return stat.isDirectory() ? generatedFiles(file) : [file];
  });
}

function exercise(injectCanaries: boolean) {
  const root = mkdtempSync(join(tmpdir(), "oc3-r05-model-env-"));
  const target = join(root, "target");
  const work = join(root, "work");
  const bin = join(root, "bin");
  const home = join(root, "home");
  const codexHome = join(root, "codex-home");
  const temp = join(root, "tmp");
  const trace = join(root, "provider.jsonl");
  const resultPath = join(root, "result.json");
  const errorPath = join(root, "error.json");
  const inputsPath = join(root, "input-presence.json");
  const decision = closeDecision({
    decision: "keep_open", closeReason: "none", confidence: "medium",
    summary: "Keep open for maintainer follow-up.", bestSolution: "Review the routing invariant.",
    closeComment: "", workReason: "Maintainer review is required.",
  });
  try {
    for (const directory of [target, work, bin, home, codexHome, temp]) mkdirSync(directory);
    writeFileSync(trace, "");
    writeFakeScanner(bin);
    const env: NodeJS.ProcessEnv = {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      HOME: home, XDG_CONFIG_HOME: home, CODEX_HOME: codexHome, TMPDIR: temp,
      GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
      CLAWSWEEPER_RUNNER: "codex", CLAWSWEEPER_CODEX_LOGIN_METHOD: "api",
      CODEX_BIN: join(bin, "codex"),
      ...(injectCanaries ? { ...forbidden, CLAWSWEEPER_PROOF_INSPECTION_TOKEN: inspectionToken } : {}),
    };
    // Same tracked checkout/scanner fixture as codex-review-runner.test.ts.
    // Explicit child env avoids inheriting credentials, Git config or test runner hooks.
    const git = (...args: string[]) => execFileSync("git", args, { cwd: target, env, encoding: "utf8" });
    git("init", "-q");
    writeFileSync(join(target, "tracked.txt"), trackedContent);
    git("add", "tracked.txt");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
    const head = git("rev-parse", "HEAD").trim();
    writeFileSync(join(bin, "codex"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const input = fs.readFileSync(0, "utf8");
const expected = ${JSON.stringify(forbidden)};
const environment = JSON.stringify(process.env);
const argumentText = JSON.stringify(args);
const presence = Object.fromEntries(Object.entries(expected).map(([name, value]) => [name, {
  env: environment.includes(value), argv: argumentText.includes(value), stdin: input.includes(value),
}]));
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({
  phase: args[0] || "missing", pid: process.pid,
  schemaArgument: args.includes("--output-schema"),
  promptReceived: input === ${JSON.stringify(prompt)},
  inspectionAsGh: process.env.GH_TOKEN === ${JSON.stringify(inspectionToken)},
  originalInspectionPresent: Object.hasOwn(process.env, "CLAWSEEPER_PROOF_INSPECTION_TOKEN"),
  forbidden: presence,
}) + "\\n");
if (args[0] === "sandbox") {
  process.stdout.write(${JSON.stringify(trackedFingerprint)} + "\\n");
} else if (args[0] === "exec" && !args.includes("--output-last-message")) {
  // Existing managed-result fixture: actual worker captures stdout into its result file.
  process.stdout.write(${JSON.stringify(JSON.stringify(decision))} + "\\n");
} else {
  process.stderr.write("unexpected synthetic provider invocation\\n");
  process.exitCode = 97;
}
`, { mode: 0o755 });
    const runner = join(root, "runner.mjs");
    const options = {
      item: item({ number: 83395 }), context: { issue: {}, comments: [], timeline: [] },
      git: { mainSha: head, latestRelease: null }, model: "model-test", openclawDir: target,
      reasoningEffort: "high", sandboxMode: "clawsweeper-review", serviceTier: "",
      preserveCodexAuth: false, timeoutMs: 10_000, workDir: work, prompt,
      resultFileBytes: 4 * 1024 * 1024,
    };
    writeFileSync(runner, `import fs from "node:fs";
const expected = ${JSON.stringify(forbidden)};
const presence = () => Object.fromEntries(Object.entries(expected).map(([name, value]) => [name, process.env[name] === value]));
const before = presence();
try {
  const { runCodexForTest } = await import(${JSON.stringify(pathToFileURL(resolve("dist/clawsweeper.js")).href)});
  const result = runCodexForTest(${JSON.stringify(options)});
  fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result));
  fs.writeFileSync(${JSON.stringify(inputsPath)}, JSON.stringify({ before, after: presence() }));
} catch (error) {
  fs.writeFileSync(${JSON.stringify(errorPath)}, JSON.stringify({
    name: error?.name, message: error?.message, stack: error?.stack,
    stdout: error?.stdout, stderr: error?.stderr, diagnostic: error?.diagnostic,
  }));
  process.exitCode = 1;
}
`);
    // Separate process supplies a complete whitelist, so the parent process.env
    // is never changed and no real account secret or NODE_OPTIONS is inherited.
    const execution = spawnSync(process.execPath, [runner], {
      cwd: process.cwd(), env, encoding: "utf8", timeout: 25_000, maxBuffer: 8 * 1024 * 1024,
    });
    const visible = [execution.stdout ?? "", execution.stderr ?? "", execution.error?.message ?? ""];
    for (const file of [...generatedFiles(work), trace, inputsPath, resultPath, errorPath]) {
      if (existsSync(file)) visible.push(readFileSync(file, "utf8"));
    }
    for (const [name, value] of Object.entries(forbidden)) {
      assert.equal(visible.some((text) => text.includes(value)), false, `forbidden ${name} in actual output/error/generated artifact`);
    }
    const diagnostic = Object.values(forbidden).reduce((text, value) => text.replaceAll(value, "[SYNTHETIC_CANARY]"),
      existsSync(errorPath) ? readFileSync(errorPath, "utf8") : `${execution.stderr ?? ""} ${execution.error?.message ?? ""}`);
    assert.equal(execution.error, undefined, `real runner must finish before the hard deadline: ${diagnostic}`);
    assert.equal(execution.status, 0, `real runner must return a valid decision, not an arbitrary failure: ${diagnostic}`);
    assert.equal(existsSync(errorPath), false, "real runner must not report an exception");
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    assert.equal(result.decision, "keep_open");
    assert.equal(result.closeReason, "none");
    assert.equal(result.localCheckoutAccess, "verified");
    const artifact = JSON.parse(readFileSync(join(work, "83395.json"), "utf8"));
    assert.equal(artifact.decision, "keep_open");
    assert.equal(readFileSync(join(work, "83395.prompt.md"), "utf8"), prompt);
    const expectedParent = Object.fromEntries(Object.keys(forbidden).map((name) => [name, injectCanaries]));
    assert.deepEqual(JSON.parse(readFileSync(inputsPath, "utf8")), { before: expectedParent, after: expectedParent },
      "isolating model credentials must not erase the trusted caller's own environment");
    const observed = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line)) as Observation[];
    assert.ok(observed.some((entry) => entry.phase === "sandbox"), "actual checkout inspection must launch a provider child");
    assert.ok(observed.some((entry) => entry.phase === "exec"), "actual managed review must launch a provider child");
    const leaks: string[] = [];
    for (const entry of observed) {
      assert.ok(entry.phase === "sandbox" || entry.phase === "exec", "unexpected provider phase");
      assert.ok(Number.isInteger(entry.pid) && entry.pid > 0 && entry.pid !== execution.pid);
      assert.equal(entry.inspectionAsGh, injectCanaries, "only the supplied read-only inspection token may become child GH_TOKEN");
      assert.equal(entry.originalInspectionPresent, false);
      if (entry.phase === "exec") { assert.equal(entry.schemaArgument, true); assert.equal(entry.promptReceived, true); }
      assert.deepEqual(Object.keys(entry.forbidden).sort(), Object.keys(forbidden).sort());
      for (const [name, channels] of Object.entries(entry.forbidden)) {
        for (const [channel, present] of Object.entries(channels)) {
          assert.equal(typeof present, "boolean");
          if (present) leaks.push(`${entry.phase}:${name}:${channel}`);
        }
      }
    }
    // Assert after the valid decision/artifact: only an actual boundary leak is RED.
    assert.deepEqual(leaks, [], "privileged canary reached a real provider child");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("R05-A clean real Codex runner produces a valid keep_open artifact", () => { exercise(false); });
test("R05-A real Codex children exclude privileged canaries and retain only read-only inspection authority", () => { exercise(true); });
