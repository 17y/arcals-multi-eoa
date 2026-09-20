// Drives the shipped browser Worker (randomx-browser-worker.mjs) exactly as
// the website does: verified WebAssembly bytes in a START message, N Workers
// splitting the nonce space, terminate() on the first SOLUTION. Every
// solution is checked against the native worker.
//
//   node tools/benchmark/wasm-worker-test.mjs [workers] [rounds]
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { RandomXWorkerClient } from "@arcals/randomx-tools";

const root = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../native/randomx-wasm",
);
const scriptPath = join(root, "dist/randomx-browser-worker.mjs");
const wasm = readFileSync(join(root, "dist/randomx-browser.wasm"));
const sums = Object.fromEntries(
  readFileSync(join(root, "dist/SHA256SUMS"), "utf8")
    .trim()
    .split("\n")
    .map((line) => line.split(/\s+/).reverse()),
);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (
  sha(readFileSync(scriptPath)) !== sums["randomx-browser-worker.mjs"] ||
  sha(wasm) !== sums["randomx-browser.wasm"]
) {
  throw new Error("dist files do not match SHA256SUMS");
}

const ALGORITHM_ID =
  "0x8ca1fa54766ca6df7bcbbb2a8da08bee94dd5ed9f0055f5e90331a9028af77a9";
const PARAMETER_DIGEST =
  "0x207c0c80715507e7133d2b79d6067d774c24a06c3f2cf46a63f1dfdf74fab8f1";
const epochKey =
  "0x36c80fe9201e6d2644b5901f0a17e82773d127223e4e6f4ab1c7882677c934de";
// Epoch 3 production Target: 320 expected hashes.
const target =
  "361850278866613110698659328152149712041468702080126762623304950024728530123";
const hex = (bytes) => `0x${Buffer.from(bytes).toString("hex")}`;
const workers = Number(process.argv[2] ?? 4);
const rounds = Number(process.argv[3] ?? 4);

function spawn() {
  return new Worker(join(root, "test/node-worker-bootstrap.mjs"), {
    workerData: { scriptPath },
  });
}

/** Runs one job across `count` Workers; resolves with every message seen. */
function job(overrides, count) {
  const jobId = randomUUID();
  const start = {
    type: "START",
    protocolVersion: 1,
    jobId,
    algorithmId: ALGORITHM_ID,
    parameterDigest: PARAMETER_DIGEST,
    target,
    epochKey,
    challengeInput: hex(randomBytes(32)),
    expiresAt: String(Math.floor(Date.now() / 1000) + 900),
    ...overrides,
  };
  const pool = Array.from({ length: count }, spawn);
  const started = performance.now();
  return new Promise((resolve) => {
    const seen = [];
    const finish = (outcome) => {
      for (const worker of pool) void worker.terminate();
      resolve({ ...outcome, start, seen, wallMs: performance.now() - started });
    };
    let errors = 0;
    pool.forEach((worker, index) => {
      worker.on("message", (message) => {
        seen.push(message);
        if (message.jobId !== jobId || message.protocolVersion !== 1) {
          finish({ bad: message });
        } else if (message.type === "SOLUTION") {
          finish({ solution: message });
        } else if (message.type === "ERROR" && (errors += 1) === count) {
          finish({ error: message });
        }
      });
      worker.postMessage({
        ...start,
        wasmBytes: new Uint8Array(wasm),
        startNonce: String(index),
        stride: count,
      });
    });
  });
}

const native = new RandomXWorkerClient(
  join(root, "../randomx-worker/build/arcals-randomx-worker"),
);
await native.request(
  {
    protocolVersion: 1,
    jobId: randomUUID(),
    command: "prepare",
    algorithmId: ALGORITHM_ID,
    epochKey,
    parameterDigest: PARAMETER_DIGEST,
    mode: "fast",
    jit: true,
    hardwareAes: true,
    largePages: false,
    secure: true,
    initThreads: 8,
  },
  ["ready"],
  600_000,
);

let failures = 0;
for (let round = 0; round < rounds; round += 1) {
  const outcome = await job({}, workers);
  if (outcome.solution === undefined) {
    failures += 1;
    console.log(`round ${round}: no solution`, outcome.error ?? outcome.bad);
    continue;
  }
  const { workNonce, randomxHash, hashesTried } = outcome.solution;
  const input = Buffer.alloc(40);
  Buffer.from(outcome.start.challengeInput.slice(2), "hex").copy(input);
  input.writeBigUInt64LE(BigInt(workNonce), 32);
  const want = (
    await native.request(
      {
        protocolVersion: 1,
        jobId: randomUUID(),
        command: "hash",
        inputHex: hex(input),
        mode: "fast",
        jit: true,
        hardwareAes: true,
        largePages: false,
        secure: true,
      },
      ["hash"],
      60_000,
    )
  ).data.hash;
  const agrees = want === randomxHash && BigInt(want) <= BigInt(target);
  const nonceOwner = Number(BigInt(workNonce) % BigInt(workers));
  const ready = outcome.seen.filter((m) => m.type === "READY").length;
  if (!agrees) failures += 1;
  console.log(
    `round ${round}: nonce ${workNonce} (worker ${nonceOwner}, ${hashesTried} hashes there) in ${(outcome.wallMs / 1000).toFixed(1)} s, ${ready} READY — native ${agrees ? "AGREES" : "DISAGREES"}`,
  );
}

const expectError = async (name, overrides, code) => {
  const outcome = await job(overrides, 1);
  const ok = outcome.error?.code === code;
  if (!ok) failures += 1;
  console.log(
    `${name}: ${outcome.error?.code ?? "no error"}${ok ? "" : ` (expected ${code})`}`,
  );
};
await expectError(
  "foreign parameters",
  { parameterDigest: `0x${"33".repeat(32)}` },
  "PARAMETERS_MISMATCH",
);
await expectError(
  "expired challenge",
  { expiresAt: String(Math.floor(Date.now() / 1000)) },
  "CHALLENGE_EXPIRED",
);
await expectError("bad protocol", { protocolVersion: 2 }, "INVALID_START");
await expectError("bad target", { target: "0" }, "INVALID_START");

await native.close();
console.log(failures === 0 ? "WORKER TEST PASSED" : "WORKER TEST FAILED");
process.exit(failures === 0 ? 0 : 1);
