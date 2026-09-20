import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Bytes32, HexAddress, WalletHandle } from "@arcals/protocol";
import type { Hex } from "viem";
import type { ContractCall } from "@arcals/sdk";

import type {
  BudgetSnapshot,
  ContinuousAuthorization,
  LocalOperationKind,
  LocalOperationRecord,
  LocalOperationState,
  WalletCapabilities,
} from "./types.js";

const UNRESOLVED_STATES = new Set<LocalOperationState>([
  "CERTIFICATE_READY",
  "WALLET_SUBMITTING",
  "TX_PENDING",
  "SUBMISSION_UNKNOWN",
  "RECOVERING",
  "UNKNOWN",
]);

interface OperationInput {
  readonly operationId: string;
  readonly kind: LocalOperationKind;
  readonly environmentId: string;
  readonly wallet: HexAddress;
  readonly chainId: bigint;
  readonly protocolNonce?: bigint | null;
  readonly receiptHash?: Bytes32 | null;
  readonly contentId?: bigint | null;
  readonly parentOperationId?: string | null;
  readonly certificateExpiresAt?: Date | null;
  readonly initialState?: LocalOperationState;
  readonly pendingCall?: ContractCall;
}

function asText(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("ledger text invariant");
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null ? null : asText(value);
}

function asBoolean(value: unknown): boolean {
  return value === 1 || value === 1n;
}

function parseHandle(value: unknown): WalletHandle | null {
  const text = nullableText(value);
  return text === null ? null : (JSON.parse(text) as WalletHandle);
}

function normalizeWallet(wallet: HexAddress): HexAddress {
  return wallet.toLowerCase() as HexAddress;
}

function sum(values: readonly string[]): bigint {
  return values.reduce((total, value) => total + BigInt(value), 0n);
}

export class SqliteOperationLedger {
  private readonly database: DatabaseSync;

