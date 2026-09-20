import type { Bytes32, HexAddress, WalletHandle } from "@arcals/protocol";
import type { ContractCall } from "@arcals/sdk";
import type {
  Account,
  Hex,
  PublicClient,
  WalletClient,
  TransactionSerializable,
} from "viem";
import { keccak256 } from "viem";

import type {
  SubmissionResult,
  WalletAdapter,
  WalletCapabilities,
  WalletFeeQuote,
  WalletMintAuthorizationRequest,
  WalletSimulation,
} from "./types.js";
import { unsupportedCapabilities } from "./types.js";

function lower(address: string): HexAddress {
  return address.toLowerCase() as HexAddress;
}

function transactionResult(input: {
  readonly status: SubmissionResult["status"];
  readonly handle: WalletHandle | null;
  readonly transactionHash?: Bytes32 | null;
  readonly replacementHash?: Bytes32 | null;
  readonly gasSpentNative?: bigint | null;
  readonly blockNumber?: bigint | null;
}): SubmissionResult {
  // Plain EOAs always pay their own Gas.
  const gas = input.gasSpentNative ?? null;
  return {
    status: input.status,
    handle: input.handle,
    transactionHash: input.transactionHash ?? null,
    replacementHash: input.replacementHash ?? null,
    gasSpentNative: gas,
    blockNumber: input.blockNumber ?? null,
    networkGasCostNative: gas,
    gasSponsor: null,
    sponsorshipStatus: gas === null ? "UNKNOWN" : "WALLET_PAID",
  };
}

export interface EoaWalletOptions {
  readonly adapterId?: string;
  readonly mode?: "manual" | "development";
  readonly account: Account;
  readonly chainId: bigint;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
}

export class EoaWalletAdapter implements WalletAdapter {
  readonly adapterId: string;
  readonly mode: "manual" | "development";
  private readonly prepared = new Map<
    string,
    { readonly handle: WalletHandle; readonly serialized: Hex }
  >();

  constructor(private readonly options: EoaWalletOptions) {
    if (options.account.address === undefined) {
      throw new Error("EOA adapter requires an account address");
    }
    this.adapterId = options.adapterId ?? "eoa";
    this.mode = options.mode ?? "manual";
  }

  async getAddress(): Promise<HexAddress> {
    return lower(this.options.account.address);
  }

  async getChainId(): Promise<bigint> {
    return this.options.chainId;
  }

  async getNativeBalance(): Promise<bigint> {
    return this.options.publicClient.getBalance({
      address: await this.getAddress(),
    });
  }

  async getCapabilities(): Promise<WalletCapabilities> {
    const result = unsupportedCapabilities("runtime:eoa-adapter");
    for (const name of [
      "chain",
      "nativeValue",
      "erc721Receive",
      "authenticationSignature",
    ] as const) {
      result[name] = {
        supported: true,
        enforcement: "account",
        evidenceRef: "runtime:eoa-adapter",
      };
    }
    return result;
  }

  async configureMintAuthorization(
    _request: WalletMintAuthorizationRequest,
  ): Promise<WalletCapabilities> {
    throw new Error(
      "WALLET_CAPABILITY_UNAVAILABLE: a plain EOA has no hard session budget",
    );
  }

  async authenticate(message: string): Promise<Hex> {
    return this.options.walletClient.signMessage({
      account: this.options.account,
      message,
    });
  }

  async simulateCall(call: ContractCall): Promise<WalletSimulation> {
    try {
      await this.options.publicClient.call({
        account: await this.getAddress(),
        to: call.to,
        data: call.data,
        value: call.valueNative,
      });
      return { success: true, diagnostic: null };
    } catch (error) {
      return {
        success: false,
        diagnostic:
          error instanceof Error ? error.message : "contract simulation failed",
      };
    }
  }

