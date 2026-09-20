// Runs the engine in real headless Chromium with real Web Workers and checks
// every solution against the native worker.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { RandomXWorkerClient } from "@arcals/randomx-tools";

const root = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../native/randomx-wasm",
);
// Playwright is not a dependency of this repository; point PLAYWRIGHT_CORE at
// an installed playwright-core and CHROMIUM_PATH at a Chromium binary.
const playwright = await import(
  process.env.PLAYWRIGHT_CORE ?? "playwright-core"
);
// playwright-core is CommonJS: its API may sit on the default export.
const chromium = playwright.chromium ?? playwright.default.chromium;
const types = {
  ".html": "text/html",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
};
const server = createServer((request, response) => {
  const path = new URL(request.url, "http://x").pathname;
  const file =
    path === "/"
      ? join(root, "test/browser-page.html")
      : join(root, "dist", path.slice(1));
  let body;
  try {
    body = readFileSync(file);
  } catch {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, {
    "content-type": types[extname(file)] ?? "application/octet-stream",
  });
  response.end(body);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const workers = Number(process.argv[2] ?? 4);
const rounds = Number(process.argv[3] ?? 5);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
});
const page = await browser.newPage();
page.on("pageerror", (error) => console.log("page error:", error.message));
await page.goto(
  `http://127.0.0.1:${port}/?workers=${workers}&rounds=${rounds}`,
);
await page.waitForFunction(() => window.__result !== undefined, null, {
  timeout: 1_800_000,
});
const result = await page.evaluate(() => window.__result);
await browser.close();
server.close();
if (!result.ok) {
  console.log("BROWSER FAILED", result.error);
  process.exit(1);
}
console.log(
  `${result.userAgent.match(/Chrome\/[0-9.]+/)?.[0]} on ${result.cores} cores, ${result.workers} workers`,
);

const native = new RandomXWorkerClient(
  join(root, "../randomx-worker/build/arcals-randomx-worker"),
);
const epochKey =
  "0x36c80fe9201e6d2644b5901f0a17e82773d127223e4e6f4ab1c7882677c934de";
const target = BigInt(
  "361850278866613110698659328152149712041468702080126762623304950024728530123",
);
await native.request(
  {
    protocolVersion: 1,
    jobId: randomUUID(),
    command: "prepare",
    epochKey,
    algorithmId:
      "0x8ca1fa54766ca6df7bcbbb2a8da08bee94dd5ed9f0055f5e90331a9028af77a9",
    parameterDigest: `0x${"22".repeat(32)}`,
    mode: "fast",
    jit: true,
    hardwareAes: true,
    largePages: false,
    secure: true,
    initThreads: 8,
  },
  ["ready"],
  600000,
);
let failures = 0;
let hashes = 0;
let computeMs = 0;
for (const [index, r] of result.results.entries()) {
  const input = Buffer.alloc(40);
  Buffer.from(r.challengeInput.slice(2), "hex").copy(input);
  input.writeBigUInt64LE(BigInt(r.workNonce), 32);
  const want = (
    await native.request(
      {
        protocolVersion: 1,
        jobId: randomUUID(),
        command: "hash",
        inputHex: `0x${input.toString("hex")}`,
        mode: "fast",
        jit: true,
        hardwareAes: true,
        largePages: false,
        secure: true,
      },
      ["hash"],
      60000,
    )
  ).data.hash;
  const agrees = want === r.randomxHash && BigInt(want) <= target;
  if (!agrees) failures += 1;
  // Each Worker reports only its own count; nonces are dense across Workers,
  // so the winning nonce + 1 approximates the work done by all of them.
  hashes += Number(r.workNonce) + 1;
  computeMs += r.wallMs - r.prepareMs;
  console.log(
    `round ${index}: nonce ${r.workNonce} (${r.hashesTried} on the winning Worker), ${(r.wallMs / 1000).toFixed(1)} s (prepare ${(r.prepareMs / 1000).toFixed(1)} s) — native ${agrees ? "AGREES" : "DISAGREES"}`,
  );
}
await native.close();
console.log(
  `browser aggregate: ${(hashes / (computeMs / 1000)).toFixed(2)} H/s with ${result.workers} workers`,
);
console.log(failures === 0 ? "BROWSER TEST PASSED" : "BROWSER TEST FAILED");
process.exit(failures === 0 ? 0 : 1);