  constructor(readonly path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.database.exec(
      // busy_timeout: two CLI processes (e.g. status while a Mint runs) wait for
      // the write lock instead of failing immediately with "database is locked".
      "PRAGMA busy_timeout=15000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
    );
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  beginOperation(input: OperationInput): LocalOperationRecord {
    if (input.chainId < 0n) throw new RangeError("chainId must be unsigned");
    const now = new Date().toISOString();
    this.transaction(() => {
      if (
        input.kind === "MINT" &&
        !this.canStartMint(input.environmentId, input.wallet)
      ) {
        throw new Error(
          "an unresolved Mint must be recovered before starting another",
        );
      }
      this.database
        .prepare(
          `INSERT INTO operations(
             operation_id,kind,environment_id,wallet,chain_id,protocol_nonce,
             receipt_hash,content_id,parent_operation_id,state,
             certificate_expires_at,created_at,updated_at
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          input.operationId,
          input.kind,
          input.environmentId,
          normalizeWallet(input.wallet),
          input.chainId.toString(),
          input.protocolNonce?.toString() ?? null,
          input.receiptHash ?? null,
          input.contentId?.toString() ?? null,
          input.parentOperationId ?? null,
          input.initialState ?? "CREATED",
          input.certificateExpiresAt?.toISOString() ?? null,
          now,
          now,
        );
      this.event(input.operationId, input.initialState ?? "CREATED", now, null);
      if (input.pendingCall !== undefined)
        this.setPendingCall(input.operationId, input.pendingCall);
    });
    return this.requireOperation(input.operationId);
  }

  setPendingCall(operationId: string, call: ContractCall): void {
    this.database
      .prepare(
        "UPDATE operations SET pending_call=?,updated_at=? WHERE operation_id=?",
      )
      .run(
        JSON.stringify({
          chainId: call.chainId.toString(),
          to: call.to,
          data: call.data,
          valueNative: call.valueNative.toString(),
        }),
        new Date().toISOString(),
        operationId,
      );
  }

  pendingCall(operationId: string): ContractCall | null {
    const row = this.database
      .prepare("SELECT pending_call FROM operations WHERE operation_id=?")
      .get(operationId) as { pending_call?: string | null } | undefined;
    if (row?.pending_call === undefined || row.pending_call === null)
      return null;
    const stored = JSON.parse(row.pending_call) as {
      chainId: string;
      to: HexAddress;
      data: Hex;
      valueNative: string;
    };
    return {
      chainId: BigInt(stored.chainId),
      to: stored.to,
      data: stored.data,
      valueNative: BigInt(stored.valueNative),
    };
  }

  canStartMint(environmentId: string, wallet: HexAddress): boolean {
    return !this.listOperations(environmentId, wallet).some(
      (operation) =>
        operation.kind === "MINT" && UNRESOLVED_STATES.has(operation.state),
    );
  }

  operation(operationId: string): LocalOperationRecord | null {
    const row = this.database
      .prepare("SELECT * FROM operations WHERE operation_id=?")
      .get(operationId) as Record<string, unknown> | undefined;
    return row === undefined ? null : this.decodeOperation(row);
  }

  listOperations(
    environmentId: string,
    wallet: HexAddress,
  ): readonly LocalOperationRecord[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM operations WHERE environment_id=? AND wallet=?
           ORDER BY created_at, operation_id`,
        )
        .all(environmentId, normalizeWallet(wallet)) as Record<
        string,
        unknown
      >[]
    ).map((row) => this.decodeOperation(row));
  }

  unresolvedMints(
    environmentId: string,
    wallet: HexAddress,
  ): readonly LocalOperationRecord[] {
    return this.listOperations(environmentId, wallet).filter(
      (operation) =>
        operation.kind === "MINT" && UNRESOLVED_STATES.has(operation.state),
    );
  }

  attachSubmission(input: {
    readonly operationId: string;
    readonly providerRequestId: string;
    readonly walletHandle?: WalletHandle | null;
  }): LocalOperationRecord {
    const now = new Date().toISOString();
    this.transaction(() => {
      const current = this.requireOperation(input.operationId);
      if (
        current.state !== "CERTIFICATE_READY" &&
        current.state !== "CREATED" &&
        current.state !== "FAILED_RETRYABLE"
      ) {
        throw new Error(`cannot submit operation from ${current.state}`);
      }
      this.database
        .prepare(
          `UPDATE operations SET provider_request_id=?,wallet_handle=?,
             candidate_tx_hash=?,state='WALLET_SUBMITTING',updated_at=?
           WHERE operation_id=?`,
        )
        .run(
          input.providerRequestId,
          input.walletHandle === undefined || input.walletHandle === null
            ? null
            : JSON.stringify(input.walletHandle),
          input.walletHandle?.kind === "transaction"
            ? input.walletHandle.hash
            : null,
          now,
          input.operationId,
        );
      this.event(input.operationId, "WALLET_SUBMITTING", now, null);
    });
    return this.requireOperation(input.operationId);
  }

  recordWalletHandle(
    operationId: string,
    handle: WalletHandle,
  ): LocalOperationRecord {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `UPDATE operations SET wallet_handle=?,candidate_tx_hash=?,state='TX_PENDING',updated_at=?
         WHERE operation_id=? AND state IN ('WALLET_SUBMITTING','SUBMISSION_UNKNOWN','RECOVERING')`,
      )
      .run(
        JSON.stringify(handle),
        handle.kind === "transaction" ? handle.hash : null,
        now,
        operationId,
      );
    this.event(operationId, "TX_PENDING", now, null);
    return this.requireOperation(operationId);
  }

  markSubmissionUnknown(
    operationId: string,
    message: string,
  ): LocalOperationRecord {
    return this.transition(operationId, "SUBMISSION_UNKNOWN", null, message);
  }

  markRecovering(operationId: string): LocalOperationRecord {
    const current = this.requireOperation(operationId);
    if (!UNRESOLVED_STATES.has(current.state)) {
      throw new Error(
        `resolved operation ${operationId} cannot enter recovery`,
      );
    }
    return this.transition(operationId, "RECOVERING", null, null);
  }

  markPending(
    operationId: string,
    handle: WalletHandle | null,
    txHash: Bytes32 | null,
  ): LocalOperationRecord {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `UPDATE operations SET state='TX_PENDING',wallet_handle=COALESCE(?,wallet_handle),
           candidate_tx_hash=COALESCE(?,candidate_tx_hash),updated_at=? WHERE operation_id=?`,
      )
      .run(
        handle === null ? null : JSON.stringify(handle),
        txHash,
        now,
        operationId,
      );
    this.event(operationId, "TX_PENDING", now, null);
    return this.requireOperation(operationId);
  }