  async estimateFees(call: ContractCall): Promise<WalletFeeQuote> {
    const gasLimit = await this.options.publicClient.estimateGas({
      account: await this.getAddress(),
      to: call.to,
      data: call.data,
      value: call.valueNative,
    });
    const fees = await this.options.publicClient.estimateFeesPerGas();
    const price = fees.maxFeePerGas ?? fees.gasPrice;
    return { gasLimit, maxGasNative: gasLimit * price };
  }

  async prepareSubmission(
    requestId: string,
    call: ContractCall,
  ): Promise<WalletHandle> {
    if (this.options.account.signTransaction === undefined) {
      throw new Error("EOA account cannot sign a transaction locally");
    }
    const request = await this.options.walletClient.prepareTransactionRequest({
      account: this.options.account,
      chain: null,
      to: call.to,
      data: call.data,
      value: call.valueNative,
    });
    const serialized = await this.options.account.signTransaction(
      request as TransactionSerializable,
    );
    const handle: WalletHandle = {
      kind: "transaction",
      chainId: call.chainId.toString(),
      hash: keccak256(serialized),
      sender: await this.getAddress(),
      transactionNonce: request.nonce.toString(),
    };
    this.prepared.set(requestId, { handle, serialized });
    return handle;
  }

  async submitCall(
    requestId: string,
    call: ContractCall,
  ): Promise<WalletHandle> {
    if (requestId.length === 0) throw new RangeError("requestId is required");
    const prepared = this.prepared.get(requestId);
    if (prepared === undefined) {
      throw new Error("EOA submission was not prepared and journaled first");
    }
    const hash = await this.options.publicClient.sendRawTransaction({
      serializedTransaction: prepared.serialized,
    });
    if (prepared.handle.kind !== "transaction") {
      throw new Error("unreachable EOA handle type");
    }
    if (hash.toLowerCase() !== prepared.handle.hash.toLowerCase()) {
      throw new Error(
        "broadcast transaction hash differs from the prepared handle",
      );
    }
    return prepared.handle;
  }

  async querySubmission(handle: WalletHandle): Promise<SubmissionResult> {
    if (handle.kind !== "transaction") {
      return transactionResult({ status: "UNKNOWN", handle });
    }
    try {
      const receipt = await this.options.publicClient.getTransactionReceipt({
        hash: handle.hash,
      });
      return transactionResult({
        status: receipt.status === "success" ? "CONFIRMED" : "REVERTED",
        handle,
        transactionHash: handle.hash,
        gasSpentNative: receipt.gasUsed * receipt.effectiveGasPrice,
        blockNumber: receipt.blockNumber,
      });
    } catch {
      try {
        await this.options.publicClient.getTransaction({ hash: handle.hash });
        return transactionResult({
          status: "PENDING",
          handle,
          transactionHash: handle.hash,
        });
      } catch {
        if (handle.transactionNonce !== undefined) {
          const confirmedNonce =
            await this.options.publicClient.getTransactionCount({
              address: handle.sender,
              blockTag: "latest",
            });
          if (BigInt(confirmedNonce) > BigInt(handle.transactionNonce)) {
            return transactionResult({
              status: "REPLACED",
              handle,
              transactionHash: handle.hash,
            });
          }
        }
        return transactionResult({
          status: "NOT_FOUND",
          handle,
          transactionHash: handle.hash,
        });
      }
    }
  }

  async queryRequest(_requestId: string): Promise<SubmissionResult> {
    const prepared = this.prepared.get(_requestId);
    return prepared === undefined
      ? transactionResult({ status: "UNKNOWN", handle: null })
      : this.querySubmission(prepared.handle);
  }

  async revokeSession(): Promise<void> {
    // A plain EOA has no restricted session to revoke.
  }
}

export interface RpcUnlockedWalletOptions {
  readonly address: HexAddress;
  readonly chainId: bigint;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
}

export class RpcUnlockedWalletAdapter implements WalletAdapter {
  readonly adapterId = "rpc-unlocked-local";
  readonly mode = "development" as const;

