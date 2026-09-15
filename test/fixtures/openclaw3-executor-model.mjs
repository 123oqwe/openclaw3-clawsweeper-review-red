#!/usr/bin/env node
import fs from "node:fs";
// This first package stops at metadata. Any provider invocation is a test failure.
fs.appendFileSync(process.env.OC3_MODEL_TRACE, JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }) + "\n");
process.stderr.write("OC3_UNEXPECTED_MODEL_START\n");
process.exitCode = 96;
