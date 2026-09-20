import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createCompanionServer } from "../src/companion.js";
import type {
  MineRequest,
  MiningSolution,
  RandomXMiner,
} from "../src/randomx-miner.js";
import type { AgentEnvironmentManifest } from "../src/types.js";

const algorithmId = `0x${"8c".repeat(32)}` as const;
const parameterDigest = `0x${"20".repeat(32)}` as const;
const manifest = {
  environmentId: "5042:0x8e22e1afec4888356232ea184f465428b6d70219",
  worker: {
    binaryPath: "/nonexistent",
    binarySha256: "ab".repeat(32),
    algorithmId,
    parameterDigest,
  },
} as unknown as AgentEnvironmentManifest;

/** A miner that finishes only when the test says so. */
class FakeMiner implements RandomXMiner {
  readonly requests: MineRequest[] = [];
  private resolvers: ((solution: MiningSolution) => void)[] = [];

  mine(request: MineRequest): Promise<MiningSolution> {
    this.requests.push(request);
    return new Promise((resolve, reject) => {
      this.resolvers.push(resolve);
      request.signal?.addEventListener("abort", () =>
        reject(new Error("RandomX search was cancelled")),
      );
    });
  }

  solve(): void {
    this.resolvers.shift()?.({
      workNonce: 42n,
      randomxHash: `0x${"00".repeat(31)}01`,
      hashesTried: "100",
      elapsedMs: "1000",
      hashRate: "100",
    });
  }

  async close(): Promise<void> {}
}

const open: { close: () => void }[] = [];
afterEach(() => {
  for (const server of open.splice(0)) server.close();
});

async function companion(miner = new FakeMiner()) {
  const { server, jobs } = createCompanionServer({
    manifest,
    miner,
    threads: 2,
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  open.push(server);
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port.toString()}`;
  return { base, port, miner, jobs };
}

function work(overrides: Record<string, unknown> = {}) {
  return {
    challengeInput: `0x${"11".repeat(32)}`,
    epochKey: `0x${"22".repeat(32)}`,
    target: "1000",
    expiresAt: String(Math.floor(Date.now() / 1000) + 600),
    algorithmId,
    parameterDigest,
    ...overrides,
  };
}

async function post(
  base: string,
  body: unknown,
  origin = "https://arcals.fun",
) {
  return fetch(`${base}/v1/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

async function poll(base: string, jobId: string, status: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const state = (await (
      await fetch(`${base}/v1/jobs/${jobId}`, {
        headers: { origin: "https://arcals.fun" },
      })
    ).json()) as { status: string; workNonce?: string };
    if (state.status === status) return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`job never reached ${status}`);
}

describe("Compute Companion", () => {
  it("reports the manifest's work parameters on /health", async () => {
    const { base } = await companion();
    const health = (await (await fetch(`${base}/health`)).json()) as Record<
      string,
      unknown
    >;
    expect(health).toMatchObject({
      ok: true,
      protocolVersion: 1,
      algorithmId,
      parameterDigest,
      workerVerified: true,
    });
  });

  it("refuses a foreign site before doing any work", async () => {
    const { base, miner } = await companion();
    const response = await post(base, work(), "https://evil.example");
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(miner.requests).toHaveLength(0);
  });

  it("refuses a rebinding hostname even from an allowed origin", async () => {
    const { port } = await companion();
    // fetch cannot forge Host, so talk HTTP directly.
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const outgoing = request(
        {
          host: "127.0.0.1",
          port,
          path: "/health",
          headers: { host: "attacker.example", origin: "https://arcals.fun" },
        },
        (response) => resolve(response.statusCode ?? 0),
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
    expect(status).toBe(403);
  });

  it("answers the Private Network Access preflight for the site", async () => {
    const { base } = await companion();
    const response = await fetch(`${base}/v1/jobs`, {
      method: "OPTIONS",
      headers: {
        origin: "https://arcals.fun",
        "access-control-request-method": "POST",
        "access-control-request-private-network": "true",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://arcals.fun",
    );
    expect(response.headers.get("access-control-allow-private-network")).toBe(
      "true",
    );
    expect(response.headers.get("access-control-allow-methods")).toContain(
      "DELETE",
    );
  });

  it("rejects work whose parameters differ from the manifest", async () => {
    const { base, miner } = await companion();
    const response = await post(
      base,
      work({ parameterDigest: `0x${"33".repeat(32)}` }),
    );
    expect(response.status).toBe(400);
    expect(miner.requests).toHaveLength(0);
  });

  it("rejects a challenge too close to expiry", async () => {
    const { base } = await companion();
    const response = await post(
      base,
      work({ expiresAt: String(Math.floor(Date.now() / 1000) + 2) }),
    );
    expect(response.status).toBe(400);
  });

  it("computes a solution and reports the work nonce as a string", async () => {
    const { base, miner } = await companion();
    const job = (await (await post(base, work())).json()) as { jobId: string };
    await poll(base, job.jobId, "COMPUTING");
    miner.solve();
    const done = await poll(base, job.jobId, "SOLUTION_FOUND");
    expect(done.workNonce).toBe("42");
    expect(miner.requests[0]!.config.target).toBe("1000");
    expect(miner.requests[0]!.epoch.epochKey).toBe(`0x${"22".repeat(32)}`);
  });

  it("resumes identical work instead of starting it again", async () => {
    const { base, miner } = await companion();
    const first = (await (await post(base, work())).json()) as {
      jobId: string;
    };
    const again = (await (await post(base, work())).json()) as {
      jobId: string;
    };
    expect(again.jobId).toBe(first.jobId);
    await poll(base, first.jobId, "COMPUTING");
    expect(miner.requests).toHaveLength(1);
  });

  it("cancels a running search inside the worker", async () => {
    const { base, miner } = await companion();
    const job = (await (await post(base, work())).json()) as { jobId: string };
    await poll(base, job.jobId, "COMPUTING");
    const cancelled = await fetch(`${base}/v1/jobs/${job.jobId}`, {
      method: "DELETE",
      headers: { origin: "https://arcals.fun" },
    });
    expect(cancelled.status).toBe(202);
    await poll(base, job.jobId, "CANCELLED");
    expect(miner.requests[0]!.signal?.aborted).toBe(true);
  });

  it("drops a queued job without ever mining it and runs the next one", async () => {
    const { base, miner } = await companion();
    const first = (await (await post(base, work())).json()) as {
      jobId: string;
    };
    const queued = (await (
      await post(base, work({ challengeInput: `0x${"44".repeat(32)}` }))
    ).json()) as { jobId: string };
    const third = (await (
      await post(base, work({ challengeInput: `0x${"55".repeat(32)}` }))
    ).json()) as { jobId: string };
    await fetch(`${base}/v1/jobs/${queued.jobId}`, {
      method: "DELETE",
      headers: { origin: "https://arcals.fun" },
    });
    await poll(base, queued.jobId, "CANCELLED");
    miner.solve();
    await poll(base, first.jobId, "SOLUTION_FOUND");
    await poll(base, third.jobId, "COMPUTING");
    expect(miner.requests.map((request) => request.challengeInput)).toEqual([
      `0x${"11".repeat(32)}`,
      `0x${"55".repeat(32)}`,
    ]);
  });

  it("caps unfinished jobs", async () => {
    const { base } = await companion();
    const statuses: number[] = [];
    for (let index = 0; index < 9; index += 1) {
      const response = await post(
        base,
        work({ challengeInput: `0x${index.toString(16).padStart(64, "0")}` }),
      );
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 8).every((status) => status === 202)).toBe(true);
    expect(statuses[8]).toBe(429);
  });
});
