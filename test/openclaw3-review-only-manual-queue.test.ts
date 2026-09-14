import {
  assert,
  test,
  ExactReviewQueue,
  MemoryDurableStorage,
  buildExactReviewQueueRequest,
} from "./dashboard-worker-harness.ts";

const manualDecision = {
  targetRepo: "123oqwe/openclaw3-clawsweeper-sandbox",
  targetBranch: "main",
  itemNumber: 41,
  itemKind: "pull_request",
  sourceEvent: "pull_request",
  sourceAction: "manual_explicit_review",
  supersedesInProgress: false,
  publicationPolicy: "record_comment_only",
  codexTimeoutMs: 1_200_000,
  additionalPrompt: "",
};

test("manual queue admission rejects forged policy/source before a receiver can claim work", async () => {
  const queue = new ExactReviewQueue(
    { storage: new MemoryDurableStorage() },
    { hostedTargetPredicate: () => true, EXACT_REVIEW_MANUAL_PUBLICATION_ENABLED: "1" },
  );
  for (const [deliveryId, sourceAction, decision] of [
    ["missing-policy", "manual_explicit_review", { ...manualDecision, publicationPolicy: undefined }],
    ["wrong-policy", "manual_explicit_review", { ...manualDecision, publicationPolicy: "ordinary" }],
    ["wrong-source", "opened", { ...manualDecision, sourceAction: "opened" }],
  ] as const) {
    const response = await queue.fetch(
      buildExactReviewQueueRequest(deliveryId, 41, sourceAction, "pull_request", manualDecision.targetRepo, decision),
    );
    assert.equal(response.status, 400, deliveryId);
  }
});

test("manual queue admission accepts only the enabled paired source/policy control", async () => {
  const storage = new MemoryDurableStorage();
  const disabled = new ExactReviewQueue({ storage }, { hostedTargetPredicate: () => true });
  assert.equal(
    (
      await disabled.fetch(
        buildExactReviewQueueRequest("disabled", 41, "manual_explicit_review", "pull_request", manualDecision.targetRepo, manualDecision),
      )
    ).status,
    409,
  );
  const enabled = new ExactReviewQueue(
    { storage },
    { hostedTargetPredicate: () => true, EXACT_REVIEW_MANUAL_PUBLICATION_ENABLED: "1" },
  );
  assert.equal(
    (
      await enabled.fetch(
        buildExactReviewQueueRequest("enabled", 41, "manual_explicit_review", "pull_request", manualDecision.targetRepo, manualDecision),
      )
    ).status,
    202,
  );
});
