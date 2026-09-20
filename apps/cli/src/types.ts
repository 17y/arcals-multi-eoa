import type {
  Bytes32,
  HexAddress,
  OperationState,
  WalletHandle,
} from "@arcals/protocol";
import type { WalletCapabilities } from "@arcals/sdk";

export {
  WALLET_CAPABILITY_NAMES,
  isHardCapability,
  unsupportedCapabilities,
} from "@arcals/sdk";
export type {
  CapabilityEnforcement,
  ContractCall,
  SubmissionResult,
  SubmissionStatus,
  WalletAdapter,
  WalletCapabilities,
  WalletCapability,
  WalletCapabilityName,
  WalletFeeQuote,
  WalletMintAuthorizationRequest,
  WalletSimulation,
} from "@arcals/sdk";

export interface TrustedDeployment {
  readonly core: HexAddress;
  readonly base: HexAddress;
  readonly mirror: HexAddress;
  readonly vault: HexAddress;
  readonly controller: HexAddress;
  readonly treasury: HexAddress;
}

export interface TrustedWorkerBuild {
  readonly binaryPath?: string;
  readonly binarySha256: string;
  /** HTTPS location of the prebuilt release binary; verified against binarySha256. */
  readonly binaryUrl?: string;
}

export interface TrustedWorker {
  /** Effective path and hash for this machine after platform selection. */
  readonly binaryPath: string;
  readonly binarySha256: string;
  /** Set when the effective build is downloaded instead of built locally. */
  readonly binaryUrl?: string;
  /**
   * Per-platform release builds keyed by `${process.platform}-${process.arch}`
   * (linux-x64, linux-arm64, darwin-arm64, darwin-x64). Compiled binaries
   * differ per platform, so each needs its own trusted hash.
   */
  readonly platforms?: Readonly<Record<string, TrustedWorkerBuild>>;
  readonly algorithmId: Bytes32;
  readonly parameterDigest: Bytes32;
}

export interface AgentEnvironmentManifest {
  readonly schemaVersion: "1";
  readonly mode: "local-fixture" | "arc-testnet" | "arc-mainnet";
  readonly environmentId: string;
  readonly chainId: string;
  readonly apiUrl: string;
  readonly rpcUrl: string;
  /** Independent RPC operators tried in order when rpcUrl fails or rate-limits. */
  readonly rpcFallbackUrls?: readonly string[];
  readonly deployment: TrustedDeployment;
  readonly piRoot: Bytes32;
  readonly worker: TrustedWorker;
  /** Optional stateless scalar-ABI registrar for wallets that cannot pass bytes32[]. */
  readonly contentRegistrar?: HexAddress;
  /** True only for the governed Arc Mainnet production manifest. */
  readonly productionAuthorized: boolean;
}

export type LocalOperationKind =
  | "MINT"
  | "CONTENT_REGISTER"
  | "NFT_APPROVAL"
  | "ARCL_APPROVAL"
  | "LIQUIFY"
  | "REFORM";

export type LocalOperationState =
  | OperationState
  | "CONTENT_REGISTERED"
  | "APPROVAL_CONFIRMED"
  | "CONVERSION_CONFIRMED";

export interface LocalOperationRecord {
  readonly operationId: string;
  readonly kind: LocalOperationKind;
  readonly environmentId: string;
  readonly wallet: HexAddress;
  readonly chainId: string;
  readonly protocolNonce: string | null;
  readonly receiptHash: Bytes32 | null;
  readonly contentId: string | null;
  readonly parentOperationId: string | null;
  readonly state: LocalOperationState;
  readonly providerRequestId: string | null;
  readonly walletHandle: WalletHandle | null;
  readonly candidateTxHash: Bytes32 | null;
  readonly certificateExpiresAt: string | null;
  readonly issuedId: string | null;
  readonly stopRequested: boolean;
  readonly feeCommittedNative: string;
  readonly gasCommittedNative: string;
  readonly feeSpentNative: string;
  /** Gas charged to this wallet (zero when sponsored); conservative estimate while unknown. */
  readonly gasSpentNative: string;
  /** Total network Gas cost whoever paid it; null until attributed on-chain. */
  readonly networkGasCostNative: string | null;
  readonly gasSponsor: string | null;
  readonly sponsorshipStatus: "SPONSORED" | "WALLET_PAID" | "UNKNOWN";
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Who enforces the limits: the wallet/account, or this CLI's durable ledger. */
export type AuthorizationEnforcement = "wallet" | "session";

export interface ContinuousAuthorization {
  readonly environmentId: string;
  readonly wallet: HexAddress;
  readonly enforcement: AuthorizationEnforcement;
  readonly maxMints: number;
  readonly maxFeeNative: string;
  readonly maxGasNative: string;
  readonly expiresAt: string;
  readonly capabilityEvidence: WalletCapabilities;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

export interface BudgetSnapshot {
  readonly maxMints: number;
  readonly confirmedMints: number;
  readonly reservedMints: number;
  readonly maxFeeNative: string;
  readonly spentFeeNative: string;
  readonly reservedFeeNative: string;
  readonly maxGasNative: string;
  readonly spentGasNative: string;
  readonly reservedGasNative: string;
  readonly expiresAt: string;
}

export type { CliCommand, CliEnvelope } from "@arcals/protocol";

/** Lifecycle stages reported while a command runs (JSONL on stderr with --progress jsonl). */
export type ProgressStage =
  | "WALLET_DEPLOYING"
  | "SESSION_REUSED"
  | "AUTHENTICATING"
  | "CHALLENGE_ISSUED"
  | "COMPUTING"
  | "VERIFYING"
  | "CERTIFICATE_READY"
  | "WALLET_SUBMITTING"
  | "TX_CONFIRMED"
  | "CONTENT_REGISTERING"
  | "COMPLETE";

export interface ProgressEvent {
  readonly type: "progress";
  readonly stage: ProgressStage;
  readonly at: string;
  readonly operationId: string | null;
  readonly detail: Readonly<Record<string, string>>;
}