  constructor(private readonly options: RpcUnlockedWalletOptions) {}

  async getAddress(): Promise<HexAddress> {
    return lower(this.options.address);
  }

  async getChainId(): Promise<bigint> {
    return this.options.chainId;
  }

  async getNativeBalance(): Promise<bigint> {
    return this.options.publicClient.getBalance({
      address: this.options.address,
    });
  }

  async getCapabilities(): Promise<WalletCapabilities> {
    const result = unsupportedCapabilities(
      "runtime:local-rpc-unlocked-account",
    );
    for (const name of [
      "chain",
      "nativeValue",
      "erc721Receive",
      "authenticationSignature",
    ] as const) {
      result[name] = {
        supported: true,
        enforcement: "account",
        evidenceRef: "runtime:local-rpc-unlocked-account",
      };
    }
    return result;
  }

  async configureMintAuthorization(
    _request: WalletMintAuthorizationRequest,
  ): Promise<WalletCapabilities> {
    throw new Error(
      "WALLET_CAPABILITY_UNAVAILABLE: an unlocked RPC account has no hard session budget",
    );
  }

  async authenticate(message: string): Promise<Hex> {
    return this.options.walletClient.signMessage({
      account: this.options.address,
      message,
    });
  }

  async simulateCall(call: ContractCall): Promise<WalletSimulation> {
    try {
      await this.options.publicClient.call({
        account: this.options.address,
        to: call.to,
        data: call.data,
        value: call.valueNative,
      });
      return { success: true, diagnostic: null };
    } catch (error) {
      return {
        success: false,
        diagnostic:
          error instanceof Error ? error.message : "contract simulation failed",
      };
    }
  }

  async estimateFees(call: ContractCall): Promise<WalletFeeQuote> {
    const gasLimit = await this.options.publicClient.estimateGas({
      account: this.options.address,
      to: call.to,
      data: call.data,
      value: call.valueNative,
    });
    const fees = await this.options.publicClient.estimateFeesPerGas();
    return {
      gasLimit,
      maxGasNative: gasLimit * (fees.maxFeePerGas ?? fees.gasPrice),
    };
  }

  async prepareSubmission(
    _requestId: string,
    _call: ContractCall,
  ): Promise<WalletHandle | null> {
    return null;
  }

  async submitCall(
    requestId: string,
    call: ContractCall,
  ): Promise<WalletHandle> {
    if (requestId.length === 0) throw new RangeError("requestId is required");
    const hash = (await this.options.walletClient.sendTransaction({
      account: this.options.address,
      chain: null,
      to: call.to,
      data: call.data,
      value: call.valueNative,
    })) as Bytes32;
    const transaction = await this.options.publicClient.getTransaction({
      hash,
    });
    return {
      kind: "transaction",
      chainId: call.chainId.toString(),
      hash,
      sender: this.options.address,
      transactionNonce: transaction.nonce.toString(),
    };
  }

  async querySubmission(handle: WalletHandle): Promise<SubmissionResult> {
    if (handle.kind !== "transaction") {
      return transactionResult({ status: "UNKNOWN", handle });
    }
    try {
      const receipt = await this.options.publicClient.getTransactionReceipt({
        hash: handle.hash,
      });
      return transactionResult({
        status: receipt.status === "success" ? "CONFIRMED" : "REVERTED",
        handle,
        transactionHash: handle.hash,
        gasSpentNative: receipt.gasUsed * receipt.effectiveGasPrice,
        blockNumber: receipt.blockNumber,
      });
    } catch {
      try {
        await this.options.publicClient.getTransaction({ hash: handle.hash });
        return transactionResult({
          status: "PENDING",
          handle,
          transactionHash: handle.hash,
        });
      } catch {
        if (handle.transactionNonce !== undefined) {
          const confirmedNonce =
            await this.options.publicClient.getTransactionCount({
              address: handle.sender,
              blockTag: "latest",
            });
          if (BigInt(confirmedNonce) > BigInt(handle.transactionNonce)) {
            return transactionResult({
              status: "REPLACED",
              handle,
              transactionHash: handle.hash,
            });
          }
        }
        return transactionResult({
          status: "NOT_FOUND",
          handle,
          transactionHash: handle.hash,
        });
      }
    }
  }

