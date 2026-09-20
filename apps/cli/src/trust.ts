import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  arclBaseAbi,
  arcalMirrorAbi,
  arcalsCoreAbi,
  arcalsVaultAbi,
} from "@arcals/contract-bindings";
import {
  MINT_FEE_NATIVE,
  UNIT,
  assertBytes32,
  assertHexAddress,
  deriveEpochKey,
  hashWorkConfig,
} from "@arcals/protocol";
import type { Bytes32, ConfigDto, HexAddress } from "@arcals/protocol";
import type { PublicClient } from "viem";

import type { AgentEnvironmentManifest } from "./types.js";

function equalAddress(left: string | null, right: string): boolean {
  return left !== null && left.toLowerCase() === right.toLowerCase();
}

function expectText(object: Record<string, unknown>, key: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`agent manifest ${key} must be a non-empty string`);
  }
  return value;
}

const WORKER_PLATFORMS = new Set([
  "linux-x64",
  "linux-arm64",
  "darwin-arm64",
  "darwin-x64",
  "win32-x64",
]);

export function currentWorkerPlatform(): string {
  return `${process.platform}-${process.arch}`;
}

export async function loadAgentManifest(
  path: string,
  platform = currentWorkerPlatform(),
): Promise<AgentEnvironmentManifest> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as Record<
    string,
    unknown
  >;
  if (parsed.schemaVersion !== "1") {
    throw new TypeError("unsupported agent manifest schemaVersion");
  }
  if (
    parsed.mode !== "local-fixture" &&
    parsed.mode !== "arc-testnet" &&
    parsed.mode !== "arc-mainnet"
  ) {
    throw new TypeError("unsupported agent manifest mode");
  }
  if (typeof parsed.productionAuthorized !== "boolean") {
    throw new TypeError("agent manifest productionAuthorized must be boolean");
  }
  if (parsed.productionAuthorized && parsed.mode !== "arc-mainnet") {
    throw new Error("only an arc-mainnet manifest can authorize production");
  }
  if (
    typeof parsed.deployment !== "object" ||
    parsed.deployment === null ||
    Array.isArray(parsed.deployment) ||
    typeof parsed.worker !== "object" ||
    parsed.worker === null ||
    Array.isArray(parsed.worker)
  ) {
    throw new TypeError("agent manifest deployment and worker are required");
  }
  const deployment = parsed.deployment as Record<string, unknown>;
  const worker = parsed.worker as Record<string, unknown>;
  const addresses: string[] = [];
  for (const name of [
    "core",
    "base",
    "mirror",
    "vault",
    "controller",
    "treasury",
  ]) {
    const address = expectText(deployment, name);
    assertHexAddress(address, `deployment.${name}`);
    if (BigInt(address) === 0n) {
      throw new TypeError(`deployment.${name} cannot be zero`);
    }
    addresses.push(address.toLowerCase());
  }
  if (new Set(addresses).size !== addresses.length) {
    throw new TypeError("deployment addresses must be distinct");
  }
  const chainId = expectText(parsed, "chainId");
  if (!/^(0|[1-9][0-9]*)$/u.test(chainId)) {
    throw new TypeError("agent manifest chainId must be canonical decimal");
  }
  const numericChainId = BigInt(chainId);
  if (
    numericChainId === 0n ||
    numericChainId > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new TypeError("agent manifest chainId is outside the CLI range");
  }
  const requiredChainId =
    parsed.mode === "arc-testnet"
      ? 5_042_002n
      : parsed.mode === "arc-mainnet"
        ? 5_042n
        : null;
  if (requiredChainId !== null && numericChainId !== requiredChainId) {
    throw new TypeError(
      `agent manifest mode ${String(parsed.mode)} requires chainId ${requiredChainId.toString()}`,
    );
  }
  const expectedEnvironment = `${chainId}:${addresses[0]}`;
  if (parsed.environmentId !== expectedEnvironment) {
    throw new TypeError("agent environmentId must bind chainId and Core");
  }
  for (const name of ["apiUrl", "rpcUrl"] as const) {
    const url = new URL(expectText(parsed, name));
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new TypeError(`agent manifest ${name} must use HTTP(S)`);
    }
  }
  if (parsed.rpcFallbackUrls !== undefined) {
    if (
      !Array.isArray(parsed.rpcFallbackUrls) ||
      parsed.rpcFallbackUrls.length > 5 ||
      !parsed.rpcFallbackUrls.every((value) => {
        if (typeof value !== "string") return false;
        try {
          const url = new URL(value);
          return url.protocol === "http:" || url.protocol === "https:";
        } catch {
          return false;
        }
      })
    ) {
      throw new TypeError(
        "agent manifest rpcFallbackUrls must be at most 5 HTTP(S) URLs",
      );
    }
  }
  const piRoot = expectText(parsed, "piRoot");
  assertBytes32(piRoot, "piRoot");
  const binarySha256 = expectText(worker, "binarySha256");
  if (!/^[0-9a-f]{64}$/u.test(binarySha256)) {
    throw new TypeError("worker.binarySha256 must be lowercase SHA-256");
  }
  expectText(worker, "binaryPath");
  let resolvedWorker: Record<string, unknown> = worker;
  if (worker.platforms !== undefined) {
    if (
      typeof worker.platforms !== "object" ||
      worker.platforms === null ||
      Array.isArray(worker.platforms)
    ) {
      throw new TypeError("worker.platforms must be an object");
    }
    const platforms = worker.platforms as Record<string, unknown>;
    for (const [name, build] of Object.entries(platforms)) {
      if (!WORKER_PLATFORMS.has(name)) {
        throw new TypeError(
          `worker.platforms.${name} is not a supported platform`,
        );
      }
      if (typeof build !== "object" || build === null || Array.isArray(build)) {
        throw new TypeError(`worker.platforms.${name} must be an object`);
      }
      const entry = build as Record<string, unknown>;
      if (
        typeof entry.binarySha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(entry.binarySha256)
      ) {
        throw new TypeError(
          `worker.platforms.${name}.binarySha256 must be lowercase SHA-256`,
        );
      }
      if (
        entry.binaryPath !== undefined &&
        (typeof entry.binaryPath !== "string" || entry.binaryPath.length === 0)
      ) {
        throw new TypeError(`worker.platforms.${name}.binaryPath is invalid`);
      }
      if (entry.binaryUrl !== undefined) {
        let valid = false;
        try {
          valid =
            typeof entry.binaryUrl === "string" &&
            new URL(entry.binaryUrl).protocol === "https:";
        } catch {
          valid = false;
        }
        if (!valid) {
          throw new TypeError(
            `worker.platforms.${name}.binaryUrl must be an HTTPS URL`,
          );
        }
      }
    }
    const selected = platforms[platform] as
      | { binaryPath?: string; binarySha256: string; binaryUrl?: string }
      | undefined;
    if (selected === undefined) {
      throw new Error(
        `WORKER_PLATFORM_UNSUPPORTED: this environment publishes no trusted RandomX worker for ${platform}`,
      );
    }
    resolvedWorker = {
      ...worker,
      // A downloaded release lives in a hash-addressed directory, so a
      // different release can never be mistaken for this one.
      binaryPath:
        selected.binaryPath ??
        (selected.binaryUrl !== undefined
          ? join(
              workerCacheDirectory(),
              selected.binarySha256,
              // Windows can only execute a file with an executable extension.
              process.platform === "win32"
                ? "arcals-randomx-worker.exe"
                : "arcals-randomx-worker",
            )
          : worker.binaryPath),
      binarySha256: selected.binarySha256,
      ...(selected.binaryUrl === undefined
        ? {}
        : { binaryUrl: selected.binaryUrl }),
    };
  }
  assertBytes32(expectText(worker, "algorithmId"), "worker.algorithmId");
  assertBytes32(
    expectText(worker, "parameterDigest"),
    "worker.parameterDigest",
  );
  if (parsed.contentRegistrar !== undefined) {
    const registrar = expectText(parsed, "contentRegistrar");
    assertHexAddress(registrar, "contentRegistrar");
    if (
      BigInt(registrar) === 0n ||
      addresses.includes(registrar.toLowerCase())
    ) {
      throw new TypeError(
        "contentRegistrar must be a distinct non-zero address",
      );
    }
  }
  return {
    ...parsed,
    worker: resolvedWorker,
  } as unknown as AgentEnvironmentManifest;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

