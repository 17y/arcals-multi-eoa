import { randomUUID } from "node:crypto";

import { UINT64_MAX } from "@arcals/protocol";
import type { Bytes32, ConfigDto } from "@arcals/protocol";
import { RandomXWorkerClient, type WorkerMessage } from "@arcals/randomx-tools";
import { toHex } from "viem";

export interface MiningProgress {
  readonly hashesTried: string;
  readonly elapsedMs: string;
  readonly hashRate: string;
}

export interface MiningSolution extends MiningProgress {
  readonly workNonce: bigint;
  readonly randomxHash: Bytes32;
}

export interface MineRequest {
  readonly challengeInput: Bytes32;
  readonly config: NonNullable<ConfigDto["workConfig"]>;
  readonly epoch: NonNullable<ConfigDto["epoch"]>;
  readonly threads: number;
  readonly expiresAt: bigint;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: MiningProgress) => void;
}

export interface RandomXMiner {
  mine(request: MineRequest): Promise<MiningSolution>;
  close(): Promise<void>;
}

function field(message: WorkerMessage, key: string): string {
  const value = message.data?.[key];
  if (typeof value !== "string") {
    throw new Error(`RandomX worker response omitted ${key}`);
  }
  return value;
}

function progress(message: WorkerMessage): MiningProgress {
  return {
    hashesTried: field(message, "hashesTried"),
    elapsedMs: field(message, "elapsedMs"),
    hashRate: field(message, "hashRate"),
  };
}

export class RealRandomXMiner implements RandomXMiner {
  private worker: RandomXWorkerClient | null = null;
  private preparedKey: string | null = null;

  constructor(readonly binaryPath: string) {}

  async mine(request: MineRequest): Promise<MiningSolution> {
    if (!Number.isInteger(request.threads) || request.threads <= 0) {
      throw new RangeError("RandomX threads must be a positive integer");
    }
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (request.expiresAt <= now + 5n) {
      throw new Error(
        "CHALLENGE_EXPIRED: too little TTL remains to start work",
      );
    }
    const worker = this.worker ?? new RandomXWorkerClient(this.binaryPath);
    this.worker = worker;
    const preparedKey = `${request.epoch.epochKey}:${request.config.parameterDigest}`;
    if (this.preparedKey !== preparedKey) {
      await worker.request(
        {
          protocolVersion: 1,
          jobId: randomUUID(),
          command: "prepare",
          algorithmId: request.config.algorithmId,
          epochKey: request.epoch.epochKey,
          parameterDigest: request.config.parameterDigest,
          mode: "fast",
          jit: true,
          hardwareAes: true,
          largePages: true,
          secure: true,
          initThreads: request.threads,
        },
        ["ready"],
        120_000,
      );
      this.preparedKey = preparedKey;
    }

    const jobId = randomUUID();
    const maximumDurationMs = Number(
      (request.expiresAt - BigInt(Math.floor(Date.now() / 1000)) - 3n) * 1000n,
    );
    worker.send({
      protocolVersion: 1,
      jobId,
      command: "search",
      challengeInput: request.challengeInput,
      target: toHex(BigInt(request.config.target), { size: 32 }),
      startNonce: "0",
      stride: request.threads.toString(),
      maxHashes: UINT64_MAX.toString(),
      maxDurationMs: Math.max(maximumDurationMs, 1).toString(),
      threads: request.threads.toString(),
      progressIntervalMs: "1000",
    });
    await worker.waitFor(jobId, ["started"], 10_000);

    let cancelRequested = false;
    const cancel = (): void => {
      if (cancelRequested) return;
      cancelRequested = true;
      void worker.request(
        {
          protocolVersion: 1,
          jobId: randomUUID(),
          command: "cancel",
          targetJobId: jobId,
        },
        ["cancel-requested"],
        5000,
      );
    };
    request.signal?.addEventListener("abort", cancel, { once: true });
    if (request.signal?.aborted) cancel();
    try {
      for (;;) {
        const message = await worker.waitFor(
          jobId,
          ["progress", "solution", "exhausted", "cancelled"],
          Math.max(maximumDurationMs + 10_000, 10_000),
        );
        if (message.type === "progress") {
          request.onProgress?.(progress(message));
          continue;
        }
        if (message.type === "solution") {
          return {
            ...progress(message),
            workNonce: BigInt(field(message, "workNonce")),
            randomxHash: field(message, "randomxHash") as Bytes32,
          };
        }
        if (message.type === "cancelled") {
          throw new Error("RandomX search was cancelled");
        }
        throw new Error("RandomX search exhausted its bounded work window");
      }
    } finally {
      request.signal?.removeEventListener("abort", cancel);
    }
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.preparedKey = null;
    await worker?.close();
  }
}
