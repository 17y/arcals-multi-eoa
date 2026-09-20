import { randomUUID } from "node:crypto";

import {
  arclBaseAbi,
  arcalMirrorAbi,
  arcalsVaultAbi,
  mintControllerAbi,
} from "@arcals/contract-bindings";
import {
  MINT_FEE_NATIVE,
  PROTOCOL_ERRORS,
  UNIT,
  hashWorkCertificateTypedData,
  isProtocolErrorCode,
  createMintDomain,
  challengeFromJson,
  challengeToJson,
} from "@arcals/protocol";
import type {
  ApiError,
  ChallengeJson,
  Bytes32,
  ConfigDto,
  HexAddress,
  ProtocolErrorCode,
  WalletHandle,
  WorkCertificate,
} from "@arcals/protocol";
import {
  ArcalsApiError,
  ArcalsWorkApiClient,
  buildArclApprovalCall,
  buildLiquifyCall,
  buildMintCall,
  buildNftApprovalCall,
  buildReformCall,
  buildRegisterContentCall,
} from "@arcals/sdk";
import type { ContractCall } from "@arcals/sdk";
import type { PublicClient } from "viem";
import { decodeFunctionData } from "viem";

import { classifyFailure } from "./errors.js";
import type { ClassifiedFailure } from "./errors.js";
import { SqliteOperationLedger } from "./ledger.js";
import type { RandomXMiner } from "./randomx-miner.js";
import {
  verifyApiConfiguration,
  verifyOnchainDeployment,
  verifyWorkerIntegrity,
} from "./trust.js";
import type { ChainRecoveryGateway } from "./trust.js";
import type {
  AuthorizationEnforcement,
  AgentEnvironmentManifest,
  CliCommand,
  CliEnvelope,
  LocalOperationKind,
  LocalOperationRecord,
  SubmissionResult,
  WalletAdapter,
  WalletCapabilities,
  ProgressEvent,
  ProgressStage,
} from "./types.js";
import { WALLET_CAPABILITY_NAMES, isHardCapability } from "./types.js";

/**
 * A session authorization is enforced by this CLI's durable ledger instead of
 * the wallet: one explicit user confirmation covers at most this many Mints,
 * this much spend and this much time. The count is high enough that it never
 * interrupts a continuous run; the budget the user declares and the time
 * window are what actually bound a session.
 */
const SESSION_MAX_MINTS = 10_000;
const SESSION_MAX_DURATION_MS = 6 * 60 * 60 * 1000;

