import type { Bytes32, HexAddress, WalletHandle } from "@arcals/protocol";
import type { Hex } from "viem";

export interface ContractCall {
  readonly chainId: bigint;
  readonly to: HexAddress;
  readonly data: Hex;
  readonly valueNative: bigint;
}

export const WALLET_CAPABILITY_NAMES = [
  "chain",
  "nativeValue",
  "erc721Receive",
  "authenticationSignature",
  "contractAllowlist",
  "selectorAllowlist",
  "perCallValueLimit",
  "cumulativeValueLimit",
  "mintCountLimit",
  "gasLimit",
  "expiry",
  "revocation",
  "idempotentSubmission",
] as const;

export type WalletCapabilityName = (typeof WALLET_CAPABILITY_NAMES)[number];
export type CapabilityEnforcement = "wallet" | "account" | "cli" | "none";

export interface WalletCapability {
  readonly supported: boolean;
  readonly enforcement: CapabilityEnforcement;
  readonly evidenceRef: string | null;
}

export type WalletCapabilities = Record<WalletCapabilityName, WalletCapability>;

export function unsupportedCapabilities(
  evidenceRef: string | null = null,
): WalletCapabilities {
  return Object.fromEntries(
    WALLET_CAPABILITY_NAMES.map((name) => [
      name,
      { supported: false, enforcement: "none", evidenceRef },
    ]),
  ) as unknown as WalletCapabilities;
}

export function isHardCapability(capability: WalletCapability): boolean {
  return (
    capability.supported &&
    capability.evidenceRef !== null &&
    (capability.enforcement === "wallet" ||
      capability.enforcement === "account")
  );
}

export interface WalletFeeQuote {
  readonly gasLimit: bigint;
  readonly maxGasNative: bigint;
}

export interface WalletSimulation {
  readonly success: boolean;
  readonly diagnostic: string | null;
}

export interface WalletMintAuthorizationRequest {
  readonly chainId: bigint;
  readonly controller: HexAddress;
  readonly mintSelector: "0x88e832cc";
  readonly maxMints: number;
  readonly maxFeeNative: bigint;
  readonly maxGasNative: bigint;
  readonly expiresAt: Date;
}

export type SubmissionStatus =
  "NOT_FOUND" | "PENDING" | "CONFIRMED" | "REVERTED" | "REPLACED" | "UNKNOWN";

export interface SubmissionResult {
  readonly status: SubmissionStatus;
  readonly handle: WalletHandle | null;
  readonly transactionHash: Bytes32 | null;
  readonly replacementHash: Bytes32 | null;
  /**
   * Gas actually charged to the wallet: zero when a paymaster sponsored it,
   * null while unknown. Budget and user-facing spend use this value.
   */
  readonly gasSpentNative: bigint | null;
  readonly blockNumber: bigint | null;
  /** Total network Gas cost of the execution, whoever paid it. */
  readonly networkGasCostNative?: bigint | null;
  /** Paymaster that paid the Gas, when sponsored. */
  readonly gasSponsor?: HexAddress | null;
  readonly sponsorshipStatus?: "SPONSORED" | "WALLET_PAID" | "UNKNOWN";
}

export interface WalletAdapter {
  readonly adapterId: string;
  readonly mode: "manual" | "session" | "development";
  getAddress(): Promise<HexAddress>;
  getChainId(): Promise<bigint>;
  getNativeBalance(): Promise<bigint>;
  getCapabilities(): Promise<WalletCapabilities>;
  configureMintAuthorization(
    request: WalletMintAuthorizationRequest,
  ): Promise<WalletCapabilities>;
  authenticate(message: string): Promise<Hex>;
  simulateCall(call: ContractCall): Promise<WalletSimulation>;
  estimateFees(call: ContractCall): Promise<WalletFeeQuote>;
  prepareSubmission(
    requestId: string,
    call: ContractCall,
  ): Promise<WalletHandle | null>;
  submitCall(requestId: string, call: ContractCall): Promise<WalletHandle>;
  querySubmission(handle: WalletHandle): Promise<SubmissionResult>;
  queryRequest(requestId: string): Promise<SubmissionResult>;
  revokeSession(): Promise<void>;
  /**
   * Smart-contract wallets that deploy lazily cannot sign until their first
   * transaction deploys them.
   * Wallets without these methods are always usable.
   */
  deploymentStatus?(): Promise<"DEPLOYED" | "UNDEPLOYED">;
  /** Deploys the account with an asset-free transaction and waits for code. */
  deployAccount?(): Promise<void>;
}
