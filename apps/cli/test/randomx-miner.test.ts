import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { UINT256_MAX } from "@arcals/protocol";
import type { ConfigDto } from "@arcals/protocol";

import { RealRandomXMiner } from "../src/randomx-miner.js";

const release = JSON.parse(
  await readFile(
    new URL(
      "../../../native/randomx-worker/release/manifest.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  algorithmId: `0x${string}`;
  parameterDigest: `0x${string}`;
};
const vector = JSON.parse(
  await readFile(
    new URL(
      "../../../packages/test-fixtures/randomx/arcals-v2-salt-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  epochKey: `0x${string}`;
  challengeInput: `0x${string}`;
};

describe("Agent real RandomX integration", () => {
  it("prepares Fast mode and returns an actual solution through the CLI miner boundary", async () => {
    const worker = new RealRandomXMiner(
      fileURLToPath(
        new URL(
          "../../../native/randomx-worker/build/arcals-randomx-worker",
          import.meta.url,
        ),
      ),
    );
    const now = BigInt(Math.floor(Date.now() / 1000));
    const config = {
      protocolVersion: 1,
      algorithmId: release.algorithmId,
      parameterDigest: release.parameterDigest,
      epochSeconds: "86400",
      keyLeadSeconds: "900",
      maxChallengeTtl: "1200",
      maxCertificateTtl: "300",
      target: UINT256_MAX.toString(),
      effectiveEpoch: "0",
      configDigest: `0x${"11".repeat(32)}`,
    } satisfies NonNullable<ConfigDto["workConfig"]>;
    try {
      const result = await worker.mine({
        challengeInput: vector.challengeInput,
        config,
        epoch: {
          epochId: "0",
          configDigest: config.configDigest,
          epochKey: vector.epochKey,
          validFrom: now.toString(),
          validUntil: (now + 86_400n).toString(),
          anchorBlockNumber: "1",
          anchorBlockHash: `0x${"22".repeat(32)}`,
        },
        threads: 1,
        expiresAt: now + 300n,
      });
      expect(result.workNonce).toBe(0n);
      expect(result.randomxHash).toMatch(/^0x[0-9a-f]{64}$/u);
      expect(BigInt(result.hashesTried)).toBeGreaterThanOrEqual(1n);
    } finally {
      await worker.close();
    }
  }, 120_000);

  it("decodes spaces in file URLs before handing paths to the worker process", () => {
    const encoded = new URL("./Arcals%20Workspace/worker", import.meta.url);
    expect(encoded.pathname).toContain("%20");
    expect(fileURLToPath(encoded)).toContain("Arcals Workspace");
    expect(fileURLToPath(encoded)).not.toContain("%20");
  });
});
