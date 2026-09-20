import { keccak256, decodeFunctionData } from "viem";
import { arcalMirrorAbi } from "@arcals/contract-bindings";
import { EoaWalletAdapter } from "./dist/index.js";
import { assertGasBudget, reservedGas } from "./evm-policy.mjs";

export function reservedTotalSpend(operations) {
  return operations.reduce(
    (sum, operation) =>
      sum +
      BigInt(operation.feeCommittedNative ?? 0) +
      (BigInt(operation.gasCommittedNative) > BigInt(operation.gasSpentNative)
        ? BigInt(operation.gasCommittedNative)
        : BigInt(operation.gasSpentNative)),
    0n,
  );
}

export function createBoundedWallet({
  guard,
  manifest,
  config,
  operations,
  publicClient,
  walletClient,
  account,
  address,
  limits,
  broadcasters,
  totalSpendCapNative,
}) {
  return class BoundedWallet extends EoaWalletAdapter {
    quotes = new Map();
    pending = new Map();
    key(call) {
      return `${call.chainId}:${call.to.toLowerCase()}:${call.valueNative}:${call.data}`;
    }
    checkCall(call) {
      guard();
      if (call.chainId !== 5042n) throw new Error("Wrong call chain");
      if (
        call.to.toLowerCase() ===
          manifest.deployment.controller.toLowerCase() &&
        call.data.startsWith("0x88e832cc") &&
        call.valueNative === 10n ** 17n
      ) {
        const attempts = operations().filter(
          (o) =>
            o.kind === "MINT" &&
            (o.walletHandle !== null || o.state === "MINT_CONFIRMED"),
        );
        if (attempts.length >= config.count)
          throw new Error("MINT_ATTEMPT_LIMIT");
        return;
      }
      if (
        call.to.toLowerCase() === manifest.deployment.mirror.toLowerCase() &&
        call.valueNative === 0n
      ) {
        const decoded = decodeFunctionData({
          abi: arcalMirrorAbi,
          data: call.data,
        });
        if (
          decoded.functionName === "registerContent" &&
          operations().some(
            (o) =>
              o.state === "MINT_CONFIRMED" &&
              o.issuedId === String(decoded.args[0]),
          )
        )
          return;
      }
      throw new Error("Call outside batch allowlist");
    }
    async authenticate(message) {
      guard();
      return super.authenticate(message);
    }
    async estimateFees(call) {
      this.checkCall(call);
      const estimate = await publicClient.estimateGas({
        account: address,
        to: call.to,
        data: call.data,
        value: call.valueNative,
      });
      const fees = await publicClient.estimateFeesPerGas();
      const gas = (estimate * 120n + 99n) / 100n;
      const feeFields =
        fees.maxFeePerGas !== undefined
          ? {
              maxFeePerGas: fees.maxFeePerGas,
              maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
            }
          : { gasPrice: fees.gasPrice };
      const maxGasNative = gas * (fees.maxFeePerGas ?? fees.gasPrice);
      if (reservedGas(operations()) + maxGasNative > limits.gas)
        throw new Error("TOTAL_GAS_BUDGET_EXCEEDED");
      if (
        totalSpendCapNative !== undefined &&
        reservedTotalSpend(operations()) + call.valueNative + maxGasNative >
          totalSpendCapNative
      ) {
        throw new Error(
          "INSUFFICIENT_FUNDS: remaining session balance cannot cover another mint and its maximum gas",
        );
      }
      this.quotes.set(this.key(call), { gas, ...feeFields });
      return { gasLimit: gas, maxGasNative };
    }
    async prepareSubmission(id, call) {
      this.checkCall(call);
      assertGasBudget(operations(), limits.gas);
      if (
        totalSpendCapNative !== undefined &&
        reservedTotalSpend(operations()) > totalSpendCapNative
      ) {
        throw new Error("INSUFFICIENT_FUNDS: session spend cap exceeded");
      }
      const fees = this.quotes.get(this.key(call));
      if (!fees) throw new Error("Missing bounded fee quote");
      const request = await walletClient.prepareTransactionRequest({
        account,
        chain: walletClient.chain,
        to: call.to,
        data: call.data,
        value: call.valueNative,
        ...fees,
      });
      if (
        request.chainId !== 5042 ||
        request.gas !== fees.gas ||
        request.value !== call.valueNative ||
        request.to.toLowerCase() !== call.to.toLowerCase() ||
        request.data !== call.data ||
        (fees.maxFeePerGas !== undefined &&
          (request.maxFeePerGas !== fees.maxFeePerGas ||
            request.maxPriorityFeePerGas !== fees.maxPriorityFeePerGas)) ||
        (fees.gasPrice !== undefined && request.gasPrice !== fees.gasPrice)
      )
        throw new Error("Prepared transaction differs from bounded quote");
      guard();
      const serialized = await account.signTransaction(request);
      const handle = {
        kind: "transaction",
        chainId: "5042",
        hash: keccak256(serialized),
        sender: address,
        transactionNonce: String(request.nonce),
      };
      this.pending.set(id, { serialized, handle });
      return handle;
    }
    async querySubmission(handle) {
      let result = await super.querySubmission(handle);
      // RPC receipt indexing can lag the account nonce. A higher nonce alone
      // must not turn a successful but not-yet-indexed transaction into failure.
      if (result.status === "REPLACED") {
        for (let attempt = 0; attempt < 3; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          result = await super.querySubmission(handle);
          if (result.status !== "REPLACED") return result;
        }
        return { ...result, status: "UNKNOWN" };
      }
      return result;
    }
    async submitCall(id) {
      guard();
      const prepared = this.pending.get(id);
      if (!prepared) throw new Error("Missing journaled transaction");
      const clients = broadcasters?.length ? broadcasters : [publicClient];
      const hash = await Promise.any(
        clients.map(async (client) => {
          const candidate = await client.sendRawTransaction({
            serializedTransaction: prepared.serialized,
          });
          if (candidate.toLowerCase() !== prepared.handle.hash.toLowerCase())
            throw new Error("Transaction hash mismatch");
          return candidate;
        }),
      ).catch((error) => {
        const cause =
          error instanceof AggregateError
            ? error.errors.find((item) => item instanceof Error)
            : error;
        throw new Error(
          `Transaction broadcast failed${cause instanceof Error ? `: ${cause.message}` : ""}`,
        );
      });
      if (hash.toLowerCase() !== prepared.handle.hash.toLowerCase())
        throw new Error("Transaction hash mismatch");
      this.pending.delete(id);
      return prepared.handle;
    }
  };
}
