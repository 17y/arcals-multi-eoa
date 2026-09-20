import { describe, expect, it } from "vitest";

import {
  ENVIRONMENTS,
  UntrustedDeploymentError,
  requireTrustedDeployment,
} from "../src/index.js";

describe("environment safety", () => {
  it("keeps local and Arc Testnet identities separate", () => {
    expect(ENVIRONMENTS.local.chainId).toBe(31_337);
    expect(ENVIRONMENTS["arc-testnet"].chainId).toBe(5_042_002);
    expect(ENVIRONMENTS.local.chainId).not.toBe(
      ENVIRONMENTS["arc-testnet"].chainId,
    );
  });

  it("leaves every deployment address and Pi root unset", () => {
    for (const environment of Object.values(ENVIRONMENTS)) {
      expect(Object.values(environment.deployment)).toEqual([
        null,
        null,
        null,
        null,
        null,
        null,
      ]);
      expect(environment.piRoot).toBeNull();
      expect(environment.productionAuthorized).toBe(false);
    }
  });

  it("fails closed for mainnet before a trusted manifest exists", () => {
    expect(ENVIRONMENTS["arc-mainnet"].chainId).toBeNull();
    expect(ENVIRONMENTS["arc-mainnet"].rpcEnvironmentVariable).toBeNull();
    expect(() => requireTrustedDeployment("arc-mainnet")).toThrowError(
      UntrustedDeploymentError,
    );
  });
});