  resolveConfirmed(input: {
    readonly operationId: string;
    readonly transactionHash: Bytes32 | null;
    readonly issuedId?: bigint | null;
    readonly gasSpentNative: bigint;
    readonly networkGasCostNative?: bigint | null;
    readonly gasSponsor?: string | null;
    readonly sponsorshipStatus?: "SPONSORED" | "WALLET_PAID" | "UNKNOWN";
  }): LocalOperationRecord {
    if (input.gasSpentNative < 0n)
      throw new RangeError("gas spent must be unsigned");
    const current = this.requireOperation(input.operationId);
    const state: LocalOperationState =
      current.kind === "MINT"
        ? "MINT_CONFIRMED"
        : current.kind === "CONTENT_REGISTER"
          ? "CONTENT_REGISTERED"
          : current.kind === "NFT_APPROVAL" || current.kind === "ARCL_APPROVAL"
            ? "APPROVAL_CONFIRMED"
            : "CONVERSION_CONFIRMED";
    const now = new Date().toISOString();
    this.database
      .prepare(
        `UPDATE operations SET state=?,candidate_tx_hash=COALESCE(?,candidate_tx_hash),
           issued_id=COALESCE(?,issued_id),fee_spent_native=fee_committed_native,
           gas_spent_native=?,network_gas_cost_native=?,gas_sponsor=?,sponsorship_status=?,
           updated_at=?,error_code=NULL,error_message=NULL
         WHERE operation_id=?`,
      )
      .run(
        state,
        input.transactionHash,
        input.issuedId?.toString() ?? null,
        input.gasSpentNative.toString(),
        input.networkGasCostNative?.toString() ?? null,
        input.gasSponsor ?? null,
        input.sponsorshipStatus ?? "UNKNOWN",
        now,
        input.operationId,
      );
    this.event(input.operationId, state, now, null);
    return this.requireOperation(input.operationId);
  }

  /**
   * Fails an operation only while it provably was never handed to a wallet. Returns null when
   * another process attached a submission first; callers must re-read and recover instead.
   */
  resolveUnsentFailure(input: {
    readonly operationId: string;
    readonly errorCode: string;
    readonly message: string;
  }): LocalOperationRecord | null {
    const now = new Date().toISOString();
    const result = this.database
      .prepare(
        `UPDATE operations SET state='FAILED_RETRYABLE',fee_spent_native='0',gas_spent_native='0',
           error_code=?,error_message=?,updated_at=?
         WHERE operation_id=? AND provider_request_id IS NULL AND wallet_handle IS NULL
           AND state IN ('CREATED','CERTIFICATE_READY','RECOVERING','UNKNOWN','SUBMISSION_UNKNOWN')`,
      )
      .run(input.errorCode, input.message, now, input.operationId);
    if (Number(result.changes) !== 1) return null;
    this.event(input.operationId, "FAILED_RETRYABLE", now, input.errorCode);
    return this.requireOperation(input.operationId);
  }

