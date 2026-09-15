import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import YAML from "yaml";

// These are topology checks, not proof of runtime claim, isolation or publication.
// Runtime tests in test/repair exercise the actual manual CLI and inline claim.
const candidate = resolve(process.env.OC3_REVIEW_CANDIDATE_DIR || "candidate/receiver");
const readWorkflow = (name: string) => YAML.parse(readFileSync(join(candidate, ".github/workflows", name), "utf8"));
const sweep = readWorkflow("sweep.yml");
const admission = readWorkflow("hosted-target-admission.yml");
type Step = { id?: string; name?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown>; "working-directory"?: string };
type Job = { steps?: Step[]; if?: string; needs?: string | string[]; uses?: string; secrets?: Record<string, unknown> };
const jobs = Object.entries(sweep.jobs) as Array<[string, Job]>;
const inheritedFileExists = (path: string) => existsSync(join(candidate, path)) || existsSync(resolve(path));
// Freeze conjunction-only guards at these specific trust boundaries. This is
// deliberately not a general GitHub expression interpreter. A different safe
// shape needs author review; `guard || true` must never pass by substring.
function guardAtoms(condition: unknown): string[] {
  if (condition === undefined) return [];
  const body = String(condition).trim().replace(/^\$\{\{\s*/, "").replace(/\s*\}\}$/, "");
  const atoms = body.split(/\s*&&\s*/).map((part) => part.trim().replace(/\s*(==|!=)\s*/g, " $1 "));
  for (const atom of atoms) {
    assert.ok(/^(?:[A-Za-z_][A-Za-z0-9_.-]* (?:==|!=) '[^']*'|success\(\)|always\(\))$/.test(atom), `unreviewed boundary guard: ${body}`);
  }
  return atoms;
}
function requireGuard(condition: unknown, atom: string) {
  assert.ok(guardAtoms(condition).includes(atom), `missing mandatory guard: ${atom}`);
}
function sourceCheckout(step: Step) {
  return step.uses?.startsWith("actions/checkout@") && (!step.with?.repository || step.with.repository === "${{ github.repository }}");
}
function localSourcePath(path: string, steps: Step[]) {
  const clean = path.replace(/^\.\//, "");
  for (const checkout of steps.filter(sourceCheckout)) {
    const prefix = String(checkout.with?.path || ".").replace(/^\.\//, "");
    if (prefix !== "." && clean.startsWith(`${prefix}/`)) return clean.slice(prefix.length + 1);
  }
  return clean;
}

test("R02 wiring: executable and composite-action references resolve to actual pinned source", () => {
  for (const [jobId, job] of jobs) {
    for (const step of job.steps || []) {
      for (const match of (step.run || "").matchAll(/\bnode\s+(dist\/[A-Za-z0-9_./-]+\.js)\b/g)) {
        const source = match[1].replace(/^dist\//, "src/").replace(/\.js$/, ".ts");
        assert.ok(inheritedFileExists(source), `${jobId}: ${match[1]} has no corresponding source ${source}`);
      }
      if (step.uses?.startsWith("./")) {
        assert.ok(inheritedFileExists(`${localSourcePath(step.uses, job.steps || [])}/action.yml`), `${jobId}: missing composite ${step.uses}`);
      }
    }
  }
  const model = sweep.jobs["event-review-apply"].steps.find((step: Step) => step.uses?.includes("setup-codex"));
  assert.equal(localSourcePath(model?.uses || "", sweep.jobs["event-review-apply"].steps), ".github/actions/setup-codex", "reuse the actual pinned local action, not a guessed external action");
  assert.doesNotMatch(JSON.stringify(admission), /node\s+dist\/hosted-target-admission\.js/, "hosted-target-admission is a library, not an executable CLI");
});

test("R02 wiring: each dist consumer has checkout and an existing build route in its own job", () => {
  for (const [jobId, job] of jobs) {
    const steps = job.steps || [];
    for (const [index, consumer] of steps.entries()) {
      if (!/\bnode\s+dist\//.test(consumer.run || "")) continue;
      const before = steps.slice(0, index);
      const consumerGuards = guardAtoms(consumer.if);
      const available = (step: Step) => guardAtoms(step.if).every((atom) => consumerGuards.includes(atom));
      const cwd = consumer["working-directory"] || ".";
      assert.ok(before.some((step) => sourceCheckout(step) && String(step.with?.path || ".") === cwd && available(step)), `${jobId}: no reachable source checkout for ${cwd}`);
      assert.ok(before.some((step) => (
        (localSourcePath(step.uses || "", before) === ".github/actions/setup-pnpm" && String(step.with?.["working-directory"] || ".") === cwd && ["build:node", "build:repair", "build:all"].includes(String(step.with?.["build-script"]))) ||
        ((step["working-directory"] || ".") === cwd && /\bpnpm(?:\s+run)?\s+build:(?:node|repair|all)\b/.test(step.run || ""))
      ) && available(step)), `${jobId}: no reachable repair build for ${cwd}`);
    }
  }
});

test("R02 wiring: valid queue receipts are admitted without a nonexistent dispatch policy field", () => {
  for (const id of ["event-review-apply", "event-review-publish"]) {
    const job = sweep.jobs[id];
    assert.ok(job, `missing ${id}`);
    assert.match(job.if || "", /queue_lease_id/);
    assert.doesNotMatch(job.if || "", /client_payload\.publication_policy/, "the pinned dispatcher does not emit publication_policy; validate authoritative claim decision");
  }
});

test("R02 routing: manual admission and the two queue consumers have disjoint job event gates", () => {
  const caller = jobs.find(([, job]) => job.uses === "./.github/workflows/hosted-target-admission.yml");
  assert.ok(caller, "manual admission caller is required");
  requireGuard(caller[1].if, "github.event_name == 'workflow_dispatch'");
  requireGuard(sweep.jobs["event-review-apply"].if, "github.event_name == 'repository_dispatch'");
  requireGuard(sweep.jobs["event-review-apply"].if, "github.event.client_payload.source_action == 'manual_explicit_review'");
  requireGuard(sweep.jobs["event-review-publish"].if, "github.event_name == 'repository_dispatch'");
  requireGuard(sweep.jobs["event-review-publish"].if, "github.event.client_payload.source_action == 'exact_review_artifact_publish'");
});

test("R02 wiring: manual admission consumes the reusable admission result and passes its declared secrets", () => {
  const caller = jobs.find(([, job]) => job.uses === "./.github/workflows/hosted-target-admission.yml");
  assert.ok(caller, "admission workflow must be reachable from sweep");
  const [callerId, call] = caller;
  assert.ok(admission.on.workflow_call.outputs?.outcome, "admission must publish a caller-consumed outcome");
  const manual = sweep.jobs["manual-selection"] as Job;
  assert.ok(manual);
  const needs = Array.isArray(manual.needs) ? manual.needs : [manual.needs];
  assert.ok(needs.includes(callerId), "manual-selection must await admission");
  requireGuard(manual.if, `needs.${callerId}.outputs.outcome == 'public'`);
  const admissionText = JSON.stringify(admission);
  if (admissionText.includes("secrets.CLAWSWEEPER_APP_PRIVATE_KEY")) {
    assert.ok(admission.on.workflow_call.secrets?.CLAWSWEEPER_APP_PRIVATE_KEY, "declare the referenced reusable-workflow secret");
    assert.ok(call.secrets?.CLAWSWEEPER_APP_PRIVATE_KEY, "caller must explicitly pass its declared secret");
  }
});

test("R02 wiring: external input is passed through env instead of interpolated into shell source", () => {
  for (const [workflowName, workflow] of [["sweep", sweep], ["admission", admission]] as const) {
    for (const [id, job] of Object.entries(workflow.jobs) as Array<[string, Job]>) {
      for (const step of job.steps || []) {
        assert.doesNotMatch(step.run || "", /\$\{\{\s*(?:inputs\.|github\.event\.)/, `${workflowName}/${id}: untrusted expression in shell source`);
      }
    }
  }
});

test("R04 topology: model and publisher credentials require successful authoritative claims", () => {
  const apply = sweep.jobs["event-review-apply"];
  const modelIndex = apply.steps.findIndex((step: Step) => step.uses?.includes("setup-codex"));
  const claimIndex = apply.steps.findIndex((step: Step) => step.id === "claim-exact-review-queue");
  assert.ok(claimIndex >= 0 && modelIndex > claimIndex, "real inline claim must precede model setup");
  requireGuard(apply.steps[modelIndex].if, "steps.claim-exact-review-queue.outputs.claimed == 'true'");
  const publish = sweep.jobs["event-review-publish"];
  const publicationIndex = publish.steps.findIndex((step: Step) => step.id === "publication-context");
  const mintIndex = publish.steps.findIndex((step: Step) => step.uses?.includes("create-github-app-token"));
  assert.ok(publicationIndex >= 0 && mintIndex > publicationIndex, "publisher must retain its actual claim/provenance gate before minting write credentials");
  requireGuard(publish.steps[mintIndex].if, "steps.publication-context.outputs.claimed == 'true'");
});