const UNATTENDED_CAPABILITIES = [
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

export interface AgentRuntimeOptions {
  readonly manifest: AgentEnvironmentManifest;
  readonly api: ArcalsWorkApiClient;
  readonly wallet: WalletAdapter;
  readonly ledger: SqliteOperationLedger;
  readonly miner: RandomXMiner;
  readonly publicClient: PublicClient;
  readonly chain: ChainRecoveryGateway;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly id?: () => string;
  readonly verificationPollMs?: number;
  readonly verificationPollLimit?: number;
  readonly stopPollMs?: number;
  readonly verifyEnvironment?: (config: ConfigDto) => Promise<void>;
  readonly verifyAssetEnvironment?: () => Promise<void>;
  /** Receives lifecycle stages as they happen; the final envelope is unchanged. */
  readonly progress?: (event: ProgressEvent) => void;
}

interface MineOnceInput {
  readonly confirmed: boolean;
  readonly unattended: boolean;
  readonly threads: number;
  /** Register Pi content from the same wallet right after the Mint confirms (user pays Gas). */
  readonly registerContent?: boolean;
}

/** Leave room for provider latency before the certificate's on-chain expiry. */
const MIN_CERTIFICATE_SEND_WINDOW_MS = 90_000;
/**
 * A certificate carries the issuer's `issuedAt`, and the controller rejects one
 * whose `issuedAt` is newer than the block it is executed against. A read RPC
 * simulates against the block that already exists, which can still be a second
 * or two older than a certificate signed moments ago, so a simulation run right
 * after certification fails while the Mint itself would succeed in the next
 * block. Re-simulate a few times across that gap before giving up.
 */
const SIMULATION_ATTEMPTS = 4;
const SIMULATION_RETRY_MS = 1_500;

function gasAttribution(result: SubmissionResult): {
  networkGasCostNative: bigint | null;
  gasSponsor: string | null;
  sponsorshipStatus: "SPONSORED" | "WALLET_PAID" | "UNKNOWN";
} {
  return {
    networkGasCostNative: result.networkGasCostNative ?? null,
    gasSponsor: result.gasSponsor ?? null,
    sponsorshipStatus: result.sponsorshipStatus ?? "UNKNOWN",
  };
}

class AgentRuntimeError extends Error {
  constructor(
    readonly code: ProtocolErrorCode,
    message: string,
    readonly operationId: string | null = null,
  ) {
    super(message);
    this.name = "AgentRuntimeError";
  }
}

function lower(address: string): HexAddress {
  return address.toLowerCase() as HexAddress;
}

function isConfirmed(operation: LocalOperationRecord): boolean {
  return [
    "MINT_CONFIRMED",
    "CONTENT_REGISTERED",
    "APPROVAL_CONFIRMED",
    "CONVERSION_CONFIRMED",
  ].includes(operation.state);
}

function isUnresolved(operation: LocalOperationRecord): boolean {
  return [
    "CERTIFICATE_READY",
    "WALLET_SUBMITTING",
    "TX_PENDING",
    "SUBMISSION_UNKNOWN",
    "RECOVERING",
    "UNKNOWN",
  ].includes(operation.state);
}

function safeError(error: unknown): ClassifiedFailure {
  return classifyFailure(
    error,
    error instanceof AgentRuntimeError
      ? { code: error.code, operationId: error.operationId }
      : undefined,
  );
}

export class AgentRuntime {
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly id: () => string;

  constructor(private readonly options: AgentRuntimeOptions) {
    this.now = options.now ?? (() => new Date());
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.id = options.id ?? randomUUID;
  }

  async preflight(): Promise<CliEnvelope> {
    return this.execute("preflight", async (wallet) => {
      const [walletChainId, balance, capabilities, config] = await Promise.all([
        this.options.wallet.getChainId(),
        this.options.wallet.getNativeBalance(),
        this.options.wallet.getCapabilities(),
        this.options.api.getConfig(),
      ]);
      if (walletChainId !== BigInt(this.options.manifest.chainId)) {
        throw new AgentRuntimeError(
          "WRONG_NETWORK",
          "Wallet chain differs from the trusted environment",
        );
      }
      await this.verifyEnvironment(config);
      if (balance < MINT_FEE_NATIVE) {
        throw new AgentRuntimeError(
          "INSUFFICIENT_FUNDS",
          "Wallet cannot cover the fixed 0.1 Native USDC Mint fee",
        );
      }
      return this.envelope("preflight", "PREFLIGHT", wallet, null, null, {
        environmentId: this.options.manifest.environmentId,
        environmentMode: this.options.manifest.mode,
        balanceNative: balance.toString(),
        mintFeeNative: MINT_FEE_NATIVE.toString(),
        controller: this.options.manifest.deployment.controller,
        recipient: wallet,
        assetRouting: this.mintAssetRouting(wallet),
        workerChecksumVerified: true,
        walletDeployment: await this.walletDeployment(),
        capabilities,
        unattendedReady: this.unattendedReady(capabilities),
        productionAuthorized: this.options.manifest.productionAuthorized,
      });
    });
  }

  async walletSetup(): Promise<CliEnvelope> {
    return this.execute("wallet.setup", async (wallet) => {
      const capabilities = await this.options.wallet.getCapabilities();
      return this.envelope(
        "wallet.setup",
        "NEEDS_USER_AUTH",
        wallet,
        null,
        null,
        {
          adapterId: this.options.wallet.adapterId,
          mode: this.options.wallet.mode,
          capabilities,
          secretsAcceptedByArguments: false,
          unattendedReady: this.unattendedReady(capabilities),
        },
      );
    });
  }

  async authorize(input: {
    readonly maxMints: number;
    readonly maxFeeNative: bigint;
    readonly maxGasNative: bigint;
    readonly expiresAt: Date;
    /**
     * "wallet" requires hard wallet/account enforcement. "session" accepts a
     * bounded authorization that this CLI enforces in its durable ledger, for
     * wallets that cannot enforce Arcals limits themselves.
     */
    readonly enforcement?: AuthorizationEnforcement;
  }): Promise<CliEnvelope> {
    return this.execute("authorize", async (wallet) => {
      if (!Number.isInteger(input.maxMints) || input.maxMints <= 0) {
        throw new AgentRuntimeError(
          "WALLET_CAPABILITY_UNAVAILABLE",
          "maxMints must be a positive integer",
        );
      }
      if (input.expiresAt <= this.now()) {
        throw new AgentRuntimeError(
          "WALLET_CAPABILITY_UNAVAILABLE",
          "Authorization expiry must be in the future",
        );
      }
      if (input.maxFeeNative < BigInt(input.maxMints) * MINT_FEE_NATIVE) {
        throw new AgentRuntimeError(
          "WALLET_CAPABILITY_UNAVAILABLE",
          "Mint budget cannot cover every requested fixed Mint fee",
        );
      }
      if (input.maxGasNative <= 0n) {
        throw new AgentRuntimeError(
          "WALLET_CAPABILITY_UNAVAILABLE",
          "Gas budget must be positive",
        );
      }
      const requested = input.enforcement ?? "wallet";
      if (requested === "session") {
        if (input.maxMints > SESSION_MAX_MINTS) {
          throw new AgentRuntimeError(
            "WALLET_CAPABILITY_UNAVAILABLE",
            `A session authorization covers at most ${String(SESSION_MAX_MINTS)} Mints`,
          );
        }
        if (
          input.expiresAt.getTime() - this.now().getTime() >
          SESSION_MAX_DURATION_MS
        ) {
          throw new AgentRuntimeError(
            "WALLET_CAPABILITY_UNAVAILABLE",
            "A session authorization lasts at most 6 hours",
          );
        }
      }
      const capabilities = await this.options.wallet
        .configureMintAuthorization({
          chainId: BigInt(this.options.manifest.chainId),
          controller: this.options.manifest.deployment.controller,
          mintSelector: "0x88e832cc",
          maxMints: input.maxMints,
          maxFeeNative: input.maxFeeNative,
          maxGasNative: input.maxGasNative,
          expiresAt: input.expiresAt,
        })
        .catch(async (error: unknown) => {
          // Wallets without Arcals policy support reject this outright; a
          // session authorization still needs their plain capability report.
          if (requested === "wallet") throw error;
          return this.options.wallet.getCapabilities();
        });
      const walletEnforced = this.unattendedReady(capabilities);
      if (!walletEnforced && requested === "wallet") {
        throw new AgentRuntimeError(
          "WALLET_CAPABILITY_UNAVAILABLE",
          "Wallet/account did not return evidence for every unattended Mint boundary; authorize a bounded session instead",
        );
      }
      const enforcement: AuthorizationEnforcement = walletEnforced
        ? "wallet"
        : "session";
      const authorization = this.options.ledger.authorize({
        environmentId: this.options.manifest.environmentId,
        wallet,
        maxMints: input.maxMints,
        maxFeeNative: input.maxFeeNative,
        maxGasNative: input.maxGasNative,
        expiresAt: input.expiresAt,
        capabilities,
        enforcement,
      });
      this.options.ledger.clearStop(
        this.options.manifest.environmentId,
        wallet,
      );
      return this.envelope("authorize", "AUTHORIZED", wallet, null, null, {
        enforcement,
        enforcedBy:
          enforcement === "wallet"
            ? "The wallet enforces every boundary on the account."
            : "This CLI enforces the count, spend and expiry in its local ledger; the wallet does not.",
        authorization,
        budget: this.options.ledger.budgetSnapshot(
          this.options.manifest.environmentId,
          wallet,
        ),
      });
    });
  }

  async mineOnce(input: MineOnceInput): Promise<CliEnvelope> {
    return this.execute("mine.once", async (wallet) => {
      if (
        this.options.ledger.isStopRequested(
          this.options.manifest.environmentId,
          wallet,
        )
      ) {
        throw new AgentRuntimeError(
          "ACTIVE_OPERATION_EXISTS",
          "Runner is stopped; authorize again or explicitly clear the stop before new work",
        );
      }
      await this.recoverOutstanding(wallet);
      const resumable = this.resumableCertifiedMint(wallet);
      if (resumable !== null) {
        if (!input.unattended && !input.confirmed) {
          return this.envelope(
            "mine.once",
            "NEEDS_USER_AUTH",
            wallet,
            resumable.operationId,
            null,
            {
              environmentId: this.options.manifest.environmentId,
              environmentMode: this.options.manifest.mode,
              mintFeeNative: MINT_FEE_NATIVE.toString(),
              recipient: wallet,
              payer: wallet,
              controller: this.options.manifest.deployment.controller,
              gasPayment: "WALLET_DEPENDENT",
              authorizationScope: "ONE_MINT",
              walletDeployment: await this.walletDeployment(),
              assetRouting: this.mintAssetRouting(wallet),
              resumesCertifiedMint: true,
              contentRegistration:
                input.registerContent === true
                  ? "AFTER_MINT_SAME_WALLET_USER_PAID_GAS"
                  : "SEPARATE",
              certificateExpiresAt: resumable.certificateExpiresAt,
              warning:
                input.registerContent === true
                  ? "A certified Mint was never sent. Confirmation sends that same Mint (no new work) and then its Pi content registration. Gas is charged to the wallet only if its provider does not sponsor it; results report sponsorshipStatus."
                  : "A certified Mint was never sent. Confirmation sends that same Mint; no new work is computed. Gas is charged to the wallet only if its provider does not sponsor it.",
            },
          );
        }
        await this.preflightConfig(wallet, input.unattended);
        await this.ensureWalletDeployed();
        await this.authenticate(wallet);
        return this.sendCertifiedMint(
          wallet,
          resumable.operationId,
          resumable.call,
          input.unattended,
          input.registerContent === true,
        );
      }
      if (
        !this.options.ledger.canStartMint(
          this.options.manifest.environmentId,
          wallet,
        )
      ) {
        throw new AgentRuntimeError(
          "ACTIVE_OPERATION_EXISTS",
          "An unresolved Mint still requires recovery",
        );
      }
      if (!input.unattended && !input.confirmed) {
        return this.envelope(
          "mine.once",
          "NEEDS_USER_AUTH",
          wallet,
          null,
          null,
          {
            environmentId: this.options.manifest.environmentId,
            environmentMode: this.options.manifest.mode,
            mintFeeNative: MINT_FEE_NATIVE.toString(),
            recipient: wallet,
            payer: wallet,
            controller: this.options.manifest.deployment.controller,
            gasPayment: "WALLET_DEPENDENT",
            authorizationScope: "ONE_MINT",
            walletDeployment: await this.walletDeployment(),
            assetRouting: this.mintAssetRouting(wallet),
            contentRegistration:
              input.registerContent === true
                ? "AFTER_MINT_SAME_WALLET_USER_PAID_GAS"
                : "SEPARATE",
            warning:
              input.registerContent === true
                ? "Confirmation authorizes one Mint and then its Pi content registration from the same wallet. Gas is charged to the wallet only if its provider does not sponsor it; results report sponsorshipStatus."
                : "Confirmation authorizes one Mint only. Gas is charged to the wallet only if its provider does not sponsor it.",
          },
        );
      }
      const config = await this.preflightConfig(wallet, input.unattended);
      if (input.unattended) {
        this.options.ledger.assertBudgetAvailable(
          this.options.manifest.environmentId,
          wallet,
          MINT_FEE_NATIVE,
          0n,
          this.now(),
        );
      }
      await this.ensureWalletDeployed();
      await this.authenticate(wallet);
      const mintNonce = await this.options.chain.nextMintNonce(wallet);
      const environmentId = this.options.manifest.environmentId;
      type PendingWork = {
        challenge: ChallengeJson;
        issuerSignature: `0x${string}`;
        workNonce?: string;
        idempotencyKey?: string;
        operationId?: string;
      };
      const storedWork = this.options.ledger.pendingWork(environmentId, wallet);
      let pending: PendingWork | null =
        storedWork === null ? null : (JSON.parse(storedWork) as PendingWork);
      if (pending !== null && BigInt(pending.challenge.mintNonce) < mintNonce) {
        this.options.ledger.clearPendingWork(environmentId, wallet);
        pending = null;
      }
      if (
        pending !== null &&
        (BigInt(pending.challenge.mintNonce) !== mintNonce ||
          pending.challenge.minter.toLowerCase() !== wallet.toLowerCase())
      ) {
        throw new AgentRuntimeError(
          "ACTIVE_OPERATION_EXISTS",
          "Saved work does not match this wallet and current mint nonce",
        );
      }
      const challenge =
        pending === null
          ? await this.issueChallengeWithSession(wallet, mintNonce)
          : {
              challenge: challengeFromJson(pending.challenge),
              issuerSignature: pending.issuerSignature,
            };
      if (pending === null) {
        pending = {
          challenge: challengeToJson(challenge.challenge),
          issuerSignature: challenge.issuerSignature,
        };
        // Commit the issued Challenge before local work starts. If the process
        // stops during RandomX, the server-side active operation can be resumed
        // instead of becoming an orphan that blocks this wallet until expiry.
        this.options.ledger.savePendingWork(
          environmentId,
          wallet,
          JSON.stringify(pending),
        );
        this.progress("CHALLENGE_ISSUED", null, {
          expiresAt: challenge.challenge.expiresAt.toString(),
        });
      }
      if (
        pending.workNonce === undefined ||
        pending.idempotencyKey === undefined
      ) {
        if (
          Number(challenge.challenge.expiresAt) * 1000 <=
          this.now().getTime()
        ) {
          this.options.ledger.clearPendingWork(environmentId, wallet);
          throw new AgentRuntimeError(
            "CHALLENGE_EXPIRED",
            "Saved work Challenge expired before computation completed",
          );
        }
        const miningAbort = new AbortController();
        const stopPoll = setInterval(() => {
          if (
            this.options.ledger.isStopRequested(
              this.options.manifest.environmentId,
              wallet,
            )
          ) {
            miningAbort.abort();
          }
        }, this.options.stopPollMs ?? 250);
        stopPoll.unref();
        let solution;
        this.progress("COMPUTING", null, {
          threads: String(input.threads),
          challengeExpiresAt: challenge.challenge.expiresAt.toString(),
        });
        try {
          solution = await this.options.miner.mine({
            challengeInput: challenge.challenge.challengeInput,
            config: config.workConfig!,
            epoch: config.epoch!,
            threads: input.threads,
            expiresAt: challenge.challenge.expiresAt,
            signal: miningAbort.signal,
          });
        } finally {
          clearInterval(stopPoll);
        }
        pending = {
          ...pending,
          workNonce: solution.workNonce.toString(),
          idempotencyKey: this.id(),
        };
        // Commit the solution BEFORE the remote request: a lost response
        // reuses both the work result and its idempotency key.
        this.options.ledger.savePendingWork(
          environmentId,
          wallet,
          JSON.stringify(pending),
        );
      }
      const workNonce = pending.workNonce;
      const idempotencyKey = pending.idempotencyKey;
      if (workNonce === undefined || idempotencyKey === undefined) {
        throw new AgentRuntimeError(
          "ACTIVE_OPERATION_EXISTS",
          "Saved work is incomplete and cannot be submitted",
        );
      }
      let operationId: string;
      try {
        operationId =
          pending.operationId ??
          (await this.options.api.submitWork({
            ...challenge,
            workNonce: BigInt(workNonce),
            idempotencyKey,
          }));
      } catch (error) {
        if (
          error instanceof ArcalsApiError &&
          ["CHALLENGE_EXPIRED", "INVALID_WORK"].includes(error.apiError.code)
        ) {
          this.options.ledger.clearPendingWork(environmentId, wallet);
        }
        throw error;
      }
      pending.operationId = operationId;
      this.options.ledger.savePendingWork(
        environmentId,
        wallet,
        JSON.stringify(pending),
      );
      this.progress("VERIFYING", operationId);
      let certified: Awaited<ReturnType<AgentRuntime["waitForCertificate"]>>;
      try {
        certified = await this.waitForCertificate(operationId);
        if (
          Number(certified.certificate.expiresAt) * 1000 <=
          this.now().getTime()
        ) {
          throw new AgentRuntimeError(
            "CERTIFICATE_EXPIRED",
            "Saved work certificate expired",
            operationId,
          );
        }
      } catch (error) {
        if (
          error instanceof AgentRuntimeError &&
          ["CERTIFICATE_EXPIRED", "CHALLENGE_EXPIRED", "INVALID_WORK"].includes(
            error.code,
          )
        ) {
          this.options.ledger.clearPendingWork(environmentId, wallet);
        }
        throw error;
      }
      this.progress("CERTIFICATE_READY", operationId);
      const receiptHash = hashWorkCertificateTypedData(
        createMintDomain(
          BigInt(this.options.manifest.chainId),
          this.options.manifest.deployment.controller,
        ),
        certified.certificate,
      );
      const call = buildMintCall(
        BigInt(this.options.manifest.chainId),
        this.options.manifest.deployment.controller,
        challenge.challenge,
        challenge.issuerSignature,
        certified.certificate,
        certified.verifierSignature,
      );
      this.options.ledger.beginOperation({
        operationId,
        kind: "MINT",
        environmentId: this.options.manifest.environmentId,
        wallet,
        chainId: BigInt(this.options.manifest.chainId),
        protocolNonce: mintNonce,
        receiptHash,
        certificateExpiresAt: new Date(
          Number(certified.certificate.expiresAt) * 1000,
        ),
        initialState: "CERTIFICATE_READY",
        pendingCall: call,
      });
      this.options.ledger.clearPendingWork(environmentId, wallet);
      return this.sendCertifiedMint(
        wallet,
        operationId,
        call,
        input.unattended,
        input.registerContent === true,
      );
    });
  }

  /** The stored call must be exactly this wallet's certified Mint for this operation. */
  private assertCertifiedMintCall(
    wallet: HexAddress,
    operationId: string,
    call: ContractCall,
  ): void {
    const { controller } = this.options.manifest.deployment;
    const chainId = BigInt(this.options.manifest.chainId);
    const operation = this.options.ledger.operation(operationId);
    let valid =
      operation !== null &&
      operation.kind === "MINT" &&
      operation.receiptHash !== null &&
      call.chainId === chainId &&
      lower(call.to) === lower(controller) &&
      call.valueNative === MINT_FEE_NATIVE;
    if (valid) {
      try {
        const decoded = decodeFunctionData({
          abi: mintControllerAbi,
          data: call.data,
        });
        const [challenge, , certificate] = decoded.args as unknown as readonly [
          { readonly minter: HexAddress },
          unknown,
          WorkCertificate,
        ];
        valid =
          decoded.functionName === "mint" &&
          lower(challenge.minter) === lower(wallet) &&
          hashWorkCertificateTypedData(
            createMintDomain(chainId, controller),
            certificate,
          ).toLowerCase() === operation!.receiptHash!.toLowerCase();
      } catch {
        valid = false;
      }
    }
    if (!valid) {
      throw new AgentRuntimeError(
        "UNTRUSTED_DEPLOYMENT",
        "Stored certified Mint does not match this wallet, Controller, fee or receipt",
        operationId,
      );
    }
  }

  /** A MINT that holds a still-valid certificate and was never handed to any wallet. */
  private resumableCertifiedMint(wallet: HexAddress): {
    operationId: string;
    call: ContractCall;
    certificateExpiresAt: string;
  } | null {
    const now = this.now().getTime();
    for (const operation of this.options.ledger.listOperations(
      this.options.manifest.environmentId,
      wallet,
    )) {
      if (
        operation.kind !== "MINT" ||
        (!isUnresolved(operation) && operation.state !== "FAILED_RETRYABLE") ||
        operation.providerRequestId !== null ||
        operation.walletHandle !== null ||
        operation.certificateExpiresAt === null ||
        Date.parse(operation.certificateExpiresAt) <= now
      ) {
        continue;
      }
      const call = this.options.ledger.pendingCall(operation.operationId);
      if (call === null) continue;
      return {
        operationId: operation.operationId,
        call,
        certificateExpiresAt: operation.certificateExpiresAt,
      };
    }
    return null;
  }

  private async sendCertifiedMint(
    wallet: HexAddress,
    operationId: string,
    call: ContractCall,
    unattended: boolean,
    registerContent: boolean,
  ): Promise<CliEnvelope> {
    this.assertCertifiedMintCall(wallet, operationId, call);
    const operation = this.options.ledger.operation(operationId);
    const expiresAt =
      operation?.certificateExpiresAt === null ||
      operation?.certificateExpiresAt === undefined
        ? 0
        : Date.parse(operation.certificateExpiresAt);
    if (expiresAt - this.now().getTime() < MIN_CERTIFICATE_SEND_WINDOW_MS) {
      // Too close to on-chain expiry to land safely; nothing is sent.
      throw new AgentRuntimeError(
        "CERTIFICATE_EXPIRED",
        "Certificate is too close to expiry to send safely; it will be released after expiry",
        operationId,
      );
    }
    let simulation = await this.options.wallet.simulateCall(call);
    for (
      let attempt = 1;
      attempt < SIMULATION_ATTEMPTS && !simulation.success;
      attempt += 1
    ) {
      await this.sleep(SIMULATION_RETRY_MS);
      simulation = await this.options.wallet.simulateCall(call);
    }
    if (!simulation.success) {
      // Keep the still-valid certificate resumable: simulation can fail for transient reasons.
      throw new AgentRuntimeError(
        "INVALID_WORK",
        simulation.diagnostic ?? "Mint simulation failed; nothing was sent",
        operationId,
      );
    }
    const fees = await this.options.wallet.estimateFees(call);
    if (unattended) {
      this.options.ledger.assertBudgetAvailable(
        this.options.manifest.environmentId,
        wallet,
        MINT_FEE_NATIVE,
        fees.maxGasNative,
        this.now(),
        operationId,
      );
    }
    this.options.ledger.setOperationCommitment(
      operationId,
      MINT_FEE_NATIVE,
      fees.maxGasNative,
    );
    this.progress("WALLET_SUBMITTING", operationId);
    const submitted = await this.submit(operationId, "MINT", call, null);
    const recovered = await this.recoverOperation(submitted);
    if (recovered.state !== "MINT_CONFIRMED") {
      return this.envelope(
        "mine.once",
        recovered.state,
        wallet,
        recovered.operationId,
        recovered.candidateTxHash,
        { operation: recovered, noSecondMintSubmitted: true },
      );
    }
    this.progress("TX_CONFIRMED", recovered.operationId, {
      issuedId: recovered.issuedId ?? "",
      txHash: recovered.candidateTxHash ?? "",
    });
    if (registerContent && recovered.issuedId !== null) {
      this.progress("CONTENT_REGISTERING", recovered.operationId, {
        issuedId: recovered.issuedId,
      });
    }
    const contentOperation =
      registerContent && recovered.issuedId !== null
        ? await this.registerContentOperation(
            wallet,
            BigInt(recovered.issuedId),
            recovered.operationId,
          )
        : null;
    const contentRegistered =
      contentOperation !== null && isConfirmed(contentOperation);
    this.progress("COMPLETE", recovered.operationId, {
      issuedId: recovered.issuedId ?? "",
      contentStatus: contentRegistered ? "REGISTERED" : "PENDING_CONTENT",
    });
    return this.envelope(
      "mine.once",
      "MINT_CONFIRMED",
      wallet,
      recovered.operationId,
      recovered.candidateTxHash,
      {
        issuedId: recovered.issuedId,
        operation: recovered,
        contentOperation,
        contentStatus: contentRegistered ? "REGISTERED" : "PENDING_CONTENT",
        assetRouting: this.mintAssetRouting(wallet),
        nextAction: contentRegistered
          ? null
          : "arcals content register --id <ID> --confirm",
      },
    );
  }

  async run(input: { readonly threads: number }): Promise<CliEnvelope> {
    return this.execute("run", async (wallet) => {
      const authorization = this.options.ledger.authorization(
        this.options.manifest.environmentId,
        wallet,
      );
      if (authorization === null || authorization.revokedAt !== null) {
        throw new AgentRuntimeError(
          "WALLET_CAPABILITY_UNAVAILABLE",
          "No active continuous authorization exists; run authorize first",
        );
      }
      if (new Date(authorization.expiresAt) <= this.now()) {
        throw new AgentRuntimeError(
          "WALLET_CAPABILITY_UNAVAILABLE",
          "The continuous authorization expired; authorize again",
        );
      }
      const results: CliEnvelope[] = [];
      while (
        !this.options.ledger.isStopRequested(
          this.options.manifest.environmentId,
          wallet,
        )
      ) {
        const budget = this.options.ledger.budgetSnapshot(
          this.options.manifest.environmentId,
          wallet,
        );
        if (
          budget === null ||
          budget.confirmedMints + budget.reservedMints >= budget.maxMints
        ) {
          break;
        }
        const result = await this.mineOnce({
          confirmed: false,
          unattended: true,
          threads: input.threads,
        });
        results.push(result);
        if (!result.ok || result.state !== "MINT_CONFIRMED") break;
      }
      return this.envelope("run", "COMPLETE", wallet, null, null, {
        completed: results.filter((item) => item.state === "MINT_CONFIRMED")
          .length,
        results,
        budget: this.options.ledger.budgetSnapshot(
          this.options.manifest.environmentId,
          wallet,
        ),
      });
    });
  }

  async status(): Promise<CliEnvelope> {
    return this.execute("status", async (wallet) => {
      await this.recoverOutstanding(wallet);
      const operations = this.options.ledger.listOperations(
        this.options.manifest.environmentId,
        wallet,
      );
      return this.envelope("status", "READY", wallet, null, null, {
        stopRequested: this.options.ledger.isStopRequested(
          this.options.manifest.environmentId,
          wallet,
        ),
        unresolved: operations.filter(isUnresolved),
        operations,
        budget: this.options.ledger.budgetSnapshot(
          this.options.manifest.environmentId,
          wallet,
        ),
      });
    });
  }

  async stop(): Promise<CliEnvelope> {
    return this.execute("stop", async (wallet) => {
      this.options.ledger.requestStop(
        this.options.manifest.environmentId,
        wallet,
      );
      this.options.ledger.revokeAuthorization(
        this.options.manifest.environmentId,
        wallet,
      );
      try {
        await this.options.wallet.revokeSession();
      } catch {
        // The local stop is authoritative for this runner; capability output records
        // whether wallet/account revocation was actually available.
      }
      const pending = this.options.ledger.unresolvedMints(
        this.options.manifest.environmentId,
        wallet,
      );
      return this.envelope("stop", "STOPPED", wallet, null, null, {
        newSubmissionsStopped: true,
        pendingStillTracked: pending.map((item) => item.operationId),
        pendingTransactionsCancelled: false,
      });
    });
  }

  async verifyReceipt(transactionHash: Bytes32): Promise<CliEnvelope> {
    return this.execute("verify-receipt", async (wallet) => {
      const mint = await this.options.api.getMint(transactionHash);
      return this.envelope(
        "verify-receipt",
        mint.status === "FINAL" ? "MINT_CONFIRMED" : mint.status,
        wallet,
        null,
        transactionHash,
        { mint },
      );
    });
  }

  async registerContent(id: bigint, confirmed: boolean): Promise<CliEnvelope> {
    return this.execute("content.register", async (wallet) => {
      if (!confirmed) {
        return this.envelope(
          "content.register",
          "NEEDS_USER_AUTH",
          wallet,
          null,
          null,
          {
            id: id.toString(),
            transactionRequired: true,
            warning:
              "Content registration is a separate Gas-paying wallet action and does not Mint again.",
          },
        );
      }
      await this.verifyAssetEnvironment(wallet);
      const operation = await this.registerContentOperation(wallet, id, null);
      return this.envelope(
        "content.register",
        operation.state,
        wallet,
        operation.operationId,
        operation.candidateTxHash,
        { id: id.toString(), operation },
      );
    });
  }

  async liquify(
    id: bigint,
    deadline: bigint,
    confirmed: boolean,
  ): Promise<CliEnvelope> {
    return this.execute("form.liquify", async (wallet) => {
      if (!confirmed) {
        return this.envelope(
          "form.liquify",
          "NEEDS_USER_AUTH",
          wallet,
          null,
          null,
          {
            id: id.toString(),
            unit: UNIT.toString(),
            tokenRecipient: wallet,
            transactions: 2,
            contentRegistration: "FIRST_IF_PENDING_USER_PAID_GAS",
            warning:
              "Approval and liquify are separate wallet actions (plus Pi content registration first if still pending); liquifying gives up exclusive access to this ID.",
          },
        );
      }
      await this.verifyAssetEnvironment(wallet);
      let contentOperation: LocalOperationRecord | null = null;
      if (!(await this.contentIsRegistered(id))) {
        contentOperation = await this.registerContentOperation(
          wallet,
          id,
          null,
        );
        if (!isConfirmed(contentOperation)) {
          return this.envelope(
            "form.liquify",
            contentOperation.state,
            wallet,
            contentOperation.operationId,
            contentOperation.candidateTxHash,
            { contentOperation, conversionSubmitted: false },
          );
        }
      }
      const approval = (await this.vaultMayTakeNft(wallet, id))
        ? null
        : await this.executeAuxiliary(
            wallet,
            "NFT_APPROVAL",
            buildNftApprovalCall(
              BigInt(this.options.manifest.chainId),
              this.options.manifest.deployment.mirror,
              this.options.manifest.deployment.vault,
              id,
            ),
            id,
          );
      if (approval !== null && !isConfirmed(approval)) {
        return this.envelope(
          "form.liquify",
          approval.state,
          wallet,
          approval.operationId,
          approval.candidateTxHash,
          { approval, conversionSubmitted: false },
        );
      }
      const conversion = await this.executeAuxiliary(
        wallet,
        "LIQUIFY",
        buildLiquifyCall(
          BigInt(this.options.manifest.chainId),
          this.options.manifest.deployment.vault,
          id,
          wallet,
          deadline,
        ),
        id,
      );
      return this.envelope(
        "form.liquify",
        conversion.state,
        wallet,
        conversion.operationId,
        conversion.candidateTxHash,
        {
          contentOperation,
          approval,
          conversion,
          unit: UNIT.toString(),
          tokenRecipient: wallet,
        },
      );
    });
  }

  async reform(
    expectedHeadId: bigint,
    deadline: bigint,
    confirmed: boolean,
  ): Promise<CliEnvelope> {
    return this.execute("form.reform", async (wallet) => {
      if (!confirmed) {
        return this.envelope(
          "form.reform",
          "NEEDS_USER_AUTH",
          wallet,
          null,
          null,
          {
            expectedHeadId: expectedHeadId.toString(),
            unit: UNIT.toString(),
            nftRecipient: wallet,
            transactions: 2,
            warning:
              "Approval and reform are separate wallet actions; FIFO does not return a depositor's original ID.",
          },
        );
      }
      await this.verifyAssetEnvironment(wallet);
      const approval = (await this.vaultMayLockArcl(wallet))
        ? null
        : await this.executeAuxiliary(
            wallet,
            "ARCL_APPROVAL",
            buildArclApprovalCall(
              BigInt(this.options.manifest.chainId),
              this.options.manifest.deployment.base,
              this.options.manifest.deployment.vault,
            ),
            null,
          );
      if (approval !== null && !isConfirmed(approval)) {
        return this.envelope(
          "form.reform",
          approval.state,
          wallet,
          approval.operationId,
          approval.candidateTxHash,
          { approval, conversionSubmitted: false },
        );
      }
      const conversion = await this.executeAuxiliary(
        wallet,
        "REFORM",
        buildReformCall(
          BigInt(this.options.manifest.chainId),
          this.options.manifest.deployment.vault,
          wallet,
          expectedHeadId,
          deadline,
        ),
        null,
      );
      return this.envelope(
        "form.reform",
        conversion.state,
        wallet,
        conversion.operationId,
        conversion.candidateTxHash,
        {
          approval,
          conversion,
          unit: UNIT.toString(),
          nftRecipient: wallet,
          expectedHeadId: expectedHeadId.toString(),
        },
      );
    });
  }

  async close(): Promise<void> {
    await this.options.miner.close();
  }

  /** Reads Mirror registration from chain. A failed read stops before any transaction. */
  private async contentIsRegistered(id: bigint): Promise<boolean> {
    try {
      return (
        (await this.options.publicClient.readContract({
          address: this.options.manifest.deployment.mirror,
          abi: arcalMirrorAbi,
          functionName: "contentRegistered",
          args: [id],
        })) === true
      );
    } catch {
      throw new AgentRuntimeError(
        "DEPENDENCY_UNAVAILABLE",
        "Could not read Pi content registration from chain; nothing was sent",
      );
    }
  }

  /** True only when chain state already lets the Vault bank this NFT; errors mean "approve". */
  private async vaultMayTakeNft(
    wallet: HexAddress,
    id: bigint,
  ): Promise<boolean> {
    const { mirror, vault } = this.options.manifest.deployment;
    try {
      const [approved, operator] = await Promise.all([
        this.options.publicClient.readContract({
          address: mirror,
          abi: arcalMirrorAbi,
          functionName: "getApproved",
          args: [id],
        }),
        this.options.publicClient.readContract({
          address: mirror,
          abi: arcalMirrorAbi,
          functionName: "isApprovedForAll",
          args: [wallet, vault],
        }),
      ]);
      return lower(String(approved)) === lower(vault) || operator === true;
    } catch {
      return false;
    }
  }

  /** True only when the existing ARCL allowance already covers one UNIT; errors mean "approve". */
  private async vaultMayLockArcl(wallet: HexAddress): Promise<boolean> {
    const { base, vault } = this.options.manifest.deployment;
    try {
      const allowance = await this.options.publicClient.readContract({
        address: base,
        abi: arclBaseAbi,
        functionName: "allowance",
        args: [wallet, vault],
      });
      return BigInt(allowance as bigint) >= UNIT;
    } catch {
      return false;
    }
  }

  private async preflightConfig(
    wallet: HexAddress,
    unattended: boolean,
  ): Promise<ConfigDto> {
    const [walletChainId, balance, config, capabilities] = await Promise.all([
      this.options.wallet.getChainId(),
      this.options.wallet.getNativeBalance(),
      this.options.api.getConfig(),
      this.options.wallet.getCapabilities(),
    ]);
    if (walletChainId !== BigInt(this.options.manifest.chainId)) {
      throw new AgentRuntimeError(
        "WRONG_NETWORK",
        "Wallet is on the wrong chain",
      );
    }
    if (balance < MINT_FEE_NATIVE) {
      throw new AgentRuntimeError(
        "INSUFFICIENT_FUNDS",
        "Wallet cannot cover the fixed 0.1 Native USDC Mint fee",
      );
    }
    await this.verifyEnvironment(config);
    if (lower(wallet) !== lower(await this.options.wallet.getAddress())) {
      throw new AgentRuntimeError(
        "WALLET_AUTH_REQUIRED",
        "Wallet identity changed",
      );
    }
    if (unattended && !this.unattendedReady(capabilities)) {
      const authorization = this.options.ledger.authorization(
        this.options.manifest.environmentId,
        wallet,
      );
      if (
        authorization === null ||
        authorization.revokedAt !== null ||
        authorization.enforcement !== "session" ||
        new Date(authorization.expiresAt) <= this.now()
      ) {
        throw new AgentRuntimeError(
          "WALLET_CAPABILITY_UNAVAILABLE",
          "Unattended Mint needs wallet enforcement or an active session authorization",
        );
      }
    }
    return config;
  }

  private mintAssetRouting(wallet: HexAddress): Record<string, unknown> {
    return {
      arcalRecipient: wallet,
      arclReserveRecipient: this.options.manifest.deployment.vault,
      arclReserveAmount: UNIT.toString(),
      mintRevenueRecipient: this.options.manifest.deployment.treasury,
      mintRevenueAmountNative: MINT_FEE_NATIVE.toString(),
      automaticNftTransfer: false,
    };
  }

  private unattendedReady(capabilities: WalletCapabilities): boolean {
    return UNATTENDED_CAPABILITIES.every((name) =>
      isHardCapability(capabilities[name]),
    );
  }

  private async verifyEnvironment(config: ConfigDto): Promise<void> {
    if (this.options.verifyEnvironment !== undefined) {
      await this.options.verifyEnvironment(config);
      return;
    }
    verifyApiConfiguration(this.options.manifest, config);
    await Promise.all([
      verifyWorkerIntegrity(this.options.manifest),
      verifyOnchainDeployment(this.options.manifest, this.options.publicClient),
    ]);
  }

  private async verifyAssetEnvironment(wallet: HexAddress): Promise<void> {
    if (
      (await this.options.wallet.getChainId()) !==
      BigInt(this.options.manifest.chainId)
    ) {
      throw new AgentRuntimeError(
        "WRONG_NETWORK",
        "Wallet is on the wrong chain",
      );
    }
    if (lower(wallet) !== lower(await this.options.wallet.getAddress())) {
      throw new AgentRuntimeError(
        "WALLET_AUTH_REQUIRED",
        "Wallet identity changed",
      );
    }
    if (this.options.verifyAssetEnvironment !== undefined) {
      await this.options.verifyAssetEnvironment();
      return;
    }
    await verifyOnchainDeployment(
      this.options.manifest,
      this.options.publicClient,
    );
  }

  /**
   * REQUIRED means the wallet is a lazily deployed smart account without code.
   * The confirmed Mint deploys it first with a zero-value self-transfer that
   * moves no assets, because the wallet cannot sign the API login before that.
   */
  private async walletDeployment(): Promise<"REQUIRED" | "NOT_REQUIRED"> {
    const status = await this.options.wallet.deploymentStatus?.();
    return status === "UNDEPLOYED" ? "REQUIRED" : "NOT_REQUIRED";
  }

  private progress(
    stage: ProgressStage,
    operationId: string | null = null,
    detail: Record<string, string> = {},
  ): void {
    try {
      this.options.progress?.({
        type: "progress",
        stage,
        at: this.now().toISOString(),
        operationId,
        detail,
      });
    } catch {
      // A broken progress sink must never affect the operation.
    }
  }

  private async ensureWalletDeployed(): Promise<void> {
    if ((await this.walletDeployment()) === "NOT_REQUIRED") return;
    this.progress("WALLET_DEPLOYING");
    try {
      await this.options.wallet.deployAccount?.();
    } catch (error) {
      throw new AgentRuntimeError(
        "WALLET_UNDEPLOYED",
        `WALLET_UNDEPLOYED: ${error instanceof Error ? error.message : "wallet deployment failed"}`,
      );
    }
    if ((await this.walletDeployment()) === "REQUIRED") {
      throw new AgentRuntimeError(
        "WALLET_UNDEPLOYED",
        "WALLET_UNDEPLOYED: the wallet still has no code after deployment",
      );
    }
  }

  private async authenticate(
    wallet: HexAddress,
    forceNewSession = false,
  ): Promise<void> {
    const environmentId = this.options.manifest.environmentId;
    if (!forceNewSession) {
      const stored = this.options.ledger.apiSession(
        environmentId,
        wallet,
        this.now(),
      );
      if (stored !== null) {
        this.options.api.setBearerToken(stored);
        this.progress("SESSION_REUSED");
        return;
      }
    }
    this.progress("AUTHENTICATING");
    const nonceKey = this.id();
    const nonce = await this.options.api.createAuthNonce({
      wallet,
      chainId: BigInt(this.options.manifest.chainId),
      idempotencyKey: nonceKey,
    });
    const signature = await this.options.wallet.authenticate(nonce.message);
    const session = await this.options.api.createAuthSession({
      message: nonce.message,
      signature,
      idempotencyKey: this.id(),
    });
    this.options.ledger.saveApiSession(
      environmentId,
      wallet,
      session.sessionToken,
      session.expiresAt,
    );
  }

  /** Issues a Challenge; a rejected stored session is replaced once. */
  private async issueChallengeWithSession(
    wallet: HexAddress,
    mintNonce: bigint,
  ): Promise<Awaited<ReturnType<ArcalsWorkApiClient["issueChallenge"]>>> {
    try {
      return await this.options.api.issueChallenge({
        wallet,
        mintNonce,
        idempotencyKey: this.id(),
      });
    } catch (error) {
      if (
        !(error instanceof ArcalsApiError) ||
        error.apiError.code !== "WALLET_AUTH_REQUIRED"
      ) {
        throw error;
      }
      this.options.ledger.clearApiSession(
        this.options.manifest.environmentId,
        wallet,
      );
      await this.authenticate(wallet, true);
      return this.options.api.issueChallenge({
        wallet,
        mintNonce,
        idempotencyKey: this.id(),
      });
    }
  }

  private async waitForCertificate(operationId: string): Promise<{
    readonly certificate: WorkCertificate;
    readonly verifierSignature: `0x${string}`;
  }> {
    const limit = this.options.verificationPollLimit ?? 300;
    for (let attempt = 0; attempt < limit; attempt += 1) {
      const state = await this.options.api.getWorkJobState(operationId);
      if (
        state.status === "CERTIFICATE_READY" &&
        state.certificate !== null &&
        state.verifierSignature !== null
      ) {
        return this.options.api.getWorkJob(operationId);
      }
      if (state.status === "REJECTED" || state.status === "EXPIRED") {
        throw new AgentRuntimeError(
          state.status === "EXPIRED" ? "CHALLENGE_EXPIRED" : "INVALID_WORK",
          state.error?.message ?? `Work job ended as ${state.status}`,
          operationId,
        );
      }
      await this.sleep(this.options.verificationPollMs ?? 200);
    }
    throw new AgentRuntimeError(
      "DEPENDENCY_UNAVAILABLE",
      "Verifier did not produce a terminal result in the bounded poll window",
      operationId,
    );
  }

  private async submit(
    operationId: string,
    kind: LocalOperationKind,
    call: ContractCall,
    _certificate: WorkCertificate | null,
  ): Promise<LocalOperationRecord> {
    const requestId = this.id();
    let preparedHandle: WalletHandle | null;
    try {
      preparedHandle = await this.options.wallet.prepareSubmission(
        requestId,
        call,
      );
    } catch {
      // Preparation signs/builds the transaction but does not broadcast it.
      // Keep the certified operation resumable instead of releasing it while
      // the API still considers the operation active.
      throw new AgentRuntimeError(
        "DEPENDENCY_UNAVAILABLE",
        "Wallet could not prepare a recoverable submission",
        operationId,
      );
    }
    this.options.ledger.attachSubmission({
      operationId,
      providerRequestId: requestId,
      walletHandle: preparedHandle,
    });
    try {
      const handle = await this.options.wallet.submitCall(requestId, call);
      const operation = this.options.ledger.recordWalletHandle(
        operationId,
        handle,
      );
      if (kind === "MINT") {
        try {
          await this.options.api.associateTransaction({
            operationId,
            walletHandle: handle,
            txHash: handle.kind === "transaction" ? handle.hash : null,
            idempotencyKey: requestId,
          });
        } catch {
          // The local recovery record is already durable. API association can be
          // retried, but must never cause a second wallet submission.
        }
      }
      return operation;
    } catch {
      return this.options.ledger.markSubmissionUnknown(
        operationId,
        "Wallet returned no durable result; recover the original request",
      );
    }
  }

  private async recoverOutstanding(wallet: HexAddress): Promise<void> {
    const operations = this.options.ledger
      .listOperations(this.options.manifest.environmentId, wallet)
      .filter(isUnresolved);
    for (const operation of operations) {
      await this.recoverOperation(operation);
    }
  }

  private async recoverOperation(
    input: LocalOperationRecord,
  ): Promise<LocalOperationRecord> {
    if (!isUnresolved(input)) return input;
    if (
      input.kind === "MINT" &&
      input.providerRequestId === null &&
      input.walletHandle === null &&
      (input.receiptHash === null ||
        (await this.options.chain.issuedId(input.receiptHash)) === 0n)
    ) {
      // Never handed to any wallet, so nothing can be pending on-chain or at a provider.
      const expired =
        input.certificateExpiresAt === null ||
        Date.parse(input.certificateExpiresAt) <= this.now().getTime();
      if (!expired) return input;
      const released = this.options.ledger.resolveUnsentFailure({
        operationId: input.operationId,
        errorCode: "CERTIFICATE_EXPIRED",
        message:
          "Certified Mint expired before it was sent to a wallet; nothing was submitted or charged",
      });
      if (released !== null) return released;
      // Another process handed it to a wallet meanwhile: recover that submission instead.
      const current = this.options.ledger.operation(input.operationId);
      if (current === null || !isUnresolved(current)) return current ?? input;
      input = current;
    }
    const operation = this.options.ledger.markRecovering(input.operationId);
    let chainIssuedId = 0n;
    if (operation.kind === "MINT" && operation.receiptHash !== null) {
      chainIssuedId = await this.options.chain.issuedId(operation.receiptHash);
    }
    let result: SubmissionResult;
    if (operation.walletHandle !== null) {
      result = await this.options.wallet.querySubmission(
        operation.walletHandle,
      );
    } else if (operation.providerRequestId !== null) {
      result = await this.options.wallet.queryRequest(
        operation.providerRequestId,
      );
    } else {
      result = {
        status: "UNKNOWN",
        handle: null,
        transactionHash: null,
        replacementHash: null,
        gasSpentNative: null,
        blockNumber: null,
      };
    }
    if (chainIssuedId > 0n) {
      return this.options.ledger.resolveConfirmed({
        operationId: operation.operationId,
        transactionHash: result.transactionHash ?? operation.candidateTxHash,
        issuedId: chainIssuedId,
        gasSpentNative:
          result.gasSpentNative ?? BigInt(operation.gasCommittedNative),
        ...gasAttribution(result),
      });
    }
    if (result.handle !== null && operation.walletHandle === null) {
      this.options.ledger.recordWalletHandle(
        operation.operationId,
        result.handle,
      );
    }
    if (result.status === "PENDING") {
      return this.options.ledger.markPending(
        operation.operationId,
        result.handle,
        result.transactionHash,
      );
    }
    if (result.status === "CONFIRMED") {
      let issuedId: bigint | null = null;
      if (operation.kind === "MINT") {
        if (operation.receiptHash === null) {
          throw new AgentRuntimeError(
            "SUBMISSION_UNKNOWN",
            "Mint recovery record has no receipt hash",
            operation.operationId,
          );
        }
        issuedId = await this.options.chain.issuedId(operation.receiptHash);
        if (issuedId === 0n) {
          return this.options.ledger.resolveFailure({
            operationId: operation.operationId,
            state: "FAILED",
            gasSpentNative: result.gasSpentNative ?? 0n,
            ...gasAttribution(result),
            errorCode: "INVALID_WORK",
            message:
              "Confirmed transaction did not consume the expected receipt",
            transactionHash: result.transactionHash,
          });
        }
      }
      return this.options.ledger.resolveConfirmed({
        operationId: operation.operationId,
        transactionHash: result.transactionHash,
        issuedId,
        gasSpentNative:
          result.gasSpentNative ?? BigInt(operation.gasCommittedNative),
        ...gasAttribution(result),
      });
    }
    if (result.status === "REVERTED" || result.status === "REPLACED") {
      return this.options.ledger.resolveFailure({
        operationId: operation.operationId,
        state: result.status,
        gasSpentNative:
          result.gasSpentNative ?? BigInt(operation.gasCommittedNative),
        ...gasAttribution(result),
        errorCode:
          result.status === "REVERTED" ? "INVALID_WORK" : "SUBMISSION_UNKNOWN",
        message:
          result.status === "REVERTED"
            ? "Wallet transaction reverted; project fee was not charged"
            : "Original transaction was replaced",
        transactionHash: result.transactionHash,
      });
    }
    return this.options.ledger.markSubmissionUnknown(
      operation.operationId,
      "Original wallet request remains unresolved; no replacement Mint was submitted",
    );
  }

  private async registerContentOperation(
    wallet: HexAddress,
    id: bigint,
    parentOperationId: string | null,
  ): Promise<LocalOperationRecord> {
    const operationId = this.id();
    this.options.ledger.beginOperation({
      operationId,
      kind: "CONTENT_REGISTER",
      environmentId: this.options.manifest.environmentId,
      wallet,
      chainId: BigInt(this.options.manifest.chainId),
      contentId: id,
      parentOperationId,
    });
    try {
      const proof = await this.options.api.getPiProof(id);
      if (
        proof.root.toLowerCase() !== this.options.manifest.piRoot.toLowerCase()
      ) {
        throw new AgentRuntimeError(
          "INVALID_CONTENT_PROOF",
          "Pi proof root differs from the trusted immutable root",
          operationId,
        );
      }
      const call = buildRegisterContentCall(
        BigInt(this.options.manifest.chainId),
        this.options.manifest.deployment.mirror,
        id,
        proof.packedDigits as `0x${string}`,
        proof.proof as readonly Bytes32[],
      );
      const submitted = await this.submitExistingAuxiliary(operationId, call);
      if (isConfirmed(submitted)) {
        let registered: unknown = true;
        try {
          registered = await this.options.publicClient.readContract({
            address: this.options.manifest.deployment.mirror,
            abi: arcalMirrorAbi,
            functionName: "contentRegistered",
            args: [id],
          });
        } catch {
          // Unreadable chain state keeps the wallet-confirmed result.
        }
        if (registered === false) {
          return this.options.ledger.resolveFailure({
            operationId,
            state: "FAILED",
            gasSpentNative: 0n,
            errorCode: "INVALID_CONTENT_PROOF",
            message:
              "Registration transaction confirmed but the Mirror does not report registered content",
          });
        }
      }
      return submitted;
    } catch (error) {
      const mapped = safeError(error);
      return this.options.ledger.resolveFailure({
        operationId,
        state:
          mapped.code === "INVALID_CONTENT_PROOF"
            ? "FAILED"
            : "FAILED_RETRYABLE",
        gasSpentNative: 0n,
        errorCode: mapped.code,
        message: mapped.message,
      });
    }
  }

  private async executeAuxiliary(
    wallet: HexAddress,
    kind: Exclude<LocalOperationKind, "MINT" | "CONTENT_REGISTER">,
    call: ContractCall,
    contentId: bigint | null,
  ): Promise<LocalOperationRecord> {
    const operationId = this.id();
    this.options.ledger.beginOperation({
      operationId,
      kind,
      environmentId: this.options.manifest.environmentId,
      wallet,
      chainId: BigInt(this.options.manifest.chainId),
      contentId,
    });
    return this.submitExistingAuxiliary(operationId, call);
  }

  private async submitExistingAuxiliary(
    operationId: string,
    call: ContractCall,
  ): Promise<LocalOperationRecord> {
    const simulation = await this.options.wallet.simulateCall(call);
    if (!simulation.success) {
      return this.options.ledger.resolveFailure({
        operationId,
        state: "FAILED_RETRYABLE",
        gasSpentNative: 0n,
        errorCode: "DEPENDENCY_UNAVAILABLE",
        message: simulation.diagnostic ?? "Contract simulation failed",
      });
    }
    const fees = await this.options.wallet.estimateFees(call);
    this.options.ledger.setOperationCommitment(
      operationId,
      0n,
      fees.maxGasNative,
    );
    const pending = await this.submit(
      operationId,
      this.options.ledger.operation(operationId)!.kind,
      call,
      null,
    );
    return this.recoverOperation(pending);
  }

  private async execute(
    command: CliCommand,
    action: (wallet: HexAddress) => Promise<CliEnvelope>,
  ): Promise<CliEnvelope> {
    let wallet: HexAddress | null = null;
    try {
      wallet = lower(await this.options.wallet.getAddress());
      return await action(wallet);
    } catch (error) {
      const mapped = safeError(error);
      const definition = PROTOCOL_ERRORS[mapped.code];
      const apiError: ApiError = {
        code: mapped.code,
        message: mapped.message,
        retryable: definition.retryable,
        retryAfterMs: null,
        action: definition.action,
        operationId: mapped.operationId,
        details: null,
      };
      return {
        ok: false,
        schemaVersion: "1",
        command,
        state: "FAILED",
        operationId: mapped.operationId,
        chainId: this.options.manifest.chainId,
        wallet,
        txHash: null,
        data: {},
        error: apiError,
        asOf: this.now().toISOString(),
      };
    }
  }

  private envelope(
    command: CliCommand,
    state: string,
    wallet: HexAddress,
    operationId: string | null,
    txHash: Bytes32 | null,
    data: Record<string, unknown>,
  ): CliEnvelope {
    return {
      ok: true,
      schemaVersion: "1",
      command,
      state,
      operationId,
      chainId: this.options.manifest.chainId,
      wallet,
      txHash,
      data,
      error: null,
      asOf: this.now().toISOString(),
    };
  }
}

export function assertCapabilityShape(capabilities: WalletCapabilities): void {
  for (const name of WALLET_CAPABILITY_NAMES) {
    if (capabilities[name] === undefined) {
      throw new TypeError(`Wallet capability report omitted ${name}`);
    }
  }
}
