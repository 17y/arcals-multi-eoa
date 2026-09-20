// Large differential test: WebAssembly RandomX vs the native worker.
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";

import { RandomXWorkerClient } from "@arcals/randomx-tools";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const hex = (bytes) => `0x${Buffer.from(bytes).toString("hex")}`;

if (!isMainThread) {
  const create = (
    await import(
      join(repo, "native/randomx-wasm/build/test/arcals-randomx.mjs")
    )
  ).default;
  const rx = await create();
  const put = (value) => {
    const b = Buffer.from(value.slice(2), "hex");
    const p = rx._malloc(b.length);
    rx.HEAPU8.set(b, p);
    return p;
  };
  const key = put(workerData.epochKey);
  rx._arx_prepare(key);
  const out = rx._malloc(32);
  const results = [];
  for (const inputHex of workerData.inputs) {
    const input = put(inputHex);
    rx._arx_hash(input, 40, out);
    rx._free(input);
    results.push(hex(rx.HEAPU8.slice(out, out + 32)));
  }
  parentPort.postMessage(results);
} else {
  const total = Number(process.argv[2] ?? 20000);
  const threads = Number(process.argv[3] ?? 24);
  const keys = [
    "0x36c80fe9201e6d2644b5901f0a17e82773d127223e4e6f4ab1c7882677c934de",
    hex(randomBytes(32)),
  ];
  const native = new RandomXWorkerClient(
    join(repo, "native/randomx-worker/build/arcals-randomx-worker"),
  );
  let checked = 0;
  let mismatches = 0;
  const started = Date.now();
  for (const epochKey of keys) {
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
    const inputs = Array.from({ length: total / keys.length }, () =>
      hex(randomBytes(40)),
    );
    const expected = [];
    for (const inputHex of inputs) {
      expected.push(
        (
          await native.request(
            {
              protocolVersion: 1,
              jobId: randomUUID(),
              command: "hash",
              inputHex,
              mode: "fast",
              jit: true,
              hardwareAes: true,
              largePages: false,
              secure: true,
            },
            ["hash"],
            60000,
          )
        ).data.hash,
      );
    }
    const chunk = Math.ceil(inputs.length / threads);
    const parts = await Promise.all(
      Array.from(
        { length: threads },
        (_, t) =>
          new Promise((resolve, reject) => {
            const worker = new Worker(fileURLToPath(import.meta.url), {
              workerData: {
                epochKey,
                inputs: inputs.slice(t * chunk, (t + 1) * chunk),
              },
            });
            worker.once("message", resolve);
            worker.once("error", reject);
          }),
      ),
    );
    parts.flat().forEach((got, index) => {
      checked += 1;
      if (got !== expected[index]) {
        mismatches += 1;
        if (mismatches <= 5)
          console.log(`MISMATCH key=${epochKey} input=${inputs[index]}`);
      }
    });
    console.log(
      `key ${epochKey.slice(0, 10)}…: ${checked} checked, ${mismatches} mismatches, ${Math.round((Date.now() - started) / 1000)} s`,
    );
  }
  await native.close();
  console.log(`RESULT ${checked - mismatches}/${checked} identical`);
  process.exit(mismatches === 0 ? 0 : 1);
}
