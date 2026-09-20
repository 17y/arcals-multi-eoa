import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import {
  arch,
  cpus,
  freemem,
  hostname,
  platform,
  release,
  totalmem,
} from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { RANDOMX_ALGORITHM_ID } from "@arcals/protocol";

import { deriveTargetFromMeasurement } from "./target.js";
import { RandomXWorkerClient, localWorkerBinaryPath } from "./worker-client.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const binaryPath = localWorkerBinaryPath(repositoryRoot);
const epochKey = `0x${"51".repeat(32)}`;
const parameterDigest = `0x${"62".repeat(32)}`;
const challengeInput = `0x${"73".repeat(32)}`;

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

function field(
  message: { data?: Record<string, unknown> },
  name: string,
): string {
  const value = message.data?.[name];
  if (typeof value !== "string") throw new Error(`worker omitted ${name}`);
  return value;
}

async function digest(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

const durationMs = Number.parseInt(argument("--duration-ms", "5000"), 10);
const threadCount = Number.parseInt(argument("--threads", "4"), 10);
if (
  !Number.isInteger(durationMs) ||
  durationMs < 1000 ||
  durationMs > 60_000 ||
  !Number.isInteger(threadCount) ||
  threadCount < 1 ||
  threadCount > 256
) {
  throw new RangeError("duration must be 1000..60000ms and threads 1..256");
}

const worker = new RandomXWorkerClient(binaryPath);
try {
  const prepare = async (jobId: string) =>
    worker.request(
      {
        protocolVersion: 1,
        jobId,
        command: "prepare",
        algorithmId: RANDOMX_ALGORITHM_ID,
        epochKey,
        parameterDigest,
        mode: "fast",
        jit: true,
        hardwareAes: true,
        largePages: true,
        secure: true,
        initThreads: threadCount,
      },
      ["ready"],
      60_000,
    );
  const run = async (jobId: string, startNonce: bigint) => {
    worker.send({
      protocolVersion: 1,
      jobId,
      command: "search",
      challengeInput,
      target: `0x${"00".repeat(32)}`,
      startNonce: startNonce.toString(),
      stride: String(threadCount),
      maxHashes: "18446744073709551615",
      maxDurationMs: String(durationMs),
      threads: String(threadCount),
      progressIntervalMs: "1000",
    });
    await worker.waitFor(jobId, ["started"]);
    const result = await worker.waitFor(
      jobId,
      ["exhausted", "solution"],
      durationMs + 10_000,
    );
    const hashes = BigInt(field(result, "hashesTried"));
    const elapsedMs = BigInt(field(result, "elapsedMs"));
    return {
      result: result.type,
      hashes: hashes.toString(),
      elapsedMs: elapsedMs.toString(),
      hashRate: field(result, "hashRate"),
      derivedTargetFor120Seconds: deriveTargetFromMeasurement(
        hashes,
        elapsedMs * 1_000_000n,
      ).targetHex,
    };
  };

  const coldPrepare = await prepare("benchmark-cold-prepare");
  const cold = await run("benchmark-cold", 0n);
  const warmPrepare = await prepare("benchmark-warm-prepare");
  const warm = await run("benchmark-warm", 1_000_000_000n);
  const status = await worker.request(
    { protocolVersion: 1, jobId: "benchmark-status", command: "status" },
    ["status"],
  );
  const cpu = cpus()[0];
  const report = {
    schemaVersion: "1",
    task: "randomx-benchmark",
    mode: "local-reference-benchmark",
    productionTargetFrozen: false,
    g2Status: "OPEN",
    createdAt: new Date().toISOString(),
    source: {
      upstreamVersion: "2.0.1",
      upstreamCommit: "aaafe71322df6602c21a5c72937ac284724ae561",
      salt: "Arcals-RandomX-v1",
      patchSha256: await digest(
        `${repositoryRoot}native/randomx-worker/patches/0001-arcals-argon-salt.patch`,
      ),
      binarySha256: await digest(binaryPath),
    },
    host: {
      hostname: hostname(),
      platform: platform(),
      release: release(),
      architecture: arch(),
      logicalCpus: cpus().length,
      cpuModel: cpu?.model ?? "unknown",
      totalMemoryBytes: totalmem().toString(),
      freeMemoryBytesAtReport: freemem().toString(),
    },
    settings: {
      threads: threadCount,
      durationMs,
      mode: "fast",
      v2: true,
      jitRequested: true,
      hardwareAesRequested: true,
      largePagesRequested: true,
    },
    cold: {
      prepare: coldPrepare.data,
      search: cold,
    },
    warm: {
      prepare: warmPrepare.data,
      search: warm,
    },
    finalStatus: status.data,
    targetInterpretation:
      "Warm four-thread result is this host only; low/medium/high reference classes are still required before freezing Target.",
    arm64: arch() === "arm64" ? "PASS" : "NOT_RUN",
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
