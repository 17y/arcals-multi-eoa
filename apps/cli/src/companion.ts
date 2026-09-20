import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { EpochDto, WorkConfigDto } from "@arcals/protocol";

import type { MineRequest, RandomXMiner } from "./randomx-miner.js";
import type { AgentEnvironmentManifest } from "./types.js";

/**
 * The Compute Companion lets a web page that holds a browser wallet run
 * RandomX work on this machine. It only computes: it never sees a wallet key,
 * an Arcals API session or a transaction, and it only accepts work whose
 * parameters match the trusted manifest.
 */

export const COMPANION_PROTOCOL_VERSION = 1;
export const COMPANION_DEFAULT_PORT = 39093;
export const COMPANION_DEFAULT_ORIGINS: readonly string[] = [
  "https://arcals.fun",
  "https://www.arcals.fun",
];

const MAX_BODY_BYTES = 32 * 1024;
/** Unfinished jobs one Companion accepts at once. */
const MAX_PENDING_JOBS = 8;
/** Finished jobs are kept this long so a page can still read the result. */
const FINISHED_RETENTION_MS = 10 * 60_000;
/** A challenge needs at least this much life left to be worth starting. */
const MIN_START_SECONDS = 5n;
const UINT256_LIMIT = 1n << 256n;

export type CompanionJobStatus =
  | "QUEUED"
  | "COMPUTING"
  | "SOLUTION_FOUND"
  | "FAILED"
  | "EXPIRED"
  | "CANCELLED";

interface WorkRequest {
  readonly challengeInput: `0x${string}`;
  readonly epochKey: `0x${string}`;
  readonly target: string;
  readonly expiresAt: bigint;
}

interface CompanionJob {
  readonly jobId: string;
  /** Identical work maps to one job, so a reloaded page resumes it. */
  readonly workKey: string;
  readonly request: WorkRequest;
  readonly controller: AbortController;
  status: CompanionJobStatus;
  hashesTried: string;
  elapsedMs: string;
  hashRate: string;
  workNonce: string | null;
  randomxHash: string | null;
  error: string | null;
  finishedAt: number | null;
}

export interface CompanionOptions {
  readonly manifest: AgentEnvironmentManifest;
  readonly miner: RandomXMiner;
  readonly threads: number;
  readonly origins?: readonly string[];
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function bytes32(value: unknown, label: string): `0x${string}` {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(value)) {
    throw new RequestError(400, `${label} must be bytes32`);
  }
  return value.toLowerCase() as `0x${string}`;
}

function decimal(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new RequestError(400, `${label} must be an unsigned decimal string`);
  }
  return BigInt(value);
}

function isTerminal(status: CompanionJobStatus): boolean {
  return status !== "QUEUED" && status !== "COMPUTING";
}

