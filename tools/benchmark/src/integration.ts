import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { RANDOMX_ALGORITHM_ID, buildRandomXInput } from "@arcals/protocol";

import {
  RandomXWorkerClient,
  WorkerProtocolError,
  localWorkerBinaryPath,
} from "./worker-client.js";

const binaryPath = localWorkerBinaryPath(
  fileURLToPath(new URL("../../../", import.meta.url)),
);
const vector = JSON.parse(
  await readFile(
    fileURLToPath(
      new URL(
        "../../../packages/test-fixtures/randomx/arcals-v2-salt-v1.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
) as {
  epochKey: string;
  challengeInput: `0x${string}`;
  workNonce: string;
  inputBytes: `0x${string}`;
  arcalsForkHash: string;
};
const epochKey = vector.epochKey;
const parameterDigest = `0x${"22".repeat(32)}`;
const challengeInput = vector.challengeInput;
const workNonce = BigInt(vector.workNonce);
const inputHex = buildRandomXInput(challengeInput, workNonce);
if (inputHex !== vector.inputBytes)
  throw new Error("RandomX fixture input mismatch");
const expectedHash = vector.arcalsForkHash;

function value(
  message: { data?: Record<string, unknown> },
  key: string,
): unknown {
  const result = message.data?.[key];
  if (result === undefined) throw new Error(`worker response omitted ${key}`);
  return result;
}

const worker = new RandomXWorkerClient(binaryPath);
/** Set so that a failing shutdown cannot hide the failure that caused it. */
let failure: unknown;
try {
  const ready = await worker.request(
    {
      protocolVersion: 1,
      jobId: "integration-prepare",
      command: "prepare",
      algorithmId: RANDOMX_ALGORITHM_ID,
      epochKey,
      parameterDigest,
      mode: "fast",
      jit: true,
      hardwareAes: true,
      largePages: true,
      secure: true,
      initThreads: 4,
    },
    ["ready"],
    60_000,
  );
  const profiles = [
    { jobId: "fast-jit", mode: "fast", jit: true, hardwareAes: true },
    { jobId: "fast-interpreter", mode: "fast", jit: false, hardwareAes: false },
    { jobId: "light-jit", mode: "light", jit: true, hardwareAes: true },
    {
      jobId: "light-interpreter",
      mode: "light",
      jit: false,
      hardwareAes: false,
    },
  ] as const;
  const hashes: Record<string, string> = {};
  for (const profile of profiles) {
    const result = await worker.request(
      {
        protocolVersion: 1,
        jobId: profile.jobId,
        command: "hash",
        inputHex,
        mode: profile.mode,
        jit: profile.jit,
        hardwareAes: profile.hardwareAes,
        largePages: false,
        secure: true,
      },
      ["hash"],
      30_000,
    );
    const hash = String(value(result, "hash"));
    if (hash !== expectedHash) {
      throw new Error(
        `${profile.jobId} produced ${hash}, expected ${expectedHash}`,
      );
    }
    hashes[profile.jobId] = hash;
  }

  let unknownAlgorithmRejected = false;
  try {
    await worker.request(
      {
        protocolVersion: 1,
        jobId: "unknown-algorithm",
        command: "prepare",
        algorithmId: `0x${"ff".repeat(32)}`,
        epochKey,
        parameterDigest,
        mode: "light",
      },
      ["ready"],
    );
  } catch (error) {
    unknownAlgorithmRejected =
      error instanceof WorkerProtocolError && error.code === "INVALID_REQUEST";
  }
  if (!unknownAlgorithmRejected)
    throw new Error("unknown algorithm was accepted");

  let invalidInputRejected = false;
  try {
    await worker.request(
      {
        protocolVersion: 1,
        jobId: "invalid-input",
        command: "hash",
        inputHex: `0x${"55".repeat(39)}`,
      },
      ["hash"],
    );
  } catch (error) {
    invalidInputRejected =
      error instanceof WorkerProtocolError && error.code === "INVALID_REQUEST";
  }
  if (!invalidInputRejected)
    throw new Error("invalid 39-byte input was accepted");

  worker.send({
    protocolVersion: 1,
    jobId: "single-solution",
    command: "search",
    challengeInput,
    target: expectedHash,
    startNonce: workNonce.toString(),
    stride: "1",
    maxHashes: "1",
    threads: "1",
    progressIntervalMs: "100",
  });
  await worker.waitFor("single-solution", ["started"]);
  const solution = await worker.waitFor(
    "single-solution",
    ["solution"],
    30_000,
  );
  if (
    value(solution, "workNonce") !== workNonce.toString() ||
    value(solution, "randomxHash") !== expectedHash
  ) {
    throw new Error("search result differs from direct hash vector");
  }

  worker.send({
    protocolVersion: 1,
    jobId: "target-below-vector",
    command: "search",
    challengeInput,
    target: `0x${(BigInt(expectedHash) - 1n).toString(16).padStart(64, "0")}`,
    startNonce: workNonce.toString(),
    stride: "1",
    maxHashes: "1",
    threads: "1",
    progressIntervalMs: "100",
  });
  await worker.waitFor("target-below-vector", ["started"]);
  const belowTarget = await worker.waitFor(
    "target-below-vector",
    ["exhausted"],
    30_000,
  );
  if (value(belowTarget, "hashesTried") !== "1") {
    throw new Error("big-endian below-target check did not hash exactly once");
  }

  worker.send({
    protocolVersion: 1,
    jobId: "cancel-target",
    command: "search",
    challengeInput,
    target: `0x${"00".repeat(32)}`,
    startNonce: "0",
    stride: "4",
    maxHashes: "100000000",
    maxDurationMs: "10000",
    threads: "4",
    progressIntervalMs: "100",
  });
  await worker.waitFor("cancel-target", ["started"]);
  await new Promise((resolve) => setTimeout(resolve, 150));
  await worker.request(
    {
      protocolVersion: 1,
      jobId: "cancel-request",
      command: "cancel",
      targetJobId: "cancel-target",
    },
    ["cancel-requested"],
  );
  const cancelled = await worker.waitFor("cancel-target", ["cancelled"], 5000);
  if (BigInt(String(value(cancelled, "hashesTried"))) === 0n) {
    throw new Error("cancel test stopped before any RandomX work");
  }

  const secondContext = await worker.request(
    {
      protocolVersion: 1,
      jobId: "second-context",
      command: "prepare",
      algorithmId: RANDOMX_ALGORITHM_ID,
      epochKey: `0x${"44".repeat(32)}`,
      parameterDigest,
      mode: "light",
      jit: true,
      hardwareAes: true,
      largePages: false,
      secure: true,
      initThreads: 4,
    },
    ["ready"],
    30_000,
  );
  const status = await worker.request(
    { protocolVersion: 1, jobId: "status", command: "status" },
    ["status"],
  );
  if (value(status, "cachedContexts") !== "2") {
    throw new Error("worker did not retain two Epoch contexts");
  }

  await worker.close();
  const restarted = new RandomXWorkerClient(binaryPath);
  let restartHash = "";
  try {
    await restarted.request(
      {
        protocolVersion: 1,
        jobId: "restart-prepare",
        command: "prepare",
        algorithmId: RANDOMX_ALGORITHM_ID,
        epochKey,
        parameterDigest,
        mode: "light",
        jit: true,
        hardwareAes: true,
        largePages: false,
        secure: true,
        initThreads: 4,
      },
      ["ready"],
      30_000,
    );
    const restartedHash = await restarted.request(
      {
        protocolVersion: 1,
        jobId: "restart-hash",
        command: "hash",
        inputHex,
        mode: "light",
        jit: true,
        hardwareAes: true,
        largePages: false,
        secure: true,
      },
      ["hash"],
      30_000,
    );
    restartHash = String(value(restartedHash, "hash"));
    if (restartHash !== expectedHash) {
      throw new Error("restarted worker changed the RandomX vector");
    }
  } finally {
    await restarted.close();
  }

  const result = {
    schemaVersion: "1",
    source: "randomx-worker integration",
    architecture: process.arch,
    inputHex,
    expectedHash,
    hashes,
    unknownAlgorithmRejected,
    invalidInputRejected,
    bigEndianTargetBoundary: {
      equal: solution.type,
      oneBelow: belowTarget.type,
    },
    cancellation: {
      result: cancelled.type,
      hashesTried: value(cancelled, "hashesTried"),
    },
    firstContext: ready.data,
    secondContext: secondContext.data,
    cacheStatus: status.data,
    restart: { result: "PASS", hash: restartHash },
    arm64: process.arch === "arm64" ? "PASS" : "NOT_RUN",
  };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  const outputFlag = process.argv.indexOf("--output");
  if (outputFlag !== -1) {
    const outputPath = process.argv[outputFlag + 1];
    if (outputPath === undefined) throw new Error("--output requires a path");
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, serialized);
  }
  process.stdout.write(serialized);
} catch (error) {
  failure = error;
  throw error;
} finally {
  try {
    await worker.close();
  } catch (error) {
    if (failure === undefined) throw error;
    console.error(`worker shutdown after failure: ${String(error)}`);
  }
}
