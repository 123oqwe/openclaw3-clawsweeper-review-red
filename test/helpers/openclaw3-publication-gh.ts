import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

// Bounded extraction of scripts/e2e/manual-review-publication.mjs GH transport.
// Stock gh performs HTTP; only GitHub data/transport are fixtures. Unknown
// methods, GraphQL mutations, close/merge/label/reaction routes are hard errors.
export function publicationGithubFixture(number: number, pullRequest: boolean) {
  const repo = "openclaw/openclaw";
  const trace: Array<{ method?: string; path: string; body?: any; readOnlyGraphql?: boolean }> = [];
  const failures: string[] = [];
  const controls = { githubFailure: 0, lostAcknowledgement: false };
  const item: any = { number, title: "Bounded synthetic review", body: "Existing behavior bug.", html_url: `https://github.com/${repo}/issues/${number}`, state: "open", locked: false, user: { login: "fixture-author" }, author_association: "CONTRIBUTOR", labels: [{ name: "bug" }], created_at: "2026-07-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z", comments: 0, pull_request: pullRequest ? { url: `https://api.github.com/repos/${repo}/pulls/${number}` } : null };
  const items = new Map<number, any>([[number, item]]);
  const comments = new Map<number, any[]>([[number, []]]);
  const pulls = new Map<number, any>(pullRequest ? [[number, { ...item, draft: false, merged: false, merged_at: null, mergeable: true, mergeable_state: "clean", head: { sha: "d".repeat(40), ref: `fixture-${number}`, repo: { full_name: repo } }, base: { sha: "b".repeat(40), ref: "main", repo: { full_name: repo } }]] : []);
  let nextComment = 100;
  async function handle(req: IncomingMessage, res: ServerResponse) {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const path = new URL(req.url!, "http://fixture").pathname.replace(/^\/api\/v3/, "");
      const body = bytes.length ? JSON.parse(bytes.toString()) : {};
      const send = (value: any, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(status === 204 ? undefined : JSON.stringify(value)); };
      trace.push({ method: req.method, path, body });
    const target = path.match(/\/(?:issues|pulls)\/(\d+)(?:\/|$)/);
    if (path === "/api/graphql" && req.method === "POST") {
      const query = String(body.query).replace(/\s+/g, " ").trim();
      if (query.startsWith("query ReviewedPrActivityCursorV2")) {
        const number = Number(query.match(/pr_(\d+): pullRequest/)?.[1]);
        assert.ok(pulls.has(number), "unselected PR activity query");
        assert.equal(
          query.replaceAll(`pr_${number}`, "pr_73").replaceAll(`number: ${number}`, "number: 73"),
          'query ReviewedPrActivityCursorV2 { repository(owner: "openclaw", name: "openclaw") { pr_73: pullRequest(number: 73) { reviews(first: 100) { totalCount pageInfo { hasNextPage } nodes { fullDatabaseId author { login } state body submittedAt commit { oid } } } reviewThreads(first: 100) { totalCount pageInfo { hasNextPage } nodes { id isResolved comments(first: 100) { totalCount pageInfo { hasNextPage } nodes { fullDatabaseId pullRequestReview { fullDatabaseId } replyTo { fullDatabaseId } author { login } body createdAt updatedAt path line startLine originalLine originalCommit { oid } commit { oid } } } } } } } }',
        );
        trace.at(-1).readOnlyGraphql = true;
        const emptyConnection = { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] };
        return send({
          data: {
            repository: {
              [`pr_${number}`]: {
                reviews: emptyConnection,
                reviewThreads: emptyConnection,
              },
            },
          },
        });
      }
      assert.equal(
        query,
        "query IssueByNumber($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { hasIssuesEnabled issue: issueOrPullRequest(number: $number) { __typename ...on Issue{closedByPullRequestsReferences(first: 100) {nodes {id,number,url,repository {id,name,owner {id,login}}}pageInfo{hasNextPage,endCursor}},id} ...on PullRequest{id} } } }",
      );
      assert.equal(`${body.variables.owner}/${body.variables.repo}`, repo);
      const number = body.variables.number;
      assert.ok(items.has(number) && number !== 99, "unselected GraphQL item");
      trace.at(-1).readOnlyGraphql = true;
      return send({
        data: {
          repository: {
            hasIssuesEnabled: true,
            issue: pulls.has(number)
              ? { __typename: "PullRequest", id: `PR_fixture${number}` }
              : {
                  __typename: "Issue",
                  id: `I_fixture${number}`,
                  closedByPullRequestsReferences: {
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
          },
        },
      });
    }
    if (target && Number(target[1]) !== number) throw new Error("unselected item accessed");
    if (path === `/repos/${repo}` && req.method === "GET")
      return send({ full_name: repo, private: false, visibility: "public", default_branch: "main" });
    const item = path.match(new RegExp(`^/repos/${repo}/issues/(\\d+)$`));
    if (item && req.method === "GET") return send(items.get(Number(item[1])));
    const requestedPull = target && pulls.get(Number(target[1]));
    if (
      requestedPull &&
      path === `/repos/${repo}/pulls/${requestedPull.number}` &&
      req.method === "GET"
    )
      return send(requestedPull);
    if (
      requestedPull &&
      ["reviews", "files", "commits", "comments"].some(
        (kind) => path === `/repos/${repo}/pulls/${requestedPull.number}/${kind}`,
      ) &&
      req.method === "GET"
    )
      return send([]);
    const commit = path.match(
      new RegExp(`^/repos/${repo}/commits/([a-f0-9]{40})/(check-runs|status)$`),
    );
    const knownHead = commit && [...pulls.values()].some((entry) => entry.head.sha === commit[1]);
    if (knownHead && commit[2] === "check-runs" && req.method === "GET")
      return send({ total_count: 0, check_runs: [] });
    if (knownHead && commit[2] === "status" && req.method === "GET")
      return send({ state: "pending", sha: commit[1], total_count: 0, statuses: [] });
    const list = path.match(new RegExp(`^/repos/${repo}/issues/(\\d+)/comments$`));
    const comment = path.match(new RegExp(`^/repos/${repo}/issues/comments/(\\d+)$`));
    if (list && req.method === "GET") return send(comments.get(Number(list[1])));
    if ((list && req.method === "POST") || (comment && req.method === "PATCH")) {
      const number = list
        ? Number(list[1])
        : [...comments].find(([, entries]) =>
            entries.some((entry) => entry.id === Number(comment[1])),
          )?.[0];
      assert.ok(number && number !== 99);
      const completed = body.body.includes("clawsweeper-review-version");
      if (completed && controls.githubFailure)
        return send({ message: "synthetic transient failure" }, controls.githubFailure);
      let entry = comment
        ? comments.get(number).find((entry) => entry.id === Number(comment[1]))
        : null;
      if (!entry) {
        entry = {
          id: nextComment++,
          user: { login: "clawsweeper[bot]", type: "Bot" },
          created_at: new Date().toISOString(),
          issue_url: `https://api.github.com/repos/${repo}/issues/${number}`,
        };
        comments.get(number).push(entry);
      }
      Object.assign(entry, {
        body: body.body,
        updated_at: new Date().toISOString(),
        html_url: `https://github.com/${repo}/issues/${number}#issuecomment-${entry.id}`,
      });
      if (completed && controls.lostAcknowledgement) {
        controls.lostAcknowledgement = false;
        return send({});
      }
      return send(entry, list ? 201 : 200);
    }
    if (comment && req.method === "GET")
      return send([...comments.values()].flat().find((entry) => entry.id === Number(comment[1])));
    if (comment && req.method === "DELETE") {
      const removed = [...comments.values()].flat().find((entry) => entry.id === Number(comment[1]));
      assert.ok(removed && /clawsweeper-review-(?:status:started|lease)/.test(removed.body), "only an owned review-lease deletion is allowed");
      for (const [number, entries] of comments)
        comments.set(
          number,
          entries.filter((entry) => entry.id !== Number(comment[1])),
        );
      return send({}, 204);
    }
    if (req.method !== "GET")
      throw new Error(`forbidden synthetic upstream effect: ${req.method} ${path}`);
    if (path.endsWith("/timeline")) return send([]);
    if (path === "/search/issues") return send({ items: [], total_count: 0 });
    if (path === "/rate_limit")
      return send({
        resources: { core: { remaining: 5000, reset: Math.floor(Date.now() / 1000) + 3600 } },
      });
    throw new Error(`unsupported synthetic upstream read: ${path}`);
    } catch (error) {
      failures.push(String(error));
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: `HARNESS_ERROR ${String(error)}` }));
    }
  }
  return { number, repo, item, items, pulls, comments, controls, trace, failures, server: createServer(handle),
    assertNoForbidden() { assert.deepEqual(failures, [], "HARNESS_ERROR: unexpected GH access is not product RED"); },
    completedComments() { return comments.get(number)!.filter((entry) => entry.body.includes("clawsweeper-review-version")); },
    mutationCount() { return trace.filter((entry) => ["POST", "PATCH", "DELETE"].includes(entry.method || "") && /\/comments(?:\/|$)/.test(entry.path)).length; },
  };
}
