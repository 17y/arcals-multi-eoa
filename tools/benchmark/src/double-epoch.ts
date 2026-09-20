import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { RANDOMX_ALGORITHM_ID } from "@arcals/protocol";

import { RandomXWorkerClient, localWorkerBinaryPath } from "./worker-client.js";

const binaryPath = localWorkerBinaryPath(
  fileURLToPath(new URL("../../../", import.meta.url)),
);
const parameterDigest = `0x${"82".repeat(32)}`;
const worker = new RandomXWorkerClient(binaryPath);

try {
  const prepare = async (jobId: string, byte: string) =>
    worker.request(
      {
        protocolVersion: 1,
        jobId,
        command: "prepare",
        algorithmId: RANDOMX_ALGORITHM_ID,
        epochKey: `0x${byte.repeat(32)}`,
        parameterDigest,
        mode: "fast",
        jit: true,
        hardwareAes: true,
        largePages: true,
        secure: true,
        initThreads: 8,
      },
      ["ready"],
      90_000,
    );
  const first = await prepare("double-epoch-first", "91");
  const afterFirst = await worker.request(
    { protocolVersion: 1, jobId: "after-first", command: "status" },
    ["status"],
  );
  const second = await prepare("double-epoch-second", "a2");
  const afterSecond = await worker.request(
    { protocolVersion: 1, jobId: "after-second", command: "status" },
    ["status"],
  );
  if (afterSecond.data?.cachedContexts !== "2") {
    throw new Error("double-Epoch run did not retain two Fast contexts");
  }
  const report = {
    schemaVersion: "1",
    task: "randomx-double-epoch",
    mode: "local-memory-evidence",
    productionCapacityClaim: false,
    architecture: process.arch,
    first: first.data,
    afterFirst: afterFirst.data,
    second: second.data,
    afterSecond: afterSecond.data,
    note: "This proves the reference host can hold two Fast contexts; it is not an end-user minimum or production capacity claim.",
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const outputFlag = process.argv.indexOf("--output");
  if (outputFlag !== -1) {
    const outputPath = process.argv[outputFlag + 1];
    if (outputPath === undefined) throw new Error("--output requires a path");
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, serialized);
  }
  process.stdout.write(serialized);
} finally {
  await worker.close();
}
