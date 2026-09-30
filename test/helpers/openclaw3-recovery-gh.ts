import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { publicationGithubFixture } from "./openclaw3-publication-gh.ts";

// Preserve the frozen R06-C stock-gh fixture. Fault only its HTTP boundary,
// after its original handler has actually persisted a completed review comment.
export function recoveryGithubFixture(number: number, pullRequest: boolean) {
  const fixture = publicationGithubFixture(number, pullRequest);
  const listeners = fixture.server.listeners("request");
  assert.equal(listeners.length, 1, "HARNESS_ERROR: expected the original GH handler");
  const original = listeners[0] as (request: IncomingMessage, response: ServerResponse) => void;
  const recoveryControls = { readbackUnavailable: false, readbackFailures: 0 };
  fixture.server.removeListener("request", original);
  fixture.server.on("request", (request, response) => {
    const path = new URL(request.url!, "http://fixture").pathname.replace(/^\/api\/v3/, "");
    const selectedComments = path === `/repos/${fixture.repo}/issues/${number}/comments`;
    const completedIds = fixture.completedComments().map((comment) => comment.id);
    const selectedComment = completedIds.some((id) => path === `/repos/${fixture.repo}/issues/comments/${id}`);
    if (request.method === "GET" && recoveryControls.readbackUnavailable && completedIds.length > 0 && (selectedComments || selectedComment)) {
      fixture.trace.push({ method: request.method, path, body: {} });
      recoveryControls.readbackFailures += 1;
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "synthetic post-write readback unavailable" }));
      return;
    }
    original(request, response);
  });
  return { ...fixture, recoveryControls };
}
