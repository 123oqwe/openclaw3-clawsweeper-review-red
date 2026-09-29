import fs from "node:fs";
// Test-only Node/curl transport. It cannot reach production, and does not emulate
// queue transitions, canonical writes, comment receipts, or bundle validation.
const base = process.env.MANUAL_PUBLICATION_LOOPBACK;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base || "")) throw new Error("loopback fixture required");
const request = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const original = new Request(input, init);
  const url = new URL(original.url);
  if (url.origin !== "https://manual-queue.invalid")
    throw new Error(`proof refused outbound URL: ${url.origin}`);
  return request(new Request(`${base}/queue${url.pathname}${url.search}`, original));
};
if (process.argv[2] === "curl") {
  const args = process.argv.slice(3);
  const headers = {};
  let method = "GET";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--header") {
      const [key, ...value] = args[++i].split(":");
      headers[key] = value.join(":").trim();
    } else if (args[i] === "--request") method = args[++i];
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const dataIndex = args.indexOf("--data-binary");
  const options = { method, headers };
  if (dataIndex !== -1) {
    if (["GET", "HEAD"].includes(method.toUpperCase()))
      throw new Error("fixture curl cannot send a body with GET or HEAD");
    const data = args[dataIndex + 1];
    if (data === undefined) throw new Error("fixture curl requires data after --data-binary");
    options.body = data === "@-" ? Buffer.concat(chunks) : data;
  }
  const response = await fetch(args.at(-1), options);
  const responseBody = await response.text();
  const failsHttp = !response.ok && (args.includes("--fail") || args.includes("--fail-with-body"));
  const visibleBody = failsHttp && args.includes("--fail") ? "" : responseBody;
  const confinedOutput = (path) => {
    if (typeof path !== "string" || !path.startsWith(process.env.RUNNER_TEMP + "/"))
      throw new Error("fixture curl output must remain in RUNNER_TEMP");
    return path;
  };
  if (args.includes("--dump-header")) {
    const target = confinedOutput(args[args.indexOf("--dump-header") + 1]);
    fs.writeFileSync(target, `HTTP/1.1 ${response.status} ${response.statusText}\r\n${[...response.headers].map(([name, value]) => `${name}: ${value}\r\n`).join("")}\r\n`);
  }
  if (!args.includes("--output")) process.stdout.write(visibleBody);
  else if (args[args.indexOf("--output") + 1] !== "/dev/null") {
    const output = confinedOutput(args[args.indexOf("--output") + 1]);
    fs.writeFileSync(output, visibleBody);
  }
  if (args.includes("--write-out")) process.stdout.write(String(response.status));
  if (failsHttp) process.exitCode = 22;
}
