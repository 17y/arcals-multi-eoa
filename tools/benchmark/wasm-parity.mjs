// Proves the WebAssembly engine computes exactly what the native worker does.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { RandomXWorkerClient } from "@arcals/randomx-tools";

const root = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../native/randomx-wasm",
);
const createArcalsRandomX = (
  await import(join(root, "build/test/arcals-randomx.mjs"))
).default;
const rx = await createArcalsRandomX();
const hex = (bytes) => `0x${Buffer.from(bytes).toString("hex")}`;
const put = (value) => {
  const bytes = Buffer.from(value.slice(2), "hex");
  const ptr = rx._malloc(bytes.length);
  rx.HEAPU8.set(bytes, ptr);
  return ptr;
};

function wasmHash(epochKey, inputHex) {
  const key = put(epochKey);
  if (rx._arx_prepare(key) !== 0) throw new Error("prepare failed");
  rx._free(key);
  const input = put(inputHex);
  const out = rx._malloc(32);
  rx._arx_hash(input, (inputHex.length - 2) / 2, out);
  const result = hex(rx.HEAPU8.slice(out, out + 32));
  rx._free(input);
  rx._free(out);
  return result;
}

const vector = JSON.parse(
  readFileSync(
    join(root, "../../packages/test-fixtures/randomx/arcals-v2-salt-v1.json"),
    "utf8",
  ),
);
const vectorHash = wasmHash(vector.epochKey, vector.inputBytes);
console.log(
  `official vector: ${vectorHash === vector.arcalsForkHash ? "MATCH" : "MISMATCH"} ${vectorHash}`,
);

// Random keys and inputs, checked against the native worker in light mode.
const native = new RandomXWorkerClient(
  join(root, "../randomx-worker/build/arcals-randomx-worker"),
);
const algorithmId =
  "0x8ca1fa54766ca6df7bcbbb2a8da08bee94dd5ed9f0055f5e90331a9028af77a9";
const parameterDigest = `0x${"22".repeat(32)}`;
let mismatches = 0;
let checked = 0;
const keys = [
  vector.epochKey,
  "0x36c80fe9201e6d2644b5901f0a17e82773d127223e4e6f4ab1c7882677c934de",
  hex(randomBytes(32)),
];
for (const epochKey of keys) {
  await native.request(
    {
      protocolVersion: 1,
      jobId: randomUUID(),
      command: "prepare",
      algorithmId,
      epochKey,
      parameterDigest,
      mode: "light",
      jit: true,
      hardwareAes: true,
      largePages: false,
      secure: true,
      initThreads: 1,
    },
    ["ready"],
    120000,
  );
  for (let i = 0; i < 6; i += 1) {
    const inputHex = hex(randomBytes(40));
    const want = (
      await native.request(
        {
          protocolVersion: 1,
          jobId: randomUUID(),
          command: "hash",
          inputHex,
          mode: "light",
          jit: true,
          hardwareAes: true,
          largePages: false,
          secure: true,
        },
        ["hash"],
        60000,
      )
    ).data.hash;
    const got = wasmHash(epochKey, inputHex);
    checked += 1;
    if (got !== want) {
      mismatches += 1;
      console.log(`MISMATCH key=${epochKey} input=${inputHex}`);
    }
  }
}
await native.close();
console.log(`native parity: ${checked - mismatches}/${checked} identical`);

// Throughput of one WebAssembly instance (one browser worker).
const key = put(
  "0x36c80fe9201e6d2644b5901f0a17e82773d127223e4e6f4ab1c7882677c934de",
);
rx._arx_prepare(key);
const challenge = put(hex(randomBytes(32)));
const never = put(`0x${"00".repeat(32)}`);
const result = rx._malloc(44);
const started = performance.now();
let hashes = 0;
while (performance.now() - started < 15000) {
  rx._arx_search(challenge, never, hashes, 0, 1, 20, result);
  hashes += 20;
}
const seconds = (performance.now() - started) / 1000;
console.log(
  `wasm light interpreter: ${(hashes / seconds).toFixed(1)} H/s per instance (${hashes} hashes / ${seconds.toFixed(1)} s)`,
);