  async queryRequest(_requestId: string): Promise<SubmissionResult> {
    return transactionResult({ status: "UNKNOWN", handle: null });
  }

  async revokeSession(): Promise<void> {
    // Development RPC accounts do not expose a restricted session.
  }
}

export interface ProviderWalletDriver {
  readonly provider: string;
  readonly address: HexAddress;
  readonly chainId: bigint;
  readonly mode: "manual" | "session" | "development";
  balance(): Promise<bigint>;
  capabilities(): Promise<WalletCapabilities>;
  configureMintAuthorization(
    request: WalletMintAuthorizationRequest,
  ): Promise<WalletCapabilities>;
  signMessage(message: string): Promise<Hex>;
  simulate(call: ContractCall): Promise<WalletSimulation>;
  estimate(call: ContractCall): Promise<WalletFeeQuote>;
  prepare?(requestId: string, call: ContractCall): Promise<void>;
  submit(
    requestId: string,
    call: ContractCall,
  ): Promise<{
    readonly providerOperationId: string;
    readonly transactionHash: Bytes32 | null;
  }>;
  queryOperation(providerOperationId: string): Promise<SubmissionResult>;
  queryRequest(requestId: string): Promise<SubmissionResult>;
  revoke(): Promise<void>;
  deploymentStatus?(): Promise<"DEPLOYED" | "UNDEPLOYED">;
  deployAccount?(): Promise<void>;
}

export class ProviderWalletAdapter implements WalletAdapter {
  readonly adapterId: string;
  readonly mode: "manual" | "session" | "development";

  constructor(private readonly driver: ProviderWalletDriver) {
    this.adapterId = `provider:${driver.provider}`;
    this.mode = driver.mode;
  }

  async getAddress(): Promise<HexAddress> {
    return lower(this.driver.address);
  }

  async getChainId(): Promise<bigint> {
    return this.driver.chainId;
  }

  async getNativeBalance(): Promise<bigint> {
    return this.driver.balance();
  }

  async getCapabilities(): Promise<WalletCapabilities> {
    return this.driver.capabilities();
  }

  async configureMintAuthorization(
    request: WalletMintAuthorizationRequest,
  ): Promise<WalletCapabilities> {
    return this.driver.configureMintAuthorization(request);
  }

  async authenticate(message: string): Promise<Hex> {
    return this.driver.signMessage(message);
  }

  async simulateCall(call: ContractCall): Promise<WalletSimulation> {
    return this.driver.simulate(call);
  }

  async estimateFees(call: ContractCall): Promise<WalletFeeQuote> {
    return this.driver.estimate(call);
  }

  async prepareSubmission(
    requestId: string,
    call: ContractCall,
  ): Promise<WalletHandle | null> {
    await this.driver.prepare?.(requestId, call);
    return null;
  }

  async submitCall(
    requestId: string,
    call: ContractCall,
  ): Promise<WalletHandle> {
    const result = await this.driver.submit(requestId, call);
    return {
      kind: "provider-operation",
      provider: this.driver.provider,
      requestId,
      operationId: result.providerOperationId,
      chainId: call.chainId.toString(),
    };
  }

  async querySubmission(handle: WalletHandle): Promise<SubmissionResult> {
    if (
      handle.kind !== "provider-operation" ||
      handle.provider !== this.driver.provider
    ) {
      return transactionResult({ status: "UNKNOWN", handle });
    }
    return this.driver.queryOperation(handle.operationId);
  }

