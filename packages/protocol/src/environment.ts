export const ENVIRONMENT_IDS = ["local", "arc-testnet", "arc-mainnet"] as const;

export type EnvironmentId = (typeof ENVIRONMENT_IDS)[number];
export type HexAddress = `0x${string}`;
export type Bytes32 = `0x${string}`;

export interface DeploymentAddresses {
  readonly core: HexAddress | null;
  readonly base: HexAddress | null;
  readonly mirror: HexAddress | null;
  readonly vault: HexAddress | null;
  readonly controller: HexAddress | null;
  readonly treasury: HexAddress | null;
}

export interface EnvironmentDefinition {
  readonly id: EnvironmentId;
  readonly chainId: number | null;
  readonly rpcEnvironmentVariable: string | null;
  readonly deployment: DeploymentAddresses;
  readonly piRoot: Bytes32 | null;
  readonly productionAuthorized: false;
}

const unsetDeployment = (): DeploymentAddresses => ({
  core: null,
  base: null,
  mirror: null,
  vault: null,
  controller: null,
  treasury: null,
});

export const ENVIRONMENTS = {
  local: {
    id: "local",
    chainId: 31337,
    rpcEnvironmentVariable: "ARCALS_LOCAL_RPC_URL",
    deployment: unsetDeployment(),
    piRoot: null,
    productionAuthorized: false,
  },
  "arc-testnet": {
    id: "arc-testnet",
    chainId: 5_042_002,
    rpcEnvironmentVariable: "ARCALS_TESTNET_RPC_URL",
    deployment: unsetDeployment(),
    piRoot: null,
    productionAuthorized: false,
  },
  "arc-mainnet": {
    id: "arc-mainnet",
    chainId: null,
    rpcEnvironmentVariable: null,
    deployment: unsetDeployment(),
    piRoot: null,
    productionAuthorized: false,
  },
} as const satisfies Record<EnvironmentId, EnvironmentDefinition>;

export class UntrustedDeploymentError extends Error {
  readonly code = "UNTRUSTED_DEPLOYMENT";

  constructor(readonly environmentId: EnvironmentId) {
    super(`Deployment is UNSET for environment: ${environmentId}`);
    this.name = "UntrustedDeploymentError";
  }
}

export function requireTrustedDeployment(environmentId: EnvironmentId): never {
  throw new UntrustedDeploymentError(environmentId);
}
