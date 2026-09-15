import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import YAML from "yaml";

// R06-A only: actual producer run -> copied bundle -> actual consumer validate run.
// The reviewed report is synthetic input in the existing manual-policy format;
// this does not prove provider quality, Queue authority, job gates or publication.
const upstream = "fixtures/upstream-16505cf/.github/workflows/sweep.yml";
const candidate = "candidate/receiver/.github/workflows/sweep.yml";
const repository = "123oqwe/openclaw3-clawsweeper-review-red";
const runId = "29380556291", attempt = "2", sourceSha = "a".repeat(40);
const decision = {
  targetRepo: "openclaw/openclaw", targetBranch: "main", itemNumber: 42, itemKind: "issue",
  sourceEvent: "issues", sourceAction: "manual_explicit_review", publicationPolicy: "record_comment_only",
  supersedesInProgress: false,
};
const report = "---\npublication_policy: record_comment_only\nreviewed_at: 2026-08-01T01:02:03.000Z\n---\n# Review\n\nKeep open for maintainer follow-up.\n";
type Step = { id?: string; name?: string; run?: string; env?: Record<string, string> };
type Invocation = { command: string; pid: number; cli: string };
// setup-pnpm prepares the real shim/cache before this test. Resolve its original
// cache location before using an owned HOME; never inherit the whole host env.
const corepackHome = process.env.COREPACK_HOME ?? join(
  process.env.XDG_CACHE_HOME ?? process.env.LOCALAPPDATA ?? join(homedir(), process.platform === "win32" ? "AppData/Local" : ".cache"),
  "node/corepack",
);
function actualStep(path: string, job: string, id: string, name: string): Step {
  const steps = YAML.parse(readFileSync(path, "utf8")).jobs?.[job]?.steps as Step[] | undefined;
  const step = steps?.find((entry) => entry.id === id || entry.name === name);
  assert.ok(step?.run, `missing bundle topology: ${job}/${id} in ${path}`);
  return step;
}
function render(value: string, values: Record<string, string>): string {
  // This frozen expression set has no meaningful whitespace inside literals.
  const normalize = (expression: string) => expression.replace(/\s+/g, "");
  const normalizedValues = Object.fromEntries(Object.entries(values).map(([key, result]) => [normalize(key), result]));
  return String(value).replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, (_match, expression: string) => {
    assert.ok(Object.hasOwn(normalizedValues, normalize(expression)), `unfrozen bundle expression: ${expression}`);
    return normalizedValues[normalize(expression)];
  });
}

