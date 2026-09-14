// Planner-owned R03 integration baseline. Real client + Worker + Queue; no external service.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import runtimeWorker from "../../dashboard/worker.ts";
import { isHostedTargetEligible } from "../../src/hosted-target-admission.ts";
import { enqueueManualReviews } from "../../dist/repair/manual-review-enqueue.js";
import { ExactReviewQueue, MemoryDurableNamespace, MemoryDurableStorage } from "../dashboard-worker-harness.ts";

const target = "123oqwe/openclaw3-clawsweeper-sandbox";
const secret = "synthetic-test-only-never-a-service-secret";
const endpoint = "https://queue.example/internal/exact-review/enqueue";

function environment(enabled = true) {
  const storage = new MemoryDurableStorage();
  const policy = { configuredRepositories: [target], genericFallbacks: [] };
  let visibilityProbes = 0;
  const controls = {
    hostedTargetPredicate: (repo: string) => isHostedTargetEligible(repo, policy),
    hostedPublicTargetProbe: async () => {
      visibilityProbes += 1;
      return "public" as const;
    },
    EXACT_REVIEW_MANUAL_PUBLICATION_ENABLED: enabled ? "1" : "0",
  };
  const queue = new ExactReviewQueue({ storage }, controls);
  const env = { ...controls, CLAWSWEEPER_WEBHOOK_SECRET: secret, EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue) };
  return { storage, env, probes: () => visibilityProbes };
}

function body(overrides: Record<string, unknown> = {}, delivery = "planner:manual:41") {
  return JSON.stringify({
    delivery_id: delivery,
    decision: {
      targetRepo: target,
      targetBranch: "main",
      itemNumber: 41,
      itemKind: "pull_request",
      sourceEvent: "pull_request",
      sourceAction: "manual_explicit_review",
      publicationPolicy: "record_comment_only",
      codexTimeoutMs: 1_200_000,
      additionalPrompt: "",
      supersedesInProgress: false,
      ...overrides,
    },
  });
}

function signed(payload: string, signedPayload = payload) {
  return new Request(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", secret).update(signedPayload).digest("hex")}` },
    body: payload,
  });
}

async function storedItems(storage: MemoryDurableStorage) {
  const state = await storage.get("exact-review-queue") as { items?: Record<string, { decision: Record<string, unknown> }> } | undefined;
  return state?.items ?? {};
}

test("R03 real signed manual client reaches Worker and Queue; duplicate delivery keeps one item", async (t) => {
  const h = environment();
  t.after(() => h.storage.sql.close());
  const wire: Array<{ pathname: string; status: number }> = [];
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const pathname = new URL(request.url).pathname;
    // Capability HTTP boundary is synthetic; the signed POST uses actual Worker/Queue code.
    if (request.method === "GET") {
      assert.equal(pathname, "/api/exact-review-queue");
      return Response.json({ manual_publication: { enabled: true, policy: "record_comment_only" } });
    }
    assert.equal(request.method, "POST");
    assert.equal(pathname, "/internal/exact-review/enqueue");
    const response = await runtimeWorker.fetch(request, h.env);
    wire.push({ pathname, status: response.status });
    return response;
  };
  const options = {
    targetRepo: target, targetBranch: "main", codexTimeoutMs: 1_200_000,
    itemNumbers: [41], requestId: "planner:manual", queueUrl: "https://queue.example", secret,
    itemKind: async () => "pull_request" as const, fetch: transport,
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await enqueueManualReviews(options);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.accepted, 1);
  }
  assert.equal(wire.length, 2);
  assert.ok(wire.every((entry) => entry.status >= 200 && entry.status < 300));
  const items = await storedItems(h.storage);
  assert.deepEqual(Object.keys(items), [`${target}#41`]);
  assert.equal(items[`${target}#41`].decision.sourceAction, "manual_explicit_review");
  assert.equal(items[`${target}#41`].decision.publicationPolicy, "record_comment_only");
});

test("R03 missing or body-mismatched signature rejects before target probing or persistence", async (t) => {
  const h = environment();
  t.after(() => h.storage.sql.close());
  const original = body();
  const requests = [
    new Request(endpoint, { method: "POST", body: original }),
    signed(body({ itemNumber: 42 }), original),
  ];
  for (const request of requests) {
    const response = await runtimeWorker.fetch(request, h.env);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "invalid_signature" });
  }
  assert.equal(h.probes(), 0);
  assert.deepEqual(await storedItems(h.storage), {});
});

test("R03 signed unknown target is rejected by real eligibility policy before probing", async (t) => {
  const h = environment();
  t.after(() => h.storage.sql.close());
  for (const repo of ["123oqwe/unregistered", "openclaw/openclaw"]) {
    const response = await runtimeWorker.fetch(signed(body({ targetRepo: repo })), h.env);
    assert.equal(response.status, 422, repo);
    assert.deepEqual(await response.json(), { error: "private_target_unsupported" });
  }
  assert.equal(h.probes(), 0);
  assert.deepEqual(await storedItems(h.storage), {});
});

test("R03 signed malformed manual policy/source cannot create queue work", async (t) => {
  const h = environment();
  t.after(() => h.storage.sql.close());
  for (const overrides of [
    { publicationPolicy: undefined },
    { publicationPolicy: "ordinary" },
    { sourceAction: "opened" },
  ]) {
    const response = await runtimeWorker.fetch(signed(body(overrides)), h.env);
    assert.equal(response.status, 400, JSON.stringify(overrides));
    assert.deepEqual(await storedItems(h.storage), {});
  }
});

test("R03 disabled manual publication rejects a valid signed selection", async (t) => {
  const h = environment(false);
  t.after(() => h.storage.sql.close());
  const response = await runtimeWorker.fetch(signed(body()), h.env);
  assert.equal(response.status, 409);
  assert.deepEqual(await storedItems(h.storage), {});
});