export class CompanionJobs {
  private readonly jobs = new Map<string, CompanionJob>();
  private running: CompanionJob | null = null;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly options: CompanionOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
  }

  /** Validates a work request against the trusted manifest. */
  parse(body: unknown): WorkRequest {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new RequestError(400, "job body must be a JSON object");
    }
    const input = body as Record<string, unknown>;
    const worker = this.options.manifest.worker;
    const algorithmId = bytes32(input.algorithmId, "algorithmId");
    const parameterDigest = bytes32(input.parameterDigest, "parameterDigest");
    if (
      algorithmId !== worker.algorithmId.toLowerCase() ||
      parameterDigest !== worker.parameterDigest.toLowerCase()
    ) {
      throw new RequestError(
        400,
        "work parameters do not match the trusted Arcals manifest",
      );
    }
    const target = decimal(input.target, "target");
    if (target === 0n || target >= UINT256_LIMIT) {
      throw new RequestError(400, "target must be a non-zero uint256");
    }
    const expiresAt = decimal(input.expiresAt, "expiresAt");
    if (expiresAt <= this.seconds() + MIN_START_SECONDS) {
      throw new RequestError(400, "challenge expires too soon to start work");
    }
    return {
      challengeInput: bytes32(input.challengeInput, "challengeInput"),
      epochKey: bytes32(input.epochKey, "epochKey"),
      target: target.toString(),
      expiresAt,
    };
  }

  submit(request: WorkRequest): CompanionJob {
    this.prune();
    const workKey = `${request.challengeInput}:${request.epochKey}:${request.target}`;
    for (const job of this.jobs.values()) {
      // A page that reloads receives the same Challenge back from the API;
      // point it at the work already under way instead of starting over.
      if (
        job.workKey === workKey &&
        (job.status === "QUEUED" ||
          job.status === "COMPUTING" ||
          job.status === "SOLUTION_FOUND")
      ) {
        return job;
      }
    }
    const pending = [...this.jobs.values()].filter(
      (job) => !isTerminal(job.status),
    ).length;
    if (pending >= MAX_PENDING_JOBS) {
      throw new RequestError(429, "too many unfinished compute jobs");
    }
    const job: CompanionJob = {
      jobId: randomUUID(),
      workKey,
      request,
      controller: new AbortController(),
      status: "QUEUED",
      hashesTried: "0",
      elapsedMs: "0",
      hashRate: "0",
      workNonce: null,
      randomxHash: null,
      error: null,
      finishedAt: null,
    };
    this.jobs.set(job.jobId, job);
    this.log(`job ${job.jobId} queued`);
    void this.pump();
    return job;
  }

  get(jobId: string): CompanionJob | undefined {
    return this.jobs.get(jobId);
  }

  /** Stops a job; a running search is cancelled inside the worker. */
  cancel(jobId: string): CompanionJob | undefined {
    const job = this.jobs.get(jobId);
    if (job === undefined || isTerminal(job.status)) return job;
    if (job.status === "QUEUED") {
      this.finish(job, "CANCELLED", null);
    } else {
      job.controller.abort();
    }
    return job;
  }

  /** Cancels everything, for shutdown. */
  cancelAll(): void {
    for (const job of this.jobs.values()) this.cancel(job.jobId);
  }

  private seconds(): bigint {
    return BigInt(Math.floor(this.now() / 1000));
  }

  private finish(
    job: CompanionJob,
    status: CompanionJobStatus,
    error: string | null,
  ): void {
    job.status = status;
    job.error = error;
    job.finishedAt = this.now();
    this.log(`job ${job.jobId} ${status.toLowerCase()}`);
  }

  private prune(): void {
    const cutoff = this.now() - FINISHED_RETENTION_MS;
    for (const [jobId, job] of this.jobs) {
      if (job.finishedAt !== null && job.finishedAt < cutoff) {
        this.jobs.delete(jobId);
      }
    }
  }

  private async pump(): Promise<void> {
    if (this.running !== null) return;
    const next = [...this.jobs.values()].find((job) => job.status === "QUEUED");
    if (next === undefined) return;
    this.running = next;
    try {
      if (next.request.expiresAt <= this.seconds() + MIN_START_SECONDS) {
        this.finish(next, "EXPIRED", "challenge expired while queued");
        return;
      }
      next.status = "COMPUTING";
      // The miner reads only these fields of the work config and Epoch.
      const request: MineRequest = {
        challengeInput: next.request.challengeInput,
        config: {
          algorithmId: this.options.manifest.worker.algorithmId,
          parameterDigest: this.options.manifest.worker.parameterDigest,
          target: next.request.target,
        } as WorkConfigDto,
        epoch: { epochKey: next.request.epochKey } as EpochDto,
        threads: this.options.threads,
        expiresAt: next.request.expiresAt,
        signal: next.controller.signal,
        onProgress: (progress) => {
          next.hashesTried = progress.hashesTried;
          next.elapsedMs = progress.elapsedMs;
          next.hashRate = progress.hashRate;
        },
      };
      const solution = await this.options.miner.mine(request);
      next.hashesTried = solution.hashesTried;
      next.elapsedMs = solution.elapsedMs;
      next.hashRate = solution.hashRate;
      next.workNonce = solution.workNonce.toString();
      next.randomxHash = solution.randomxHash;
      this.finish(next, "SOLUTION_FOUND", null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (next.controller.signal.aborted) {
        this.finish(next, "CANCELLED", null);
      } else if (next.request.expiresAt <= this.seconds()) {
        this.finish(next, "EXPIRED", message);
      } else {
        this.finish(next, "FAILED", message);
      }
    } finally {
      this.running = null;
      void this.pump();
    }
  }
}

