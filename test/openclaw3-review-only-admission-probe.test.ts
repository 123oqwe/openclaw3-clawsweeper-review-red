import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import YAML from "yaml";

// Planner-owned; install under test/ and run only in the authorized Hosted lane.
// Extracted public-probe consumer only: no real network, registry or App proof.
const target = "123oqwe/openclaw3-clawsweeper-sandbox";
const token = "synthetic-metadata-token";
const endpoint = `https://api.github.com/repos/${target}`;
type Step = { name?: string; run?: string; env?: Record<string, string> };
type Scenario = { name: string; status: number; body: unknown; outcome: string };
function probeStep(path: string): Step {
  const workflow = YAML.parse(readFileSync(path, "utf8"));
  const steps = Object.values(workflow.jobs).flatMap((job: any) => job.steps || []) as Step[];
  const matches = steps.filter((step) => step.name === "Probe current public visibility");
  assert.equal(matches.length, 1, `missing or ambiguous real public probe in ${path}`);
  assert.ok(matches[0].run, `public probe run missing in ${path}`);
  return matches[0];
}
const upstream = probeStep("fixtures/upstream-16505cf/.github/workflows/hosted-target-admission.yml");
const expressions: Record<string, string> = {
  "steps.eligibility.outputs.outcome": "eligible",
  "steps.metadata_token.outputs.token": token,
  "steps.metadata-token.outputs.token": token,
  "inputs.target_repo": target,
  "inputs.target_repository": target,
};
function render(value: string) {
  return value.replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, (_match, expression: string) => {
    assert.ok(Object.hasOwn(expressions, expression.trim()), `unfrozen probe expression: ${expression}`);
    return expressions[expression.trim()];
  });
}
async function execute(step: Step, scenario: Scenario) {
  const root = mkdtempSync(join(tmpdir(), "oc3-admission-probe-"));
  const output = join(root, "outputs");
  const trace = join(root, "fetch.jsonl");
  const preload = join(root, "fetch-preload.mjs");
  try {
    writeFileSync(output, "");
    writeFileSync(trace, "");
    writeFileSync(preload, `
import fs from "node:fs";
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url ?? String(input);
  const headers = new Headers(init.headers);
  const call = { url, method: init.method || "GET", authorization: headers.get("authorization") };
  fs.appendFileSync(process.env.PROBE_TRACE, JSON.stringify(call) + "\\n");
  if (url !== ${JSON.stringify(endpoint)} || call.method !== "GET" || call.authorization !== ${JSON.stringify(`Bearer ${token}`)}) {
    throw new Error("blocked unexpected fixture fetch");
  }
  const fixture = JSON.parse(process.env.PROBE_RESPONSE);
  return new Response(JSON.stringify(fixture.body), { status: fixture.status, headers: { "content-type": "application/json" } });
};
`);
    // Map only each real step's declared keys; never add a TARGET_REPO alias.
    const declared = Object.fromEntries(Object.entries(step.env || {}).map(([key, value]) => [key, render(String(value))]));
    for (const [key, value] of Object.entries(declared)) {
      assert.ok(["TARGET_ELIGIBILITY", "TARGET_REPOSITORY", "TARGET_REPO", "METADATA_TOKEN"].includes(key), `unreviewed probe env: ${key}`);
      assert.ok(["eligible", target, token].includes(value), `non-fixture probe env: ${key}`);
    }
    const child = spawn("/bin/bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", render(step.run!)], {
      cwd: root, detached: true,
      env: {
        PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter), HOME: root,
        GITHUB_OUTPUT: output, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        PROBE_TRACE: trace, PROBE_RESPONSE: JSON.stringify(scenario), ...declared,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stdout.resume();
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } }, 10_000);
    const code = await new Promise<number | null>((accept, reject) => {
      child.once("error", reject);
      child.once("close", accept);
    }).finally(() => clearTimeout(timer));
    assert.equal(code, 0, `probe process failed; not visibility-behavior RED: ${stderr}`);
    const calls = readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(calls, [{ url: endpoint, method: "GET", authorization: `Bearer ${token}` }], "exactly one fixture-only fetch is required");
    assert.equal(readFileSync(output, "utf8"), `outcome=${scenario.outcome}\n`, scenario.name);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const complete = { full_name: target, private: false, visibility: "public" };
const scenarios: Scenario[] = [
  { name: "matching public repository", status: 200, body: complete, outcome: "public" },
  { name: "incomplete 200 is retryable", status: 200, body: { private: false }, outcome: "retryable" },
  { name: "different repository is terminal", status: 200, body: { ...complete, full_name: "example/foreign" }, outcome: "terminal" },
  { name: "internal visibility is terminal", status: 200, body: { ...complete, visibility: "internal" }, outcome: "terminal" },
  { name: "404 is terminal", status: 404, body: { message: "Not Found" }, outcome: "terminal" },
  { name: "403 is retryable", status: 403, body: { message: "Forbidden" }, outcome: "retryable" },
];
for (const scenario of scenarios) test(`public probe: ${scenario.name}`, async (t) => {
  let controlPassed = false;
  await t.test("pinned upstream control", async () => { await execute(upstream, scenario); controlPassed = true; });
  await t.test("candidate original run", {
    skip: controlPassed ? false : "upstream control failed; candidate not evaluated and not valid RED evidence",
  }, async () => {
    const candidate = probeStep("candidate/receiver/.github/workflows/hosted-target-admission.yml");
    await execute(candidate, scenario);
  });
});
