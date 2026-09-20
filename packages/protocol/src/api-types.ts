import type {
  ContentStatus,
  FormState,
  OperationState,
  WalletHandle,
} from "./types.js";

export type DecimalString = string;

export interface ApiMeta {
  readonly environmentId: string;
  readonly asOf: string;
  readonly indexedBlock: DecimalString | null;
  readonly indexedBlockHash: string | null;
  readonly chainTip: DecimalString | null;
  readonly stale: boolean;
}

export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly action: string;
  readonly operationId: string | null;
  readonly details: Record<string, unknown> | null;
}

export interface ApiEnvelope<T> {
  readonly ok: boolean;
  readonly schemaVersion: "1";
  readonly requestId: string;
  readonly data: T | null;
  readonly error: ApiError | null;
  readonly meta: ApiMeta;
}

export interface ChallengeJson {
  readonly protocolVersion: 1;
  readonly configDigest: string;
  readonly challengeId: string;
  readonly epochId: DecimalString;
  readonly minter: string;
  readonly mintNonce: DecimalString;
  readonly challengeInput: string;
  readonly mintFee: DecimalString;
  readonly validAfter: DecimalString;
  readonly expiresAt: DecimalString;
  readonly signerVersion: DecimalString;
}

export interface WorkCertificateJson {
  readonly protocolVersion: 1;
  readonly challengeHash: string;
  readonly workNonce: DecimalString;
  readonly randomxHash: string;
  readonly issuedAt: DecimalString;
  readonly expiresAt: DecimalString;
  readonly signerVersion: DecimalString;
}

export interface ArcalDto {
  readonly environmentId: string;
  readonly id: DecimalString;
  readonly originalMinter: string;
  readonly owner: string;
  readonly contentStatus: ContentStatus;
  readonly formState: FormState;
  readonly startDigit: DecimalString;
  readonly endDigit: DecimalString;
  readonly contentHash: string | null;
  readonly datasetRoot: string;
  readonly packedDigitsUrl: string | null;
  readonly workReceiptHash: string;
  readonly workVerification: "verified" | "unverified";
  readonly queuePosition: DecimalString | null;
  readonly lastUpdatedBlock: DecimalString;
}

export type WalletActivityKind =
  "MINT" | "NFT_TRANSFER_IN" | "NFT_TRANSFER_OUT" | "LIQUIFY" | "REFORM";

export interface WalletActivityDto {
  readonly environmentId: string;
  readonly wallet: string;
  readonly kind: WalletActivityKind;
  readonly transactionHash: string;
  readonly blockNumber: DecimalString;
  readonly logIndex: number;
  readonly arcalId: DecimalString;
  readonly counterparty: string | null;
  readonly nativeDelta: string;
  readonly arclDelta: string;
  readonly nftDelta: -1 | 0 | 1;
}

export interface OperationDto {
  readonly operationId: string;
  readonly state: OperationState;
  readonly walletHandle: WalletHandle | null;
  readonly stopRequested: boolean;
  readonly updatedAt: string;
}

export interface PiProofDto {
  readonly datasetId: string;
  readonly id: DecimalString;
  readonly packedDigits: string;
  readonly proof: readonly string[];
  readonly contentHash: string;
  readonly root: string;
}

export interface DeploymentDto {
  readonly core: string | null;
  readonly base: string | null;
  readonly mirror: string | null;
  readonly vault: string | null;
  readonly controller: string | null;
  readonly treasury: string | null;
}

export interface WorkConfigDto {
  readonly protocolVersion: 1;
  readonly algorithmId: string;
  readonly parameterDigest: string;
  readonly epochSeconds: DecimalString;
  readonly keyLeadSeconds: DecimalString;
  readonly maxChallengeTtl: DecimalString;
  readonly maxCertificateTtl: DecimalString;
  readonly target: DecimalString;
  readonly effectiveEpoch: DecimalString;
  readonly configDigest: string;
}

export interface EpochDto {
  readonly epochId: DecimalString;
  readonly configDigest: string;
  readonly epochKey: string;
  readonly validFrom: DecimalString;
  readonly validUntil: DecimalString;
  readonly anchorBlockNumber: DecimalString;
  readonly anchorBlockHash: string;
}

export interface ConfigDto {
  readonly environmentId: string;
  readonly chainId: DecimalString;
  readonly deployment: DeploymentDto;
  readonly piRoot: string | null;
  readonly workConfig: WorkConfigDto | null;
  readonly epoch: EpochDto | null;
  readonly capabilities: Readonly<Record<string, boolean>>;
}

export interface MintDto {
  readonly txHash: string;
  readonly status: "PENDING" | "FINAL" | "REVERTED" | "RECOVERY_REQUIRED";
  readonly issuedId: DecimalString | null;
  readonly receiptHash: string | null;
  readonly workVerification: "verified" | "unverified" | "unknown";
}

export interface VaultDto {
  readonly head: DecimalString;
  readonly tail: DecimalString;
  readonly bankedCount: DecimalString;
  readonly nextId: DecimalString | null;
  readonly conversionOpen: boolean;
}

export interface StatsDto {
  readonly reserveMintedCount: DecimalString;
  readonly mintPaused: boolean;
  readonly minted: DecimalString;
  readonly reserveArcl: DecimalString;
  readonly externalArcl: DecimalString;
  readonly bankedCount: DecimalString;
  readonly mintRevenueNative: DecimalString;
}

export const CLI_COMMANDS = [
  "preflight",
  "wallet.setup",
  "mine.once",
  "authorize",
  "run",
  "status",
  "stop",
  "verify-receipt",
  "content.register",
  "form.liquify",
  "form.reform",
] as const;

export type CliCommand = (typeof CLI_COMMANDS)[number];

export interface CliEnvelope {
  readonly ok: boolean;
  readonly schemaVersion: "1";
  readonly command: CliCommand;
  readonly state: string;
  readonly operationId: string | null;
  readonly chainId: DecimalString | null;
  readonly wallet: string | null;
  readonly txHash: string | null;
  readonly data: Record<string, unknown>;
  readonly error: ApiError | null;
  readonly asOf: string;
}
