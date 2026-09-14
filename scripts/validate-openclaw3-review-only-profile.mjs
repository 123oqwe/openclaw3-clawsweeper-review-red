#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const draftMode = args[0] === "--draft";
const profilePath = args[draftMode ? 1 : 0] ?? "config/openclaw3-review-only.example.json";
const profile = JSON.parse(readFileSync(resolve(profilePath), "utf8"));
const errors = [];
const requireValue = (condition, message) => {
  if (!condition) errors.push(message);
};

requireValue(profile.schemaVersion === 1, "schemaVersion must be 1");
requireValue(
  profile.upstream?.repository === "openclaw/clawsweeper" &&
    profile.upstream?.commit === "16505cf0358d70341e1c8d0135d648e2f69b896c",
  "upstream must remain the reviewed ClawSweeper source pin",
);
const isPlaceholder = (value) => typeof value === "string" && /^<approval-required: .+>$/.test(value);
const targetRepository = profile.target?.repository;
const targetBranch = profile.target?.branch;
if (draftMode) {
  requireValue(isPlaceholder(targetRepository), "draft target repository must remain an approval placeholder");
  requireValue(isPlaceholder(targetBranch), "draft target branch must remain an approval placeholder");
} else {
  requireValue(!isPlaceholder(targetRepository), "approval placeholder is not deployment-ready");
  requireValue(!isPlaceholder(targetBranch), "approval placeholder is not deployment-ready");
  requireValue(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(targetRepository ?? ""), "target repository is invalid");
  requireValue(/^[A-Za-z0-9_./-]+$/.test(targetBranch ?? "") && !targetBranch.includes(".."), "target branch is invalid");
}
requireValue(profile.review?.trigger === "manual_exact_review", "only manual exact review is permitted");
requireValue(profile.review?.publicationPolicy === "record_comment_only", "publication policy must be record_comment_only");
requireValue(profile.review?.manualPublicationEnabled === true, "manual publication must be explicitly enabled");
for (const key of ["applyExisting", "applyAfterReview", "scheduledIntake", "automaticClose"]) {
  requireValue(profile.review?.[key] === false, `${key} must remain false`);
}
requireValue(profile.identity?.officialDefaultLogin === "clawsweeper[bot]", "official bot login default must not change");
requireValue(profile.identity?.officialDefaultId === 274271284, "official bot numeric ID default must not change");
requireValue(profile.identity?.replacementRequiresPairedLoginAndId === true, "replacement identity must require a login/id pair");

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(draftMode ? "review-only draft is structurally valid and not deployment-ready" : "review-only profile syntax is valid; receiver wiring must be verified by Hosted acceptance");
}