  resolveFailure(input: {
    readonly operationId: string;
    readonly state: "REVERTED" | "REPLACED" | "FAILED" | "FAILED_RETRYABLE";
    readonly gasSpentNative: bigint;
    readonly networkGasCostNative?: bigint | null;
    readonly gasSponsor?: string | null;
    readonly sponsorshipStatus?: "SPONSORED" | "WALLET_PAID" | "UNKNOWN";
    readonly errorCode: string;
    readonly message: string;
    readonly transactionHash?: Bytes32 | null;
  }): LocalOperationRecord {
    if (input.gasSpentNative < 0n)
      throw new RangeError("gas spent must be unsigned");
    const now = new Date().toISOString();
    this.database
      .prepare(
        `UPDATE operations SET state=?,candidate_tx_hash=COALESCE(?,candidate_tx_hash),
           fee_spent_native='0',gas_spent_native=?,network_gas_cost_native=?,gas_sponsor=?,
           sponsorship_status=?,error_code=?,error_message=?,updated_at=?
         WHERE operation_id=?`,
      )
      .run(
        input.state,
        input.transactionHash ?? null,
        input.gasSpentNative.toString(),
        input.networkGasCostNative?.toString() ?? null,
        input.gasSponsor ?? null,
        input.sponsorshipStatus ?? "UNKNOWN",
        input.errorCode,
        input.message,
        now,
        input.operationId,
      );
    this.event(input.operationId, input.state, now, input.errorCode);
    return this.requireOperation(input.operationId);
  }

  setOperationCommitment(
    operationId: string,
    feeNative: bigint,
    gasNative: bigint,
  ): LocalOperationRecord {
    if (feeNative < 0n || gasNative < 0n) {
      throw new RangeError("operation commitment must be unsigned");
    }
    this.database
      .prepare(
        `UPDATE operations SET fee_committed_native=?,gas_committed_native=?,updated_at=?
         WHERE operation_id=?`,
      )
      .run(
        feeNative.toString(),
        gasNative.toString(),
        new Date().toISOString(),
        operationId,
      );
    return this.requireOperation(operationId);
  }

