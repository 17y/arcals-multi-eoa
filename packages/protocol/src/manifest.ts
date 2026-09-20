import { isAddress } from "viem";

import { PROTOCOL_VERSION } from "./constants.js";
import { assertBytes32 } from "./encoding.js";
import type { Bytes32, HexAddress } from "./environment.js";

export const DEPLOYMENT_CONTRACT_KEYS = [
  "core",
  "base",
  "mirror",
  "vault",
  "controller",
  "treasury",
] as const;

export type DeploymentContractKey = (typeof DEPLOYMENT_CONTRACT_KEYS)[number];

export interface DeploymentManifestV1 {
  readonly schemaVersion: "1";
  readonly protocolVersion: 1;
  readonly mode: "local-fixture" | "testnet" | "production";
  readonly network: string;
  readonly chainId: string;
  readonly environmentId: string;
  readonly deploymentBlock: string;
  readonly sourceCommit: string;
  readonly artifactDigest: string;
  readonly contracts: Readonly<Record<DeploymentContractKey, HexAddress>>;
  readonly piRoot: Bytes32;
  readonly productionAuthorized: boolean;
}

export class InvalidDeploymentManifestError extends Error {
  readonly code = "UNTRUSTED_DEPLOYMENT";

  constructor(message: string) {
    super(message);
    this.name = "InvalidDeploymentManifestError";
  }
}

function fail(message: string): never {
  throw new InvalidDeploymentManifestError(message);
}

function assertDecimal(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    fail(`${field} must be a canonical decimal string`);
  }
}

export function parseDeploymentManifest(
  input: unknown,
  expectedEnvironmentId?: string,
): DeploymentManifestV1 {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail("deployment manifest must be an object");
  }
  const value = input as Record<string, unknown>;
  if (
    value.schemaVersion !== "1" ||
    value.protocolVersion !== PROTOCOL_VERSION
  ) {
    fail("unsupported deployment manifest version");
  }
  if (
    value.mode !== "local-fixture" &&
    value.mode !== "testnet" &&
    value.mode !== "production"
  ) {
    fail("invalid deployment mode");
  }
  const mode = value.mode;
  if (typeof value.network !== "string" || value.network.length === 0)
    fail("network is required");
  assertDecimal(value.chainId, "chainId");
  assertDecimal(value.deploymentBlock, "deploymentBlock");
  if (
    typeof value.sourceCommit !== "string" ||
    !/^[0-9a-f]{40}$/u.test(value.sourceCommit)
  ) {
    fail("sourceCommit must be lowercase 40-character hex");
  }
  if (
    typeof value.artifactDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.artifactDigest)
  ) {
    fail("artifactDigest must be a sha256 digest");
  }
  if (typeof value.contracts !== "object" || value.contracts === null) {
    fail("contracts are required");
  }
  const rawContracts = value.contracts as Record<string, unknown>;
  const contracts = {} as Record<DeploymentContractKey, HexAddress>;
  for (const key of DEPLOYMENT_CONTRACT_KEYS) {
    const address = rawContracts[key];
    if (typeof address !== "string" || !isAddress(address, { strict: true })) {
      fail(`contracts.${key} must be an address`);
    }
    if (BigInt(address) === 0n) fail(`contracts.${key} cannot be zero`);
    contracts[key] = address.toLowerCase() as HexAddress;
  }
  if (
    new Set(Object.values(contracts)).size !== DEPLOYMENT_CONTRACT_KEYS.length
  ) {
    fail("contract addresses must be distinct");
  }
  if (typeof value.piRoot !== "string") fail("piRoot is required");
  assertBytes32(value.piRoot, "piRoot");

  const environmentId = `${value.chainId}:${contracts.core}`;
  if (value.environmentId !== environmentId)
    fail("environmentId does not bind chainId and Core");
  if (
    expectedEnvironmentId !== undefined &&
    environmentId !== expectedEnvironmentId
  ) {
    fail("deployment manifest does not match the expected environment");
  }
  if (value.productionAuthorized !== false) {
    fail("repository manifests cannot authorize production");
  }
  if (mode === "production") {
    fail("production deployment remains unauthorized");
  }

  return {
    schemaVersion: "1",
    protocolVersion: 1,
    mode,
    network: value.network,
    chainId: value.chainId,
    environmentId,
    deploymentBlock: value.deploymentBlock,
    sourceCommit: value.sourceCommit,
    artifactDigest: value.artifactDigest,
    contracts,
    piRoot: value.piRoot,
    productionAuthorized: false,
  };
}