  async queryRequest(requestId: string): Promise<SubmissionResult> {
    return this.driver.queryRequest(requestId);
  }

  async revokeSession(): Promise<void> {
    await this.driver.revoke();
  }

  async deploymentStatus(): Promise<"DEPLOYED" | "UNDEPLOYED"> {
    return this.driver.deploymentStatus?.() ?? "DEPLOYED";
  }

  async deployAccount(): Promise<void> {
    await this.driver.deployAccount?.();
  }
}

export interface UserOperationDriver {
  readonly provider: string;
  readonly address: HexAddress;
  readonly chainId: bigint;
  readonly entryPoint: HexAddress;
  capabilities(): Promise<WalletCapabilities>;
  configureMintAuthorization(
    request: WalletMintAuthorizationRequest,
  ): Promise<WalletCapabilities>;
  balance(): Promise<bigint>;
  signMessage(message: string): Promise<Hex>;
  simulate(call: ContractCall): Promise<WalletSimulation>;
  estimate(call: ContractCall): Promise<WalletFeeQuote>;
  submit(
    requestId: string,
    call: ContractCall,
  ): Promise<{
    readonly userOpHash: Bytes32;
    readonly accountNonce: bigint;
  }>;
  query(userOpHash: Bytes32): Promise<SubmissionResult>;
  queryRequest(requestId: string): Promise<SubmissionResult>;
  revoke(): Promise<void>;
}

export class UserOperationWalletAdapter implements WalletAdapter {
  readonly adapterId: string;
  readonly mode = "session" as const;

  constructor(private readonly driver: UserOperationDriver) {
    this.adapterId = `user-operation:${driver.provider}`;
  }

  async getAddress(): Promise<HexAddress> {
    return lower(this.driver.address);
  }

  async getChainId(): Promise<bigint> {
    return this.driver.chainId;
  }

  async getNativeBalance(): Promise<bigint> {
    return this.driver.balance();
  }

  async getCapabilities(): Promise<WalletCapabilities> {
    return this.driver.capabilities();
  }

  async configureMintAuthorization(
    request: WalletMintAuthorizationRequest,
  ): Promise<WalletCapabilities> {
    return this.driver.configureMintAuthorization(request);
  }

  async authenticate(message: string): Promise<Hex> {
    return this.driver.signMessage(message);
  }

  async simulateCall(call: ContractCall): Promise<WalletSimulation> {
    return this.driver.simulate(call);
  }

  async estimateFees(call: ContractCall): Promise<WalletFeeQuote> {
    return this.driver.estimate(call);
  }

  async prepareSubmission(
    _requestId: string,
    _call: ContractCall,
  ): Promise<WalletHandle | null> {
    return null;
  }

  async submitCall(
    requestId: string,
    call: ContractCall,
  ): Promise<WalletHandle> {
    const result = await this.driver.submit(requestId, call);
    return {
      kind: "user-operation",
      entryPoint: this.driver.entryPoint,
      userOpHash: result.userOpHash,
      sender: await this.getAddress(),
      accountNonce: result.accountNonce.toString(),
      chainId: call.chainId.toString(),
    };
  }

  async querySubmission(handle: WalletHandle): Promise<SubmissionResult> {
    if (handle.kind !== "user-operation") {
      return transactionResult({ status: "UNKNOWN", handle });
    }
    return this.driver.query(handle.userOpHash);
  }

  async queryRequest(requestId: string): Promise<SubmissionResult> {
    return this.driver.queryRequest(requestId);
  }

  async revokeSession(): Promise<void> {
    await this.driver.revoke();
  }
}

export class ExternalWalletAdapter extends ProviderWalletAdapter {
  constructor(driver: ProviderWalletDriver) {
    if (driver.mode !== "manual") {
      throw new Error(
        "External wallet adapter must require per-operation confirmation",
      );
    }
    super(driver);
  }
}