  requestStop(environmentId: string, wallet: HexAddress): void {
    const now = new Date().toISOString();
    this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO runner_state(environment_id,wallet,stop_requested,updated_at)
           VALUES(?,?,1,?) ON CONFLICT(environment_id,wallet)
           DO UPDATE SET stop_requested=1,updated_at=excluded.updated_at`,
        )
        .run(environmentId, normalizeWallet(wallet), now);
      this.database
        .prepare(
          `UPDATE operations SET stop_requested=1,updated_at=?
           WHERE environment_id=? AND wallet=? AND state IN
             ('CERTIFICATE_READY','WALLET_SUBMITTING','TX_PENDING','SUBMISSION_UNKNOWN','RECOVERING','UNKNOWN')`,
        )
        .run(now, environmentId, normalizeWallet(wallet));
    });
  }

  clearStop(environmentId: string, wallet: HexAddress): void {
    this.database
      .prepare(
        `INSERT INTO runner_state(environment_id,wallet,stop_requested,updated_at)
         VALUES(?,?,0,?) ON CONFLICT(environment_id,wallet)
         DO UPDATE SET stop_requested=0,updated_at=excluded.updated_at`,
      )
      .run(environmentId, normalizeWallet(wallet), new Date().toISOString());
  }

  isStopRequested(environmentId: string, wallet: HexAddress): boolean {
    const row = this.database
      .prepare(
        "SELECT stop_requested FROM runner_state WHERE environment_id=? AND wallet=?",
      )
      .get(environmentId, normalizeWallet(wallet)) as
      Record<string, unknown> | undefined;
    return row === undefined ? false : asBoolean(row.stop_requested);
  }

  authorize(input: {
    readonly environmentId: string;
    readonly wallet: HexAddress;
    readonly maxMints: number;
    readonly maxFeeNative: bigint;
    readonly maxGasNative: bigint;
    readonly expiresAt: Date;
    readonly capabilities: WalletCapabilities;
    readonly enforcement: "wallet" | "session";
  }): ContinuousAuthorization {
    if (!Number.isInteger(input.maxMints) || input.maxMints <= 0) {
      throw new RangeError("maxMints must be a positive integer");
    }
    if (input.maxFeeNative < 0n || input.maxGasNative < 0n) {
      throw new RangeError("authorization budgets must be unsigned");
    }
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO authorizations(
           environment_id,wallet,max_mints,max_fee_native,max_gas_native,
           expires_at,capability_evidence,enforcement,revoked_at,created_at
         ) VALUES(?,?,?,?,?,?,?,?,NULL,?)
         ON CONFLICT(environment_id,wallet) DO UPDATE SET
           max_mints=excluded.max_mints,max_fee_native=excluded.max_fee_native,
           max_gas_native=excluded.max_gas_native,expires_at=excluded.expires_at,
           capability_evidence=excluded.capability_evidence,
           enforcement=excluded.enforcement,revoked_at=NULL,
           created_at=excluded.created_at`,
      )
      .run(
        input.environmentId,
        normalizeWallet(input.wallet),
        input.maxMints,
        input.maxFeeNative.toString(),
        input.maxGasNative.toString(),
        input.expiresAt.toISOString(),
        JSON.stringify(input.capabilities),
        input.enforcement,
        now,
      );
    return this.requireAuthorization(input.environmentId, input.wallet);
  }

  authorization(
    environmentId: string,
    wallet: HexAddress,
  ): ContinuousAuthorization | null {
    const row = this.database
      .prepare(
        "SELECT * FROM authorizations WHERE environment_id=? AND wallet=?",
      )
      .get(environmentId, normalizeWallet(wallet)) as
      Record<string, unknown> | undefined;
    return row === undefined ? null : this.decodeAuthorization(row);
  }

  revokeAuthorization(environmentId: string, wallet: HexAddress): void {
    this.database
      .prepare(
        "UPDATE authorizations SET revoked_at=? WHERE environment_id=? AND wallet=?",
      )
      .run(new Date().toISOString(), environmentId, normalizeWallet(wallet));
  }

  budgetSnapshot(
    environmentId: string,
    wallet: HexAddress,
  ): BudgetSnapshot | null {
    const authorization = this.authorization(environmentId, wallet);
    if (authorization === null) return null;
    const mintOperations = this.listOperations(environmentId, wallet).filter(
      (operation) => operation.kind === "MINT",
    );
    const confirmed = mintOperations.filter(
      (operation) => operation.state === "MINT_CONFIRMED",
    );
    const unresolved = mintOperations.filter((operation) =>
      UNRESOLVED_STATES.has(operation.state),
    );
    return {
      maxMints: authorization.maxMints,
      confirmedMints: confirmed.length,
      reservedMints: unresolved.length,
      maxFeeNative: authorization.maxFeeNative,
      spentFeeNative: sum(
        mintOperations.map((item) => item.feeSpentNative),
      ).toString(),
      reservedFeeNative: sum(
        unresolved.map((item) => item.feeCommittedNative),
      ).toString(),
      maxGasNative: authorization.maxGasNative,
      spentGasNative: sum(
        mintOperations.map((item) => item.gasSpentNative),
      ).toString(),
      reservedGasNative: sum(
        unresolved.map((item) => item.gasCommittedNative),
      ).toString(),
      expiresAt: authorization.expiresAt,
    };
  }

  assertBudgetAvailable(
    environmentId: string,
    wallet: HexAddress,
    feeNative: bigint,
    gasNative: bigint,
    now = new Date(),
    excludeOperationId: string | null = null,
  ): BudgetSnapshot {
    const authorization = this.authorization(environmentId, wallet);
    const counted = this.budgetSnapshot(environmentId, wallet);
    if (authorization === null || counted === null) {
      throw new Error("continuous authorization is not configured");
    }
    // The operation being sent may already be reserved; never count it twice.
    const excluded =
      excludeOperationId === null ? null : this.operation(excludeOperationId);
    const snapshot =
      excluded !== null &&
      excluded.kind === "MINT" &&
      UNRESOLVED_STATES.has(excluded.state)
        ? {
            ...counted,
            reservedMints: counted.reservedMints - 1,
            reservedFeeNative: (
              BigInt(counted.reservedFeeNative) -
              BigInt(excluded.feeCommittedNative)
            ).toString(),
            reservedGasNative: (
              BigInt(counted.reservedGasNative) -
              BigInt(excluded.gasCommittedNative)
            ).toString(),
          }
        : counted;
    if (
      authorization.revokedAt !== null ||
      new Date(authorization.expiresAt) <= now
    ) {
      throw new Error("continuous authorization is revoked or expired");
    }
    if (
      snapshot.confirmedMints + snapshot.reservedMints + 1 >
      snapshot.maxMints
    ) {
      throw new Error("Mint count budget exceeded");
    }
    if (
      BigInt(snapshot.spentFeeNative) +
        BigInt(snapshot.reservedFeeNative) +
        feeNative >
      BigInt(snapshot.maxFeeNative)
    ) {
      throw new Error("Mint fee budget exceeded");
    }
    if (
      BigInt(snapshot.spentGasNative) +
        BigInt(snapshot.reservedGasNative) +
        gasNative >
      BigInt(snapshot.maxGasNative)
    ) {
      throw new Error("Gas budget exceeded");
    }
    return snapshot;
  }

  private transition(
    operationId: string,
    state: LocalOperationState,
    errorCode: string | null,
    errorMessage: string | null,
  ): LocalOperationRecord {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `UPDATE operations SET state=?,error_code=?,error_message=?,updated_at=?
         WHERE operation_id=?`,
      )
      .run(state, errorCode, errorMessage, now, operationId);
    this.event(operationId, state, now, errorCode);
    return this.requireOperation(operationId);
  }

  private event(
    operationId: string,
    state: LocalOperationState,
    at: string,
    errorCode: string | null,
  ): void {
    this.database
      .prepare(
        "INSERT INTO operation_events(operation_id,state,error_code,created_at) VALUES(?,?,?,?)",
      )
      .run(operationId, state, errorCode, at);
  }

  private requireOperation(operationId: string): LocalOperationRecord {
    const operation = this.operation(operationId);
    if (operation === null) throw new RangeError("operation is not recorded");
    return operation;
  }

  private requireAuthorization(
    environmentId: string,
    wallet: HexAddress,
  ): ContinuousAuthorization {
    const authorization = this.authorization(environmentId, wallet);
    if (authorization === null) throw new Error("authorization insert failed");
    return authorization;
  }

  private decodeOperation(row: Record<string, unknown>): LocalOperationRecord {
    return {
      operationId: asText(row.operation_id),
      kind: asText(row.kind) as LocalOperationKind,
      environmentId: asText(row.environment_id),
      wallet: asText(row.wallet) as HexAddress,
      chainId: asText(row.chain_id),
      protocolNonce: nullableText(row.protocol_nonce),
      receiptHash: nullableText(row.receipt_hash) as Bytes32 | null,
      contentId: nullableText(row.content_id),
      parentOperationId: nullableText(row.parent_operation_id),
      state: asText(row.state) as LocalOperationState,
      providerRequestId: nullableText(row.provider_request_id),
      walletHandle: parseHandle(row.wallet_handle),
      candidateTxHash: nullableText(row.candidate_tx_hash) as Bytes32 | null,
      certificateExpiresAt: nullableText(row.certificate_expires_at),
      issuedId: nullableText(row.issued_id),
      stopRequested: asBoolean(row.stop_requested),
      feeCommittedNative: asText(row.fee_committed_native),
      gasCommittedNative: asText(row.gas_committed_native),
      feeSpentNative: asText(row.fee_spent_native),
      gasSpentNative: asText(row.gas_spent_native),
      networkGasCostNative: nullableText(row.network_gas_cost_native),
      gasSponsor: nullableText(row.gas_sponsor),
      sponsorshipStatus: (nullableText(row.sponsorship_status) ??
        "UNKNOWN") as LocalOperationRecord["sponsorshipStatus"],
      errorCode: nullableText(row.error_code),
      errorMessage: nullableText(row.error_message),
      createdAt: asText(row.created_at),
      updatedAt: asText(row.updated_at),
    };
  }

  private decodeAuthorization(
    row: Record<string, unknown>,
  ): ContinuousAuthorization {
    return {
      environmentId: asText(row.environment_id),
      wallet: asText(row.wallet) as HexAddress,
      maxMints: Number(row.max_mints),
      maxFeeNative: asText(row.max_fee_native),
      maxGasNative: asText(row.max_gas_native),
      expiresAt: asText(row.expires_at),
      capabilityEvidence: JSON.parse(
        asText(row.capability_evidence),
      ) as WalletCapabilities,
      enforcement: asText(row.enforcement) === "session" ? "session" : "wallet",
      revokedAt: nullableText(row.revoked_at),
      createdAt: asText(row.created_at),
    };
  }

  private transaction<T>(action: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Arcals API bearer session for this wallet, reused across CLI runs so a
   * transient failure does not force a new wallet authentication signature. The ledger
   * file is owner-only (0600). Returns null within minValidityMs of expiry.
   */
  apiSession(
    environmentId: string,
    wallet: HexAddress,
    now: Date,
    minValidityMs = 120_000,
  ): string | null {
    const row = this.database
      .prepare(
        "SELECT session_token, expires_at FROM api_sessions WHERE environment_id=? AND wallet=?",
      )
      .get(environmentId, wallet.toLowerCase()) as
      { session_token: string; expires_at: string } | undefined;
    if (row === undefined) return null;
    if (Date.parse(row.expires_at) - now.getTime() < minValidityMs) return null;
    return row.session_token;
  }

  saveApiSession(
    environmentId: string,
    wallet: HexAddress,
    sessionToken: string,
    expiresAt: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO api_sessions(environment_id, wallet, session_token, expires_at)
         VALUES(?,?,?,?)
         ON CONFLICT(environment_id, wallet) DO UPDATE SET
           session_token=excluded.session_token, expires_at=excluded.expires_at`,
      )
      .run(environmentId, wallet.toLowerCase(), sessionToken, expiresAt);
  }

  clearApiSession(environmentId: string, wallet: HexAddress): void {
    this.database
      .prepare("DELETE FROM api_sessions WHERE environment_id=? AND wallet=?")
      .run(environmentId, wallet.toLowerCase());
  }

  pendingWork(environmentId: string, wallet: HexAddress): string | null {
    const row = this.database
      .prepare(
        "SELECT payload FROM pending_work WHERE environment_id=? AND wallet=?",
      )
      .get(environmentId, normalizeWallet(wallet)) as
      { payload: string } | undefined;
    return row?.payload ?? null;
  }

  savePendingWork(
    environmentId: string,
    wallet: HexAddress,
    payload: string,
  ): void {
    this.database
      .prepare(
        "INSERT INTO pending_work(environment_id,wallet,payload) VALUES(?,?,?) ON CONFLICT(environment_id,wallet) DO UPDATE SET payload=excluded.payload",
      )
      .run(environmentId, normalizeWallet(wallet), payload);
  }

  clearPendingWork(environmentId: string, wallet: HexAddress): void {
    this.database
      .prepare("DELETE FROM pending_work WHERE environment_id=? AND wallet=?")
      .run(environmentId, normalizeWallet(wallet));
  }

  private migrate(): void {
    this.createSchema();
    const columns = this.database
      .prepare("PRAGMA table_info(operations)")
      .all() as { name: string }[];
    // Ledgers created before Gas attribution: sponsored Gas (paymaster) is network cost, not wallet spend.
    for (const [name, definition] of [
      ["network_gas_cost_native", "TEXT"],
      ["gas_sponsor", "TEXT"],
      ["sponsorship_status", "TEXT NOT NULL DEFAULT 'UNKNOWN'"],
    ] as const) {
      if (!columns.some((column) => column.name === name)) {
        this.database.exec(
          `ALTER TABLE operations ADD COLUMN ${name} ${definition}`,
        );
      }
    }
    const authorizationColumns = this.database
      .prepare("PRAGMA table_info(authorizations)")
      .all() as { name: string }[];
    if (!authorizationColumns.some((column) => column.name === "enforcement")) {
      this.database.exec(
        "ALTER TABLE authorizations ADD COLUMN enforcement TEXT NOT NULL DEFAULT 'wallet'",
      );
    }
    if (!columns.some((column) => column.name === "pending_call")) {
      // Ledgers created before resumable Mint: the exact certified call, so a Mint that was certified but never
      // handed to a wallet can be resumed with the same certificate instead of being lost.
      this.database.exec("ALTER TABLE operations ADD COLUMN pending_call TEXT");
    }
  }

  private createSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS ledger_meta(
        schema_version TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO ledger_meta(schema_version,created_at)
        VALUES('1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      CREATE TABLE IF NOT EXISTS api_sessions(
        environment_id TEXT NOT NULL,
        wallet TEXT NOT NULL,
        session_token TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY(environment_id, wallet)
      );
      CREATE TABLE IF NOT EXISTS pending_work(
        environment_id TEXT NOT NULL,
        wallet TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY(environment_id, wallet)
      );
      CREATE TABLE IF NOT EXISTS operations(
        operation_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('MINT','CONTENT_REGISTER','NFT_APPROVAL','ARCL_APPROVAL','LIQUIFY','REFORM')),
        environment_id TEXT NOT NULL,
        wallet TEXT NOT NULL,
        chain_id TEXT NOT NULL,
        protocol_nonce TEXT,
        receipt_hash TEXT,
        content_id TEXT,
        parent_operation_id TEXT,
        state TEXT NOT NULL,
        provider_request_id TEXT UNIQUE,
        wallet_handle TEXT,
        candidate_tx_hash TEXT,
        certificate_expires_at TEXT,
        issued_id TEXT,
        stop_requested INTEGER NOT NULL DEFAULT 0 CHECK(stop_requested IN (0,1)),
        fee_committed_native TEXT NOT NULL DEFAULT '0',
        gas_committed_native TEXT NOT NULL DEFAULT '0',
        fee_spent_native TEXT NOT NULL DEFAULT '0',
        gas_spent_native TEXT NOT NULL DEFAULT '0',
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(parent_operation_id) REFERENCES operations(operation_id)
      );
      CREATE INDEX IF NOT EXISTS operations_wallet_state
        ON operations(environment_id,wallet,state);
      CREATE UNIQUE INDEX IF NOT EXISTS operations_active_mint
        ON operations(environment_id,wallet)
        WHERE kind='MINT' AND state IN
          ('CERTIFICATE_READY','WALLET_SUBMITTING','TX_PENDING','SUBMISSION_UNKNOWN','RECOVERING','UNKNOWN');
      CREATE TABLE IF NOT EXISTS operation_events(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_id TEXT NOT NULL REFERENCES operations(operation_id),
        state TEXT NOT NULL,
        error_code TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runner_state(
        environment_id TEXT NOT NULL,
        wallet TEXT NOT NULL,
        stop_requested INTEGER NOT NULL CHECK(stop_requested IN (0,1)),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(environment_id,wallet)
      );
      CREATE TABLE IF NOT EXISTS authorizations(
        environment_id TEXT NOT NULL,
        wallet TEXT NOT NULL,
        max_mints INTEGER NOT NULL CHECK(max_mints > 0),
        max_fee_native TEXT NOT NULL,
        max_gas_native TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        capability_evidence TEXT NOT NULL,
        enforcement TEXT NOT NULL DEFAULT 'wallet',
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(environment_id,wallet)
      );
    `);
  }
}
