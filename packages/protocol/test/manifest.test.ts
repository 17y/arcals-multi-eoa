import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  InvalidDeploymentManifestError,
  parseDeploymentManifest,
} from "../src/index.js";

const manifestPath = new URL(
  "../../test-fixtures/manifests/local-deployment.json",
  import.meta.url,
);
const validManifest = JSON.parse(
  await readFile(manifestPath, "utf8"),
) as Record<string, unknown>;

describe("trusted deployment manifest", () => {
  it("binds chain ID, Core address, source, artifacts, addresses, and Pi root", () => {
    const parsed = parseDeploymentManifest(
      validManifest,
      "31337:0x1000000000000000000000000000000000000001",
    );
    expect(parsed.chainId).toBe("31337");
    expect(parsed.contracts.core).toBe(
      "0x1000000000000000000000000000000000000001",
    );
    expect(parsed.productionAuthorized).toBe(false);
  });

  it.each([
    [
      "wrong environment",
      {
        ...validManifest,
        environmentId: "31337:0x0000000000000000000000000000000000000000",
      },
    ],
    ["non-canonical chain", { ...validManifest, chainId: "031337" }],
    [
      "production authorization",
      { ...validManifest, productionAuthorized: true },
    ],
    ["production mode", { ...validManifest, mode: "production" }],
    [
      "duplicate contract",
      {
        ...validManifest,
        contracts: {
          ...(validManifest.contracts as Record<string, unknown>),
          base: (validManifest.contracts as Record<string, unknown>).core,
        },
      },
    ],
  ])("rejects %s", (_label, candidate) => {
    expect(() => parseDeploymentManifest(candidate)).toThrowError(
      InvalidDeploymentManifestError,
    );
  });
});
