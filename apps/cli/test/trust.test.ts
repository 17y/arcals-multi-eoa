import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { deriveEpochKey, hashWorkConfig } from "@arcals/protocol";
import type { ConfigDto, WorkConfigV1 } from "@arcals/protocol";

import type { AgentEnvironmentManifest } from "../src/types.js";
import {
  ensureWorkerInstalled,
  sha256File,
  loadAgentManifest,
  verifyApiConfiguration,
  verifyWorkerIntegrity,
} from "../src/trust.js";

const deployment = {
  core: "0x1000000000000000000000000000000000000001",
  base: "0x1000000000000000000000000000000000000002",
  mirror: "0x1000000000000000000000000000000000000003",
  vault: "0x1000000000000000000000000000000000000004",
  controller: "0x1000000000000000000000000000000000000005",
  treasury: "0x1000000000000000000000000000000000000006",
} as const;
const root = `0x${"11".repeat(32)}` as const;
const algorithmId = `0x${"22".repeat(32)}` as const;
const parameterDigest = `0x${"33".repeat(32)}` as const;

function config(): ConfigDto {
  const workConfig: WorkConfigV1 = {
    protocolVersion: 1,
    algorithmId,
    parameterDigest,
    epochSeconds: 86_400n,
    keyLeadSeconds: 900n,
    maxChallengeTtl: 1_200n,
    maxCertificateTtl: 300n,
    target: (1n << 256n) - 1n,
    effectiveEpoch: 0n,
  };
  const configDigest = hashWorkConfig(workConfig);
  const epochKey = deriveEpochKey(
    31_337n,
    deployment.controller,
    0n,
    1n,
    `0x${"66".repeat(32)}`,
  );
  return {
    environmentId: `31337:${deployment.core}`,
    chainId: "31337",
    deployment,
    piRoot: root,
    workConfig: {
      protocolVersion: 1,
      algorithmId,
      parameterDigest,
      epochSeconds: "86400",
      keyLeadSeconds: "900",
      maxChallengeTtl: "1200",
      maxCertificateTtl: "300",
      target: ((1n << 256n) - 1n).toString(),
      effectiveEpoch: "0",
      configDigest,
    },
    epoch: {
      epochId: "0",
      configDigest,
      epochKey,
      validFrom: "1800000000",
      validUntil: "1800086400",
      anchorBlockNumber: "1",
      anchorBlockHash: `0x${"66".repeat(32)}`,
    },
    capabilities: { mint: true },
  };
}