export function workerCacheDirectory(): string {
  return join(
    process.env.ARCALS_AGENT_HOME ?? join(homedir(), ".arcals"),
    "workers",
  );
}

const MAX_WORKER_BYTES = 64 * 1024 * 1024;

/**
 * Downloads a trusted release worker when the manifest names a URL and the
 * binary is absent. The file is written beside its destination, checked
 * against the manifest hash, made executable, then atomically renamed; a
 * mismatching download is never written or executed.
 */
export async function ensureWorkerInstalled(
  manifest: AgentEnvironmentManifest,
): Promise<"PRESENT" | "DOWNLOADED"> {
  const worker = manifest.worker;
  if (worker.binaryUrl === undefined) return "PRESENT";
  try {
    await access(worker.binaryPath, fsConstants.F_OK);
    return "PRESENT";
  } catch {
    // Not installed yet.
  }
  await mkdir(dirname(worker.binaryPath), { recursive: true, mode: 0o700 });
  const response = await fetch(worker.binaryUrl, {
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(
      `WORKER_DOWNLOAD_FAILED: HTTP ${response.status.toString()} from the trusted worker URL`,
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_WORKER_BYTES) {
    throw new Error("WORKER_DOWNLOAD_FAILED: unexpected worker size");
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== worker.binarySha256.toLowerCase()) {
    throw new Error(
      "UNTRUSTED_DEPLOYMENT: downloaded RandomX worker checksum mismatch",
    );
  }
  const temporary = `${worker.binaryPath}.${process.pid.toString()}.download`;
  await writeFile(temporary, bytes, { mode: 0o755 });
  // Windows has no execute bit and rejects chmod on some filesystems.
  if (process.platform !== "win32") await chmod(temporary, 0o755);
  await rename(temporary, worker.binaryPath);
  return "DOWNLOADED";
}

export async function verifyWorkerIntegrity(
  manifest: AgentEnvironmentManifest,
): Promise<void> {
  await ensureWorkerInstalled(manifest);
  const actual = await sha256File(manifest.worker.binaryPath);
  if (actual !== manifest.worker.binarySha256.toLowerCase()) {
    throw new Error("UNTRUSTED_DEPLOYMENT: RandomX worker checksum mismatch");
  }
}

export function verifyApiConfiguration(
  manifest: AgentEnvironmentManifest,
  config: ConfigDto,
): void {
  if (
    config.environmentId !== manifest.environmentId ||
    config.chainId !== manifest.chainId
  ) {
    throw new Error("UNTRUSTED_DEPLOYMENT: API environment identity changed");
  }
  for (const name of [
    "core",
    "base",
    "mirror",
    "vault",
    "controller",
    "treasury",
  ] as const) {
    if (!equalAddress(config.deployment[name], manifest.deployment[name])) {
      throw new Error(`UNTRUSTED_DEPLOYMENT: API changed ${name} address`);
    }
  }
  if (config.piRoot?.toLowerCase() !== manifest.piRoot.toLowerCase()) {
    throw new Error("UNTRUSTED_DEPLOYMENT: API changed Pi root");
  }
  if (config.workConfig === null || config.epoch === null) {
    throw new Error("EPOCH_UNAVAILABLE: API has no active WorkConfig/Epoch");
  }
  assertBytes32(config.workConfig.algorithmId, "workConfig.algorithmId");
  assertBytes32(
    config.workConfig.parameterDigest,
    "workConfig.parameterDigest",
  );
  assertBytes32(config.epoch.anchorBlockHash, "epoch.anchorBlockHash");
  if (
    config.workConfig.algorithmId.toLowerCase() !==
      manifest.worker.algorithmId.toLowerCase() ||
    config.workConfig.parameterDigest.toLowerCase() !==
      manifest.worker.parameterDigest.toLowerCase()
  ) {
    throw new Error(
      "UNTRUSTED_DEPLOYMENT: API WorkSpec differs from the signed worker manifest",
    );
  }
  if (config.epoch.configDigest !== config.workConfig.configDigest) {
    throw new Error("UNTRUSTED_DEPLOYMENT: API Epoch and WorkConfig disagree");
  }
  const computedConfigDigest = hashWorkConfig({
    protocolVersion: config.workConfig.protocolVersion,
    algorithmId: config.workConfig.algorithmId,
    parameterDigest: config.workConfig.parameterDigest,
    epochSeconds: BigInt(config.workConfig.epochSeconds),
    keyLeadSeconds: BigInt(config.workConfig.keyLeadSeconds),
    maxChallengeTtl: BigInt(config.workConfig.maxChallengeTtl),
    maxCertificateTtl: BigInt(config.workConfig.maxCertificateTtl),
    target: BigInt(config.workConfig.target),
    effectiveEpoch: BigInt(config.workConfig.effectiveEpoch),
  });
  if (computedConfigDigest !== config.workConfig.configDigest) {
    throw new Error("UNTRUSTED_DEPLOYMENT: API WorkConfig digest is invalid");
  }
  const computedEpochKey = deriveEpochKey(
    BigInt(manifest.chainId),
    manifest.deployment.controller,
    BigInt(config.epoch.epochId),
    BigInt(config.epoch.anchorBlockNumber),
    config.epoch.anchorBlockHash,
  );
  if (computedEpochKey !== config.epoch.epochKey) {
    throw new Error("UNTRUSTED_DEPLOYMENT: API Epoch key is invalid");
  }
}

export async function verifyOnchainDeployment(
  manifest: AgentEnvironmentManifest,
  client: PublicClient,
): Promise<void> {
  const chainId = await client.getChainId();
  if (BigInt(chainId) !== BigInt(manifest.chainId)) {
    throw new Error("WRONG_NETWORK: RPC chainId differs from trusted manifest");
  }
  for (const [name, address] of Object.entries(manifest.deployment)) {
    const code = await client.getBytecode({ address });
    if (code === undefined || code === "0x") {
      throw new Error(`UNTRUSTED_DEPLOYMENT: ${name} has no contract code`);
    }
  }
  const [
    controller,
    base,
    mirror,
    vault,
    treasury,
    fee,
    unit,
    pairedMirror,
    pairedBase,
    datasetRoot,
    vaultUnit,
  ] = await Promise.all([
    client.readContract({
      address: manifest.deployment.core,
      abi: arcalsCoreAbi,
      functionName: "controller",
    }),
    client.readContract({
      address: manifest.deployment.core,
      abi: arcalsCoreAbi,
      functionName: "base",
    }),
    client.readContract({
      address: manifest.deployment.core,
      abi: arcalsCoreAbi,
      functionName: "mirror",
    }),
    client.readContract({
      address: manifest.deployment.core,
      abi: arcalsCoreAbi,
      functionName: "vault",
    }),
    client.readContract({
      address: manifest.deployment.core,
      abi: arcalsCoreAbi,
      functionName: "treasury",
    }),
    client.readContract({
      address: manifest.deployment.core,
      abi: arcalsCoreAbi,
      functionName: "MINT_FEE_NATIVE",
    }),
    client.readContract({
      address: manifest.deployment.core,
      abi: arcalsCoreAbi,
      functionName: "UNIT",
    }),
    client.readContract({
      address: manifest.deployment.base,
      abi: arclBaseAbi,
      functionName: "mirrorERC721",
    }),
    client.readContract({
      address: manifest.deployment.mirror,
      abi: arcalMirrorAbi,
      functionName: "baseERC20",
    }),
    client.readContract({
      address: manifest.deployment.mirror,
      abi: arcalMirrorAbi,
      functionName: "datasetRoot",
    }),
    client.readContract({
      address: manifest.deployment.vault,
      abi: arcalsVaultAbi,
      functionName: "unit",
    }),
  ]);
  const checks: readonly [string, string, string][] = [
    ["controller", String(controller), manifest.deployment.controller],
    ["base", String(base), manifest.deployment.base],
    ["mirror", String(mirror), manifest.deployment.mirror],
    ["vault", String(vault), manifest.deployment.vault],
    ["treasury", String(treasury), manifest.deployment.treasury],
    ["paired mirror", String(pairedMirror), manifest.deployment.mirror],
    ["paired base", String(pairedBase), manifest.deployment.base],
  ];
  for (const [label, actual, expected] of checks) {
    if (!equalAddress(actual, expected)) {
      throw new Error(`UNTRUSTED_DEPLOYMENT: onchain ${label} mismatch`);
    }
  }
  if (fee !== MINT_FEE_NATIVE || unit !== UNIT || vaultUnit !== UNIT) {
    throw new Error("UNTRUSTED_DEPLOYMENT: immutable fee or UNIT mismatch");
  }
  if (String(datasetRoot).toLowerCase() !== manifest.piRoot.toLowerCase()) {
    throw new Error("UNTRUSTED_DEPLOYMENT: onchain Pi root mismatch");
  }
}

export interface ChainRecoveryGateway {
  nextMintNonce(minter: HexAddress): Promise<bigint>;
  issuedId(receiptHash: Bytes32): Promise<bigint>;
}

export class ViemChainRecoveryGateway implements ChainRecoveryGateway {
  constructor(
    private readonly client: PublicClient,
    private readonly core: HexAddress,
  ) {}

  async nextMintNonce(minter: HexAddress): Promise<bigint> {
    return this.client.readContract({
      address: this.core,
      abi: arcalsCoreAbi,
      functionName: "nextMintNonce",
      args: [minter],
    });
  }

  async issuedId(receiptHash: Bytes32): Promise<bigint> {
    return this.client.readContract({
      address: this.core,
      abi: arcalsCoreAbi,
      functionName: "issuedId",
      args: [receiptHash],
    });
  }
}
