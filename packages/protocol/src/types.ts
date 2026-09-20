import type { Bytes32, HexAddress } from "./environment.js";

export interface Eip712Domain {
  readonly name: "ArcalsMint";
  readonly version: "1";
  readonly chainId: bigint;
  readonly verifyingContract: HexAddress;
}

export interface Challenge {
  readonly protocolVersion: number;
  readonly configDigest: Bytes32;
  readonly challengeId: Bytes32;
  readonly epochId: bigint;
  readonly minter: HexAddress;
  readonly mintNonce: bigint;
  readonly challengeInput: Bytes32;
  readonly mintFee: bigint;
  readonly validAfter: bigint;
  readonly expiresAt: bigint;
  readonly signerVersion: bigint;
}

export interface WorkCertificate {
  readonly protocolVersion: number;
  readonly challengeHash: Bytes32;
  readonly workNonce: bigint;
  readonly randomxHash: Bytes32;
  readonly issuedAt: bigint;
  readonly expiresAt: bigint;
  readonly signerVersion: bigint;
}

export interface WorkConfigV1 {
  readonly protocolVersion: number;
  readonly algorithmId: Bytes32;
  readonly parameterDigest: Bytes32;
  readonly epochSeconds: bigint;
  readonly keyLeadSeconds: bigint;
  readonly maxChallengeTtl: bigint;
  readonly maxCertificateTtl: bigint;
  readonly target: bigint;
  readonly effectiveEpoch: bigint;
}

export interface EpochCommitment {
  readonly epochId: bigint;
  readonly configDigest: Bytes32;
  readonly epochKey: Bytes32;
  readonly validFrom: bigint;
  readonly validUntil: bigint;
  readonly anchorBlockNumber: bigint;
  readonly anchorBlockHash: Bytes32;
}

export type ContentStatus = "PENDING_CONTENT" | "REGISTERED";
export type FormState = "UNBANKED" | "BANKED";

export const OPERATION_STATES = [
  "CREATED",
  "PREFLIGHT",
  "NEEDS_USER_AUTH",
  "CHALLENGE_READY",
  "DATASET_READY",
  "COMPUTING",
  "SOLUTION_FOUND",
  "VERIFYING",
  "CERTIFICATE_READY",
  "WALLET_SUBMITTING",
  "TX_PENDING",
  "MINT_CONFIRMED",
  "SUBMISSION_UNKNOWN",
  "RECOVERING",
  "REVERTED",
  "REPLACED",
  "UNKNOWN",
  "CANCELLED",
  "EXPIRED",
  "FAILED",
  "FAILED_RETRYABLE",
] as const;

export type OperationState = (typeof OPERATION_STATES)[number];

export interface TransactionHandle {
  readonly kind: "transaction";
  readonly chainId: string;
  readonly hash: Bytes32;
  readonly sender: HexAddress;
  readonly transactionNonce?: string;
}

export interface ProviderOperationHandle {
  readonly kind: "provider-operation";
  readonly provider: string;
  readonly requestId: string;
  readonly operationId: string;
  readonly chainId: string;
}

export interface UserOperationHandle {
  readonly kind: "user-operation";
  readonly entryPoint: HexAddress;
  readonly userOpHash: Bytes32;
  readonly sender: HexAddress;
  readonly accountNonce: string;
  readonly chainId: string;
}

export type WalletHandle =
  TransactionHandle | ProviderOperationHandle | UserOperationHandle;