describe("trusted Agent environment", () => {
  it("parses only a canonical environment-bound Agent manifest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arcals-manifest-"));
    const path = join(directory, "agent.json");
    const manifest = {
      schemaVersion: "1",
      mode: "local-fixture",
      environmentId: `31337:${deployment.core}`,
      chainId: "31337",
      apiUrl: "http://127.0.0.1:3000",
      rpcUrl: "http://127.0.0.1:8545",
      deployment,
      piRoot: root,
      worker: {
        binaryPath: "/trusted/arcals-randomx-worker",
        binarySha256: "aa".repeat(32),
        algorithmId,
        parameterDigest,
      },
      productionAuthorized: false,
    } as const;
    await writeFile(path, JSON.stringify(manifest));
    await expect(loadAgentManifest(path)).resolves.toMatchObject(manifest);
    await writeFile(
      path,
      JSON.stringify({
        ...manifest,
        environmentId: `31338:${deployment.core}`,
      }),
    );
    await expect(loadAgentManifest(path)).rejects.toThrow(/bind chainId/u);
  });

  it("binds the Arc Mainnet and Arc Testnet modes to their chain IDs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arcals-manifest-"));
    const path = join(directory, "agent.json");
    const base = {
      schemaVersion: "1",
      apiUrl: "https://api.example.invalid",
      rpcUrl: "https://rpc.example.invalid",
      deployment,
      piRoot: root,
      worker: {
        binaryPath: "/trusted/arcals-randomx-worker",
        binarySha256: "aa".repeat(32),
        algorithmId,
        parameterDigest,
      },
      productionAuthorized: false,
    } as const;
    const mainnet = {
      ...base,
      mode: "arc-mainnet",
      chainId: "5042",
      environmentId: `5042:${deployment.core}`,
    };
    await writeFile(path, JSON.stringify(mainnet));
    await expect(loadAgentManifest(path)).resolves.toMatchObject({
      mode: "arc-mainnet",
      chainId: "5042",
    });
    await writeFile(
      path,
      JSON.stringify({
        ...mainnet,
        chainId: "5042002",
        environmentId: `5042002:${deployment.core}`,
      }),
    );
    await expect(loadAgentManifest(path)).rejects.toThrow(
      /arc-mainnet requires chainId 5042/u,
    );
    await writeFile(path, JSON.stringify({ ...mainnet, mode: "arc-testnet" }));
    await expect(loadAgentManifest(path)).rejects.toThrow(
      /arc-testnet requires chainId 5042002/u,
    );
    await writeFile(
      path,
      JSON.stringify({
        ...mainnet,
        rpcFallbackUrls: [
          "https://a.example.invalid",
          "https://b.example.invalid",
        ],
      }),
    );
    await expect(loadAgentManifest(path)).resolves.toMatchObject({
      rpcFallbackUrls: [
        "https://a.example.invalid",
        "https://b.example.invalid",
      ],
    });
    await writeFile(
      path,
      JSON.stringify({ ...mainnet, rpcFallbackUrls: ["ftp://bad.example"] }),
    );
    await expect(loadAgentManifest(path)).rejects.toThrow(/rpcFallbackUrls/u);
    await writeFile(
      path,
      JSON.stringify({ ...mainnet, productionAuthorized: true }),
    );
    await expect(loadAgentManifest(path)).resolves.toMatchObject({
      mode: "arc-mainnet",
      productionAuthorized: true,
    });
    await writeFile(
      path,
      JSON.stringify({
        ...mainnet,
        mode: "arc-testnet",
        chainId: "5042002",
        environmentId: `5042002:${deployment.core}`,
        productionAuthorized: true,
      }),
    );
    await expect(loadAgentManifest(path)).rejects.toThrow(
      /only an arc-mainnet manifest can authorize production/u,
    );
    await writeFile(
      path,
      JSON.stringify({ ...mainnet, productionAuthorized: "yes" }),
    );
    await expect(loadAgentManifest(path)).rejects.toThrow(/must be boolean/u);
  });

  it("selects the trusted worker build for the running platform", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arcals-manifest-"));
    const path = join(directory, "agent.json");
    const manifest = {
      schemaVersion: "1",
      mode: "local-fixture",
      environmentId: `31337:${deployment.core}`,
      chainId: "31337",
      apiUrl: "http://127.0.0.1:3000",
      rpcUrl: "http://127.0.0.1:8545",
      deployment,
      piRoot: root,
      worker: {
        binaryPath: "/trusted/arcals-randomx-worker",
        binarySha256: "aa".repeat(32),
        algorithmId,
        parameterDigest,
        platforms: {
          "linux-x64": { binarySha256: "aa".repeat(32) },
          "darwin-arm64": {
            binaryPath: "/trusted/mac/arcals-randomx-worker",
            binarySha256: "bb".repeat(32),
          },
        },
      },
      productionAuthorized: false,
    } as const;
    await writeFile(path, JSON.stringify(manifest));
    await expect(
      loadAgentManifest(path, "darwin-arm64"),
    ).resolves.toMatchObject({
      worker: {
        binaryPath: "/trusted/mac/arcals-randomx-worker",
        binarySha256: "bb".repeat(32),
      },
    });
    await expect(loadAgentManifest(path, "linux-x64")).resolves.toMatchObject({
      worker: {
        binaryPath: "/trusted/arcals-randomx-worker",
        binarySha256: "aa".repeat(32),
      },
    });
    await expect(loadAgentManifest(path, "linux-arm64")).rejects.toThrow(
      /WORKER_PLATFORM_UNSUPPORTED/u,
    );
    await writeFile(
      path,
      JSON.stringify({
        ...manifest,
        worker: {
          ...manifest.worker,
          platforms: { "windows-x64": { binarySha256: "cc".repeat(32) } },
        },
      }),
    );
    await expect(loadAgentManifest(path, "linux-x64")).rejects.toThrow(
      /not a supported platform/u,
    );
  });

  it("downloads a release worker only when its bytes match the trusted hash", async () => {
    const home = await mkdtemp(join(tmpdir(), "arcals-home-"));
    const previousHome = process.env.ARCALS_AGENT_HOME;
    process.env.ARCALS_AGENT_HOME = home;
    try {
      const good = Buffer.from("trusted worker bytes");
      const goodSha = createHash("sha256").update(good).digest("hex");
      const directory = await mkdtemp(join(tmpdir(), "arcals-manifest-"));
      const path = join(directory, "agent.json");
      const manifest = {
        schemaVersion: "1",
        mode: "local-fixture",
        environmentId: `31337:${deployment.core}`,
        chainId: "31337",
        apiUrl: "http://127.0.0.1:3000",
        rpcUrl: "http://127.0.0.1:8545",
        deployment,
        piRoot: root,
        worker: {
          binaryPath: "native/randomx-worker/build/arcals-randomx-worker",
          binarySha256: "aa".repeat(32),
          algorithmId,
          parameterDigest,
          platforms: {
            "darwin-arm64": {
              binarySha256: goodSha,
              binaryUrl: "https://releases.example.invalid/darwin-arm64/worker",
            },
          },
        },
        productionAuthorized: false,
      };
      await writeFile(path, JSON.stringify(manifest));
      const loaded = await loadAgentManifest(path, "darwin-arm64");
      expect(loaded.worker.binaryPath).toBe(
        join(home, "workers", goodSha, "arcals-randomx-worker"),
      );

      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(good));
      await expect(ensureWorkerInstalled(loaded)).resolves.toBe("DOWNLOADED");
      expect(await readFile(loaded.worker.binaryPath)).toEqual(good);
      expect((await stat(loaded.worker.binaryPath)).mode & 0o111).not.toBe(0);
      await expect(ensureWorkerInstalled(loaded)).resolves.toBe("PRESENT");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const tampered = await loadAgentManifest(path, "darwin-arm64");
      const other = {
        ...tampered,
        worker: {
          ...tampered.worker,
          binaryPath: join(home, "workers", "other", "arcals-randomx-worker"),
        },
      };
      fetchMock.mockResolvedValue(new Response(Buffer.from("tampered")));
      await expect(ensureWorkerInstalled(other)).rejects.toThrow(
        /checksum mismatch/u,
      );
      await expect(stat(other.worker.binaryPath)).rejects.toThrow();

      await writeFile(
        path,
        JSON.stringify({
          ...manifest,
          worker: {
            ...manifest.worker,
            platforms: {
              "darwin-arm64": {
                binarySha256: goodSha,
                binaryUrl: "http://insecure.example.invalid/worker",
              },
            },
          },
        }),
      );
      await expect(loadAgentManifest(path, "darwin-arm64")).rejects.toThrow(
        /HTTPS/u,
      );
    } finally {
      vi.restoreAllMocks();
      if (previousHome === undefined) delete process.env.ARCALS_AGENT_HOME;
      else process.env.ARCALS_AGENT_HOME = previousHome;
    }
  });

  it("rejects a malicious API deployment or worker identity override", () => {
    const manifest = {
      schemaVersion: "1",
      mode: "local-fixture",
      environmentId: `31337:${deployment.core}`,
      chainId: "31337",
      apiUrl: "http://127.0.0.1:3000",
      rpcUrl: "http://127.0.0.1:8545",
      deployment,
      piRoot: root,
      worker: {
        binaryPath: "/trusted/arcals-randomx-worker",
        binarySha256: "aa".repeat(32),
        algorithmId,
        parameterDigest,
      },
      productionAuthorized: false,
    } satisfies AgentEnvironmentManifest;
    expect(() => verifyApiConfiguration(manifest, config())).not.toThrow();
    expect(() =>
      verifyApiConfiguration(manifest, {
        ...config(),
        deployment: {
          ...deployment,
          core: "0x9999999999999999999999999999999999999999",
        },
      }),
    ).toThrow(/changed core/u);
    expect(() =>
      verifyApiConfiguration(manifest, {
        ...config(),
        workConfig: { ...config().workConfig!, parameterDigest: root },
      }),
    ).toThrow(/WorkSpec/u);
    expect(() =>
      verifyApiConfiguration(manifest, {
        ...config(),
        workConfig: { ...config().workConfig!, target: "1" },
      }),
    ).toThrow(/digest/u);
    expect(() =>
      verifyApiConfiguration(manifest, {
        ...config(),
        epoch: { ...config().epoch!, epochKey: root },
      }),
    ).toThrow(/Epoch key/u);
  });

  it("executes only a local worker whose SHA-256 matches the trusted manifest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arcals-worker-"));
    const binaryPath = join(directory, "worker");
    await writeFile(binaryPath, "trusted worker bytes");
    const digest = await sha256File(binaryPath);
    const manifest = {
      schemaVersion: "1",
      mode: "local-fixture",
      environmentId: `31337:${deployment.core}`,
      chainId: "31337",
      apiUrl: "http://127.0.0.1:3000",
      rpcUrl: "http://127.0.0.1:8545",
      deployment,
      piRoot: root,
      worker: {
        binaryPath,
        binarySha256: digest,
        algorithmId,
        parameterDigest,
      },
      productionAuthorized: false,
    } satisfies AgentEnvironmentManifest;
    await expect(verifyWorkerIntegrity(manifest)).resolves.toBeUndefined();
    await writeFile(binaryPath, "tampered worker bytes");
    await expect(verifyWorkerIntegrity(manifest)).rejects.toThrow(/checksum/u);
  });
});