function jobView(job: CompanionJob): Record<string, unknown> {
  return {
    jobId: job.jobId,
    status: job.status,
    hashesTried: job.hashesTried,
    elapsedMs: job.elapsedMs,
    hashRate: job.hashRate,
    expiresAt: job.request.expiresAt.toString(),
    ...(job.workNonce === null ? {} : { workNonce: job.workNonce }),
    ...(job.randomxHash === null ? {} : { randomxHash: job.randomxHash }),
    ...(job.error === null ? {} : { error: job.error }),
  };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new RequestError(413, "request body exceeds 32 KiB");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new RequestError(400, "request body must be JSON");
  }
}

export function createCompanionServer(options: CompanionOptions): {
  readonly server: Server;
  readonly jobs: CompanionJobs;
} {
  const origins = new Set(options.origins ?? COMPANION_DEFAULT_ORIGINS);
  const jobs = new CompanionJobs(options);
  const worker = options.manifest.worker;

  const server = createServer((request, response) => {
    void handle(request, response);
  });

  function send(
    response: ServerResponse,
    status: number,
    body: unknown,
    origin: string | undefined,
  ): void {
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(origin === undefined
        ? {}
        : { "access-control-allow-origin": origin, vary: "Origin" }),
    });
    response.end(JSON.stringify(body));
  }

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const port = (server.address() as AddressInfo | null)?.port;
    // A page on another site can point its own hostname at 127.0.0.1 (DNS
    // rebinding) and would then look same-origin; only loopback names count.
    const host = request.headers.host;
    if (
      port === undefined ||
      (host !== `127.0.0.1:${port.toString()}` &&
        host !== `localhost:${port.toString()}`)
    ) {
      send(response, 403, { error: "Host is not allowed." }, undefined);
      return;
    }
    // Browsers always send Origin on cross-origin writes, so a foreign site is
    // refused before anything runs. Clients without Origin are local
    // programs, which could run the worker directly anyway.
    const origin = request.headers.origin;
    if (origin !== undefined && !origins.has(origin)) {
      send(response, 403, { error: "Origin is not allowed." }, undefined);
      return;
    }
    const url = request.url ?? "";
    try {
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          ...(origin === undefined
            ? {}
            : { "access-control-allow-origin": origin, vary: "Origin" }),
          "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
          "access-control-allow-headers": "content-type",
          // Chrome's Private Network Access: a public page may reach loopback.
          "access-control-allow-private-network": "true",
          "access-control-max-age": "600",
        });
        response.end();
        return;
      }
      if (request.method === "GET" && url === "/health") {
        send(
          response,
          200,
          {
            ok: true,
            protocolVersion: COMPANION_PROTOCOL_VERSION,
            environmentId: options.manifest.environmentId,
            algorithmId: worker.algorithmId,
            parameterDigest: worker.parameterDigest,
            workerSha256: worker.binarySha256,
            workerVerified: true,
            threads: options.threads,
          },
          origin,
        );
        return;
      }
      if (request.method === "POST" && url === "/v1/jobs") {
        const job = jobs.submit(jobs.parse(await readJson(request)));
        send(response, 202, jobView(job), origin);
        return;
      }
      const match = /^\/v1\/jobs\/([0-9a-f-]{36})$/iu.exec(url);
      if (match !== null && request.method === "GET") {
        const job = jobs.get(match[1]!);
        if (job === undefined) {
          send(response, 404, { error: "Unknown compute job." }, origin);
        } else {
          send(response, 200, jobView(job), origin);
        }
        return;
      }
      if (match !== null && request.method === "DELETE") {
        const job = jobs.cancel(match[1]!);
        if (job === undefined) {
          send(response, 404, { error: "Unknown compute job." }, origin);
        } else {
          send(response, 202, jobView(job), origin);
        }
        return;
      }
      send(response, 404, { error: "Not found." }, origin);
    } catch (error) {
      const status = error instanceof RequestError ? error.status : 500;
      send(
        response,
        status,
        {
          error:
            error instanceof RequestError
              ? error.message
              : "Compute Companion failed.",
        },
        origin,
      );
    }
  }

  return { server, jobs };
}
