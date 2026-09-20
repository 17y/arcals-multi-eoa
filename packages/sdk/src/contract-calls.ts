import {
  arclBaseAbi,
  arcalMirrorAbi,
  arcalsVaultAbi,
  revenueTreasuryAbi,
} from "@arcals/contract-bindings";
import { UNIT, validatePackedPiDigits } from "@arcals/protocol/browser";
import type { Bytes32, HexAddress } from "@arcals/protocol/browser";
import { encodeFunctionData, isAddress } from "viem";
import type { Hex } from "viem";

import type { ContractCall } from "./wallet.js";

function assertHexAddress(
  value: string,
  field: string,
): asserts value is HexAddress {
  if (!isAddress(value, { strict: true })) {
    throw new TypeError(`${field} must be a complete EVM address`);
  }
}

function baseCall(
  chainId: bigint,
  to: HexAddress,
  data: Hex,
  valueNative = 0n,
): ContractCall {
  if (chainId < 0n) throw new RangeError("chainId must be unsigned");
  assertHexAddress(to, "contract address");
  return { chainId, to, data, valueNative };
}

export function buildRegisterContentCall(
  chainId: bigint,
  mirror: HexAddress,
  id: bigint,
  packedDigits: Hex,
  proof: readonly Bytes32[],
): ContractCall {
  if (!validatePackedPiDigits(packedDigits)) {
    throw new TypeError(
      "packedDigits must contain exactly 360 valid BCD digits",
    );
  }
  if (proof.length !== 20)
    throw new RangeError("Pi proof must have twenty siblings");
  return baseCall(
    chainId,
    mirror,
    encodeFunctionData({
      abi: arcalMirrorAbi,
      functionName: "registerContent",
      args: [id, packedDigits, [...proof]],
    }),
  );
}

export function buildLiquifyCall(
  chainId: bigint,
  vault: HexAddress,
  id: bigint,
  tokenRecipient: HexAddress,
  deadline: bigint,
): ContractCall {
  assertHexAddress(tokenRecipient, "tokenRecipient");
  return baseCall(
    chainId,
    vault,
    encodeFunctionData({
      abi: arcalsVaultAbi,
      functionName: "liquify",
      args: [id, tokenRecipient, deadline],
    }),
  );
}

export function buildReformCall(
  chainId: bigint,
  vault: HexAddress,
  nftRecipient: HexAddress,
  expectedHeadId: bigint,
  deadline: bigint,
): ContractCall {
  assertHexAddress(nftRecipient, "nftRecipient");
  return baseCall(
    chainId,
    vault,
    encodeFunctionData({
      abi: arcalsVaultAbi,
      functionName: "reform",
      args: [nftRecipient, expectedHeadId, deadline],
    }),
  );
}

export function buildNftApprovalCall(
  chainId: bigint,
  mirror: HexAddress,
  vault: HexAddress,
  id: bigint,
): ContractCall {
  assertHexAddress(vault, "vault");
  return baseCall(
    chainId,
    mirror,
    encodeFunctionData({
      abi: arcalMirrorAbi,
      functionName: "approve",
      args: [vault, id],
    }),
  );
}

export function buildArclApprovalCall(
  chainId: bigint,
  base: HexAddress,
  vault: HexAddress,
  amount: bigint = UNIT,
): ContractCall {
  assertHexAddress(vault, "vault");
  if (amount < UNIT) {
    throw new RangeError(
      "ARCL conversion approval must cover at least one UNIT",
    );
  }
  return baseCall(
    chainId,
    base,
    encodeFunctionData({
      abi: arclBaseAbi,
      functionName: "approve",
      args: [vault, amount],
    }),
  );
}

export function buildActivateConversionsCall(
  chainId: bigint,
  vault: HexAddress,
): ContractCall {
  return baseCall(
    chainId,
    vault,
    encodeFunctionData({
      abi: arcalsVaultAbi,
      functionName: "activateConversions",
    }),
  );
}

export function buildTreasuryWithdrawCall(
  chainId: bigint,
  treasury: HexAddress,
  recipient: HexAddress,
  amountNative: bigint,
): ContractCall {
  assertHexAddress(recipient, "treasury recipient");
  if (amountNative <= 0n)
    throw new RangeError("withdraw amount must be positive");
  return baseCall(
    chainId,
    treasury,
    encodeFunctionData({
      abi: revenueTreasuryAbi,
      functionName: "withdraw",
      args: [recipient, amountNative],
    }),
  );
}
