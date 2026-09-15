import fs from "node:fs";
import path from "node:path";

// Observe only: do not change argv, environment, imports, signals or CLI behavior.
if (process.argv[1] && path.resolve(process.argv[1]) === process.env.OC3_EXPECTED_CLI) {
  const names = [
    "EXACT_REVIEW_ITEM_KEY", "EXACT_REVIEW_ITEM_KIND", "EXACT_REVIEW_LEASE_ID",
    "EXACT_REVIEW_LEASE_REVISION", "EXACT_REVIEW_CLAIM_GENERATION",
    "EXACT_REVIEW_SOURCE_HEAD_SHA", "EXACT_REVIEW_DECISION", "SOURCE_ACTION",
  ];
  const stat = fs.readFileSync("/proc/self/stat", "utf8");
  const processGroup = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
  fs.appendFileSync(process.env.OC3_CLI_TRACE, JSON.stringify({
    event: "cli-start", pid: process.pid, processGroup, argv: process.argv.slice(2),
    env: Object.fromEntries(names.map((name) => [name, process.env[name]])),
  }) + "\n");
}