for (const [label, workflowPath] of [["fixed upstream control", upstream], ["candidate producer", candidate]]) {
  test(`R06-A ${label}: actual bundle creation and trusted validation`, async (t) => {
    // Lookup is inside each test: a missing candidate step cannot hide the upstream control.
    const step = actualStep(workflowPath, "event-review-apply", "create-exact-review-bundle", "Create exact review artifact bundle");
    const consumerStep = actualStep(workflowPath, "event-review-publish", "validate-exact-review-bundle", "Validate exact review artifact bundle");
    const root = mkdtempSync(join(tmpdir(), "oc3-bundle-entrypoint-"));
    try {
      const consumer = join(root, "consumer");
      mkdirSync(consumer);
      mkdirSync(join(consumer, ".artifacts"));
      for (const directory of [root, consumer]) {
        cpSync("dist", join(directory, "dist"), { recursive: true });
        cpSync("package.json", join(directory, "package.json"));
        symlinkSync(resolve("node_modules"), join(directory, "node_modules"), "dir");
      }
      mkdirSync(join(root, "artifacts/event"), { recursive: true });
      writeFileSync(join(root, "artifacts/event/42.md"), report);
      const output = join(root, "outputs"), trace = join(root, "cli.jsonl");
      writeFileSync(output, ""); writeFileSync(trace, "");
      const cli = join(root, "dist/repair/exact-review-bundle-cli.js");
      const consumerCli = join(consumer, "dist/repair/exact-review-bundle-cli.js");
      const observer = join(root, "observe.mjs");
      writeFileSync(observer, `import fs from "node:fs";
import path from "node:path";
if (process.argv[1] && ${JSON.stringify([cli, consumerCli])}.includes(path.resolve(process.argv[1]))) {
  fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ command: process.argv[2], pid: process.pid, cli: path.resolve(process.argv[1]) }) + "\\n");
}
`);
      const invocations = (): Invocation[] => readFileSync(trace, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const runtime = {
        PATH: process.env.PATH, HOME: root, RUNNER_TEMP: root,
        COREPACK_HOME: corepackHome, COREPACK_ENV_FILE: "0", COREPACK_ENABLE_NETWORK: "0",
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", COREPACK_DEFAULT_TO_LATEST: "0",
        GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: attempt,
        GITHUB_SHA: sourceSha, GITHUB_OUTPUT: output,
        NODE_OPTIONS: `--import=${pathToFileURL(observer).href}`,
      };
      const values: Record<string, string> = {
        "env.CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT": "", // Optional ledger has no payload in this report fixture.
        "steps.claim-exact-review-queue.outputs.claim_generation": "3",
        "steps.live-item.outputs.decision": JSON.stringify(decision),
        "github.run_attempt": attempt,
        "steps.claim-exact-review-queue.outputs.item_key": "openclaw/openclaw#42",
        "fromJSON(steps.claim-exact-review-queue.outputs.decision).itemKind": "issue",
        "steps.target.outputs.item_number": "42",
        "steps.claim-exact-review-queue.outputs.lease_revision": "7",
        "steps.live-item.outputs.guarded_open": "false",
        "steps.review-exact-event-item.outputs.terminal_during_review == 'true' && 'false' || steps.live-item.outputs.proceed": "true",
        "steps.live-item.outputs.terminal_missing": "false",
        "steps.review-exact-event-item.outputs.terminal_during_review == 'true' && 'true' || steps.live-item.outputs.terminal_noop": "false",
        "steps.claim-exact-review-queue.outputs.protocol_version": "2",
        "steps.live-item.outputs.target_branch": "main",
        "steps.target.outputs.target_repo": "openclaw/openclaw",
      };
      const declared = Object.fromEntries(Object.entries(step.env || {}).map(([key, value]) => [key, render(value, values)]));
      const created = spawnSync("/bin/bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", render(step.run!, values)], {
        cwd: root, env: { ...runtime, ...declared }, encoding: "utf8", timeout: 20_000, maxBuffer: 2 * 1024 * 1024,
      });
      assert.equal(created.error, undefined, "deadline or spawn failure is not a valid producer result");
      assert.equal(created.status, 0, created.stderr);
      assert.deepEqual(invocations().map((entry) => entry.command), ["create"], "the actual run must invoke the real bundle CLI once");
      assert.equal(invocations()[0].cli, cli);
      const outputs = Object.fromEntries(readFileSync(output, "utf8").split("\n").filter(Boolean).map((line) => {
        const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)];
      }));
      assert.equal(outputs.artifact_name, `exact-review-${runId}-${attempt}`);
      assert.equal(outputs.generation_attempt, attempt);
      const bundle = join(root, ".artifacts/exact-review-bundle");
      assert.equal(readFileSync(join(bundle, "review/42.md"), "utf8"), report);
      const manifest = JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8"));
      assert.deepEqual(manifest.workflow, { repository, source_sha: sourceSha, run_id: runId, run_attempt: 2, producer_job: "event-review-apply" });
      assert.deepEqual(manifest.queue, { item_key: "openclaw/openclaw#42", protocol_version: 2, lease_revision: 7, claim_generation: 3 });
      assert.equal(manifest.review.artifact_present, true);
      assert.equal(manifest.review.live_proceeded, true);

      // Trusted publication-context fixture is independent of candidate env/manifest.
      // Different consumer run/SHA exposes missing explicit producer identity wiring.
      const publication = {
        claim_generation: "3", decision: JSON.stringify(decision), generation_attempt: attempt,
        item_key: "openclaw/openclaw#42", item_kind: "issue", item_number: "42", lease_revision: "7",
        live_guarded_open: "false", live_proceeded: "true", live_terminal_missing: "false", live_terminal_noop: "false",
        producer_run_id: runId, protocol_version: "2", source_sha: sourceSha,
        target_branch: "main", target_repo: "openclaw/openclaw",
      };
      const consumerValues = Object.fromEntries(Object.entries(publication).map(([key, value]) => [`steps.publication-context.outputs.${key}`, value]));
      const consumerEnv = Object.fromEntries(Object.entries(consumerStep.env || {}).map(([key, value]) => [key, render(value, consumerValues)]));
      const consumerBundle = join(consumer, ".artifacts/exact-review-bundle");
      function validate(mutate?: (directory: string) => void) {
        // Controlled file copy stands only for artifact transport, not Actions download.
        rmSync(consumerBundle, { recursive: true, force: true });
        cpSync(bundle, consumerBundle, { recursive: true });
        mutate?.(consumerBundle);
        const before = invocations().length;
        const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", render(consumerStep.run!, consumerValues)], {
          cwd: consumer,
          env: { ...runtime, HOME: consumer, RUNNER_TEMP: consumer, GITHUB_OUTPUT: join(consumer, "outputs"), GITHUB_RUN_ID: "99999999", GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: "b".repeat(40), ...consumerEnv },
          encoding: "utf8", timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
        });
        assert.equal(result.error, undefined, "validator transport failure is not a valid rejection");
        assert.equal(invocations().length, before + 1);
        assert.equal(invocations().at(-1)?.command, "validate");
        assert.equal(invocations().at(-1)?.cli, consumerCli);
        return result;
      }
      const valid = validate();
      assert.equal(valid.status, 0, valid.stderr);
      assert.deepEqual(JSON.parse(valid.stdout), manifest);
      const mutations: Array<{ name: string; mutate: (directory: string) => void; error: RegExp }> = [
        { name: "changed report digest", mutate: (dir) => appendFileSync(join(dir, "review/42.md"), "tampered report\n"), error: /file inventory does not match its manifest/ },
        { name: "forged producer identity", mutate: (dir) => {
          const changed = structuredClone(manifest); changed.workflow.run_id = "88888888";
          writeFileSync(join(dir, "manifest.json"), JSON.stringify(changed));
        }, error: /does not match the trusted workflow context/ },
        { name: "forged decision digest", mutate: (dir) => {
          const changed = structuredClone(manifest); changed.review.decision_sha256 = "f".repeat(64);
          writeFileSync(join(dir, "manifest.json"), JSON.stringify(changed));
        }, error: /does not match the trusted workflow context/ },
      ];
      for (const mutation of mutations) await t.test(mutation.name, () => {
        const rejected = validate(mutation.mutate);
        assert.equal(rejected.status, 1, "tampered bundle must be rejected by the actual validator");
        assert.match(rejected.stderr, mutation.error);
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
