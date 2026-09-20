import { chmod, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Bytes32, HexAddress } from "@arcals/protocol";

import { SqliteOperationLedger } from "../src/ledger.js";
import { unsupportedCapabilities } from "../src/types.js";

const wallet = "0x2000000000000000000000000000000000000002" as HexAddress;
const receipt = `0x${"11".repeat(32)}` as Bytes32;
const hash = `0x${"22".repeat(32)}` as Bytes32;
const environmentId = "31337:0x1000000000000000000000000000000000000001";
const ledgers: SqliteOperationLedger[] = [];

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
});

function memory(): SqliteOperationLedger {
  const ledger = new SqliteOperationLedger(":memory:");
  ledgers.push(ledger);
  return ledger;
}

describe("durable Agent operation ledger", () => {
  it("persists the provider request before submission and blocks duplicate Mint after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arcals-ledger-"));
    await chmod(directory, 0o700);
    const path = join(directory, "ledger.sqlite");
    let ledger = new SqliteOperationLedger(path);
    ledger.beginOperation({
      operationId: "10000000-0000-4000-8000-000000000001",
      kind: "MINT",
      environmentId,
      wallet,
      chainId: 31_337n,
      protocolNonce: 0n,
      receiptHash: receipt,
      initialState: "CERTIFICATE_READY",
    });
    ledger.attachSubmission({
      operationId: "10000000-0000-4000-8000-000000000001",
      providerRequestId: "20000000-0000-4000-8000-000000000001",
    });
    ledger.markSubmissionUnknown(
      "10000000-0000-4000-8000-000000000001",
      "response lost",
    );
    ledger.close();

    ledger = new SqliteOperationLedger(path);
    ledgers.push(ledger);
    expect(ledger.canStartMint(environmentId, wallet)).toBe(false);
    expect(
      ledger.operation("10000000-0000-4000-8000-000000000001"),
    ).toMatchObject({
      state: "SUBMISSION_UNKNOWN",
      providerRequestId: "20000000-0000-4000-8000-000000000001",
      receiptHash: receipt,
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("keeps unknown value reserved and charges failed Gas without charging the Mint fee", () => {
    const ledger = memory();
    const capabilities = unsupportedCapabilities("test:wallet-policy");
    for (const name of Object.keys(
      capabilities,
    ) as (keyof typeof capabilities)[]) {
      capabilities[name] = {
        supported: true,
        enforcement: "wallet",
        evidenceRef: "test:wallet-policy",
      };
    }
    ledger.authorize({
      environmentId,
      wallet,
      maxMints: 2,
      maxFeeNative: 200_000_000_000_000_000n,
      maxGasNative: 10_000n,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      capabilities,
      enforcement: "wallet",
    });
    ledger.beginOperation({
      operationId: "10000000-0000-4000-8000-000000000002",
      kind: "MINT",
      environmentId,
      wallet,
      chainId: 31_337n,
      receiptHash: receipt,
      initialState: "CERTIFICATE_READY",
    });
    ledger.setOperationCommitment(
      "10000000-0000-4000-8000-000000000002",
      100_000_000_000_000_000n,
      1000n,
    );
    expect(ledger.budgetSnapshot(environmentId, wallet)).toMatchObject({
      reservedMints: 1,
      reservedFeeNative: "100000000000000000",
      reservedGasNative: "1000",
    });
    ledger.resolveFailure({
      operationId: "10000000-0000-4000-8000-000000000002",
      state: "REVERTED",
      gasSpentNative: 333n,
      errorCode: "INVALID_WORK",
      message: "reverted",
      transactionHash: hash,
    });
    expect(ledger.budgetSnapshot(environmentId, wallet)).toMatchObject({
      reservedMints: 0,
      spentFeeNative: "0",
      reservedFeeNative: "0",
      spentGasNative: "333",
      reservedGasNative: "0",
    });
  });

  it("stops new work without discarding a pending operation", () => {
    const ledger = memory();
    ledger.beginOperation({
      operationId: "10000000-0000-4000-8000-000000000003",
      kind: "MINT",
      environmentId,
      wallet,
      chainId: 31_337n,
      receiptHash: receipt,
      initialState: "CERTIFICATE_READY",
    });
    ledger.attachSubmission({
      operationId: "10000000-0000-4000-8000-000000000003",
      providerRequestId: "20000000-0000-4000-8000-000000000003",
      walletHandle: {
        kind: "transaction",
        chainId: "31337",
        hash,
        sender: wallet,
        transactionNonce: "7",
      },
    });
    ledger.recordWalletHandle("10000000-0000-4000-8000-000000000003", {
      kind: "transaction",
      chainId: "31337",
      hash,
      sender: wallet,
      transactionNonce: "7",
    });
    ledger.requestStop(environmentId, wallet);
    expect(ledger.isStopRequested(environmentId, wallet)).toBe(true);
    expect(ledger.unresolvedMints(environmentId, wallet)).toHaveLength(1);
    expect(
      ledger.operation("10000000-0000-4000-8000-000000000003"),
    ).toMatchObject({ state: "TX_PENDING", stopRequested: true });
  });
});
