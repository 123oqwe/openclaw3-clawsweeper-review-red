// Planner-owned R01/R02 contract. Static evidence only; never a runtime review approval.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import YAML from "yaml";

const root = fileURLToPath(new URL("../", import.meta.url));
const original = path.join(root, "fixtures/upstream-16505cf");
// GREEN selects the actual deployable candidate, not edited upstream evidence.
const candidate = path.resolve(root, process.env.OC3_REVIEW_CANDIDATE_DIR || "fixtures/upstream-16505cf");
const pinnedFiles = {
  ".github/workflows/sweep.yml": "361f0f2bc947a8e33e1f5f5dc65f8533cce3ad0274d4fea7a6f48c2b08945ff8",
  ".github/workflows/hosted-target-admission.yml": "c8da999a1698b66279a023b91c4b55d84636f9a9603c0309f829ff9f1c1d1f23",
};

function object(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), label);
  return value as Record<string, unknown>;
}

function readWorkflow(name: string) {
  const source = readFileSync(path.join(candidate, ".github/workflows", name), "utf8");
  return { source, workflow: object(YAML.parse(source), name) };
}

test("R01 upstream evidence retains both exact pinned workflow bytes", () => {
  const manifest = object(JSON.parse(readFileSync(path.join(original, "manifest.json"), "utf8")), "manifest");
  assert.equal(manifest.commit, "16505cf0358d70341e1c8d0135d648e2f69b896c");
  assert.equal(manifest.source, "https://github.com/openclaw/clawsweeper.git");
  assert.deepEqual(manifest.files, pinnedFiles);
  for (const [name, expected] of Object.entries(pinnedFiles)) {
    assert.equal(createHash("sha256").update(readFileSync(path.join(original, name))).digest("hex"), expected, name);
  }
});

test("R02 receiver exposes only manual selection and exact queue receipts", () => {
  const { workflow } = readWorkflow("sweep.yml");
  const events = object(workflow.on, "receiver events");
  assert.deepEqual(Object.keys(events).sort(), ["repository_dispatch", "workflow_dispatch"]);
  assert.deepEqual(object(events.repository_dispatch, "receipt trigger").types, ["clawsweeper_item"]);
  const inputs = object(object(events.workflow_dispatch, "manual trigger").inputs, "manual inputs");
  assert.ok(inputs.item_number, "the permitted manual positive path must remain reachable");
  for (const name of Object.keys(inputs)) {
    assert.doesNotMatch(name, /^(apply_|audit_|hot_intake$|shard_count$|batch_size$)/, `forbidden input ${name}`);
  }
  const jobs = object(workflow.jobs, "receiver jobs");
  assert.ok(Object.keys(jobs).length > 0, "removing all jobs is not a valid GREEN");
  for (const name of Object.keys(jobs)) {
    assert.doesNotMatch(name, /^(apply-existing|repair|autofix|automerge|fanout|target-fanout)(-|$)/, `forbidden job ${name}`);
  }
});

test("R02 workflow token stays read-only and publisher App token does not grant broad writes", () => {
  const { workflow, source } = readWorkflow("sweep.yml");
  assert.deepEqual(workflow.permissions, { contents: "read" });
  for (const [name, rawJob] of Object.entries(object(workflow.jobs, "jobs"))) {
    const permissions = object(rawJob, name).permissions;
    if (permissions === undefined) continue;
    for (const [scope, level] of Object.entries(object(permissions, `${name} permissions`))) {
      assert.ok(level === "read" || level === "none", `${name}: unexpected GITHUB_TOKEN ${scope}=${level}`);
    }
  }
  assert.doesNotMatch(source, /permission-(?:contents|pull-requests|checks|statuses):\s*write\b/);
  assert.match(source, /permission-issues:\s*write\b/, "retain a usable comment publisher rather than removing all publication");
});

test("R02 admission selects self-owned registry and App configuration", () => {
  const { source, workflow } = readWorkflow("hosted-target-admission.yml");
  assert.ok(Object.keys(object(workflow.jobs, "admission jobs")).length > 0);
  assert.doesNotMatch(source, /raw\.githubusercontent\.com\/openclaw\/clawsweeper\//);
  assert.doesNotMatch(source, /Iv23liOECG0slfuhz093/);
  assert.match(source, /CLAWSWEEPER_APP_CLIENT_ID/);
  assert.match(source, /\$\{\{\s*github\.repository\s*\}\}/);
});

test("R02 claim step precedes model setup in the retained exact-review job", () => {
  const { workflow } = readWorkflow("sweep.yml");
  const job = object(object(workflow.jobs, "jobs")["event-review-apply"], "retained exact-review job");
  assert.ok(Array.isArray(job.steps), "exact-review steps");
  const steps = job.steps.map((value) => object(value, "step"));
  const claim = steps.findIndex((step) => step.name === "Claim exact-review queue lease");
  const model = steps.findIndex((step) => typeof step.uses === "string" && step.uses.includes("setup-codex"));
  assert.ok(claim >= 0 && model > claim, "missing claim/model steps cannot satisfy ordering");
  // Ordering is not proof that forged claims are rejected: R04 must exercise the runtime.
});
