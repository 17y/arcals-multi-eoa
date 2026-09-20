import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { Bytes32, HexAddress } from "@arcals/protocol";
import type { ContractCall } from "@arcals/sdk";

import {
  EoaWalletAdapter,
  ProviderWalletAdapter,
  UserOperationWalletAdapter,
} from "../src/wallets.js";
import { unsupportedCapabilities } from "../src/types.js";

const wallet = "0x2000000000000000000000000000000000000002" as HexAddress;
const entryPoint = "0x3000000000000000000000000000000000000003" as HexAddress;
const hash = `0x${"22".repeat(32)}` as Bytes32;
const call: ContractCall = {
  chainId: 31_337n,
  to: "0x1000000000000000000000000000000000000005",
  data: "0x12345678",
  valueNative: 100_000_000_000_000_000n,
};

const result = (kind: "provider-operation" | "user-operation") => ({
  status: "CONFIRMED" as const,
  handle:
    kind === "provider-operation"
      ? {
          kind,
          provider: "test-provider",
          requestId: "request-1",
          operationId: "provider-1",
          chainId: "31337",
        }
      : {
          kind,
          entryPoint,
          userOpHash: hash,
          sender: wallet,
          accountNonce: "9",
          chainId: "31337",
        },
  transactionHash: hash,
  replacementHash: null,
  gasSpentNative: 123n,
  blockNumber: 10n,
});

describe("wallet adapter handle boundaries", () => {
  it("pre-signs an EOA transaction so hash and transaction nonce can be journaled before broadcast", async () => {
    const account = privateKeyToAccount(toHex(randomBytes(32)));
    let serialized: `0x${string}` | null = null;
    const publicClient = {
      sendRawTransaction: async (input: {
        serializedTransaction: `0x${string}`;
      }) => {
        serialized = input.serializedTransaction;
        return keccak256(input.serializedTransaction);
      },
      getTransactionReceipt: async () => {
        throw new Error("not found");
      },
      getTransaction: async () => {
        throw new Error("not found");
      },
      getTransactionCount: async () => 8,
    } as never;
    const walletClient = {
      prepareTransactionRequest: async () => ({
        account,
        chainId: 31_337,
        gas: 21_000n,
        maxFeePerGas: 2n,
        maxPriorityFeePerGas: 1n,
        nonce: 7,
        to: call.to,
        type: "eip1559",
        value: 0n,
      }),
    } as never;
    const adapter = new EoaWalletAdapter({
      account,
      chainId: 31_337n,
      publicClient,
      walletClient,
    });
    const prepared = await adapter.prepareSubmission("request-eoa", {
      ...call,
      valueNative: 0n,
      data: "0x",
    });
    expect(prepared).toMatchObject({
      kind: "transaction",
      transactionNonce: "7",
      sender: account.address.toLowerCase(),
    });
    expect(serialized).toBeNull();
    await expect(
      adapter.submitCall("request-eoa", {
        ...call,
        valueNative: 0n,
        data: "0x",
      }),
    ).resolves.toEqual(prepared);
    expect(serialized).not.toBeNull();
    if (prepared.kind !== "transaction") throw new Error("EOA handle type");
    await expect(adapter.querySubmission(prepared)).resolves.toMatchObject({
      status: "REPLACED",
      transactionHash: prepared.hash,
    });
  });

  it("persists provider request and operation identities without converting them to tx hashes", async () => {
    const adapter = new ProviderWalletAdapter({
      provider: "test-provider",
      address: wallet,
      chainId: 31_337n,
      mode: "session",
      balance: async () => 1n,
      capabilities: async () => unsupportedCapabilities("test"),
      configureMintAuthorization: async () => unsupportedCapabilities("test"),
      signMessage: async () => "0x12",
      simulate: async () => ({ success: true, diagnostic: null }),
      estimate: async () => ({ gasLimit: 1n, maxGasNative: 1n }),
      submit: async (requestId) => ({
        providerOperationId: `provider-${requestId}`,
        transactionHash: null,
      }),
      queryOperation: async () => result("provider-operation"),
      queryRequest: async () => result("provider-operation"),
      revoke: async () => undefined,
    });
    const handle = await adapter.submitCall("request-1", call);
    expect(handle).toEqual({
      kind: "provider-operation",
      provider: "test-provider",
      requestId: "request-1",
      operationId: "provider-request-1",
      chainId: "31337",
    });
    expect(await adapter.querySubmission(handle)).toMatchObject({
      status: "CONFIRMED",
      transactionHash: hash,
    });
  });

  it("keeps userOpHash and account nonce distinct from transaction/provider handles", async () => {
    const adapter = new UserOperationWalletAdapter({
      provider: "bundler",
      address: wallet,
      chainId: 31_337n,
      entryPoint,
      balance: async () => 1n,
      capabilities: async () => unsupportedCapabilities("test"),
      configureMintAuthorization: async () => unsupportedCapabilities("test"),
      signMessage: async () => "0x12",
      simulate: async () => ({ success: true, diagnostic: null }),
      estimate: async () => ({ gasLimit: 1n, maxGasNative: 1n }),
      submit: async () => ({ userOpHash: hash, accountNonce: 9n }),
      query: async () => result("user-operation"),
      queryRequest: async () => result("user-operation"),
      revoke: async () => undefined,
    });
    const handle = await adapter.submitCall("request-2", call);
    expect(handle).toEqual({
      kind: "user-operation",
      entryPoint,
      userOpHash: hash,
      sender: wallet,
      accountNonce: "9",
      chainId: "31337",
    });
  });
});
