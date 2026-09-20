import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  MINT_FEE_NATIVE,
  UNIT,
  UINT256_MAX,
  certificateToJson,
  hashChallengeStruct,
} from "@arcals/protocol";
import type {
  Bytes32,
  Challenge,
  ConfigDto,
  HexAddress,
  WalletHandle,
  WorkCertificate,
} from "@arcals/protocol";
import { ArcalsApiError } from "@arcals/sdk";
import type { ArcalsWorkApiClient, ContractCall } from "@arcals/sdk";
import type { ProgressEvent } from "../src/types.js";

import { AgentRuntime } from "../src/agent.js";
import { SqliteOperationLedger } from "../src/ledger.js";
import type { RandomXMiner } from "../src/randomx-miner.js";
import type {
  AgentEnvironmentManifest,
  SubmissionResult,
  WalletAdapter,
  WalletCapabilities,
} from "../src/types.js";
import { unsupportedCapabilities } from "../src/types.js";

const walletAddress =
  "0x2000000000000000000000000000000000000002" as HexAddress;
const deployment = {
  core: "0x1000000000000000000000000000000000000001",
  base: "0x1000000000000000000000000000000000000002",
  mirror: "0x1000000000000000000000000000000000000003",
  vault: "0x1000000000000000000000000000000000000004",
  controller: "0x1000000000000000000000000000000000000005",
  treasury: "0x1000000000000000000000000000000000000006",
} as const;
const piRoot = `0x${"11".repeat(32)}` as Bytes32;
const configDigest = `0x${"22".repeat(32)}` as Bytes32;
const epochKey = `0x${"33".repeat(32)}` as Bytes32;
const randomxHash = `0x${"00".repeat(31)}01` as Bytes32;

type SubmitMode = "unknown" | "confirmed" | "reverted";

interface Harness {
  readonly runtime: AgentRuntime;
  readonly ledger: SqliteOperationLedger;
  readonly wallet: FakeWallet;
  readonly state: {
    issuedId: bigint;
    proofFails: boolean;
  };
  close(): Promise<void>;
}

const ledgers: SqliteOperationLedger[] = [];
afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
});

function capabilities(hard: boolean): WalletCapabilities {
  const result = unsupportedCapabilities("test:capabilities");
  if (hard) {
    for (const name of Object.keys(result) as (keyof WalletCapabilities)[]) {
      result[name] = {
        supported: true,
        enforcement: "account",
        evidenceRef: "test:account-policy",
      };
    }
  }
  return result;
}

class FakeWallet implements WalletAdapter {
  readonly adapterId = "fake-wallet";
  readonly mode = "session" as const;
  submitCount = 0;
  revoked = false;
  private readonly handles = new Map<string, WalletHandle>();

  constructor(
    readonly submitMode: SubmitMode,
    readonly capabilityReport: WalletCapabilities,
    private readonly onSubmit: (call: ContractCall) => void,
  ) {}

  async getAddress(): Promise<HexAddress> {
    return walletAddress;
  }
  async getChainId(): Promise<bigint> {
    return 31_337n;
  }
  async getNativeBalance(): Promise<bigint> {
    return 10n ** 20n;
  }
  async getCapabilities(): Promise<WalletCapabilities> {
    return this.capabilityReport;
  }
  async configureMintAuthorization(): Promise<WalletCapabilities> {
    return this.capabilityReport;
  }
  async authenticate(): Promise<`0x${string}`> {
    return "0x12";
  }
  /** Number of simulations to answer with a revert before succeeding. */
  simulationFailures = 0;
  simulationCalls = 0;
  async simulateCall(): Promise<{
    success: boolean;
    diagnostic: string | null;
  }> {
    this.simulationCalls += 1;
    if (this.simulationCalls <= this.simulationFailures) {
      return { success: false, diagnostic: "execution reverted" };
    }
    return { success: true, diagnostic: null };
  }
  async estimateFees(): Promise<{ gasLimit: bigint; maxGasNative: bigint }> {
    return { gasLimit: 100n, maxGasNative: 1000n };
  }
  async prepareSubmission(): Promise<WalletHandle | null> {
    return null;
  }
  async submitCall(
    requestId: string,
    call: ContractCall,
  ): Promise<WalletHandle> {
    this.submitCount += 1;
    this.onSubmit(call);
    if (this.submitMode === "unknown") throw new Error("response lost");
    const hash =
      `0x${this.submitCount.toString(16).padStart(64, "0")}` as Bytes32;
    const handle: WalletHandle = {
      kind: "transaction",
      chainId: "31337",
      hash,
      sender: walletAddress,
      transactionNonce: String(this.submitCount - 1),
    };
    this.handles.set(requestId, handle);
    return handle;
  }
  async querySubmission(handle: WalletHandle): Promise<SubmissionResult> {
    return {
      status: this.submitMode === "reverted" ? "REVERTED" : "CONFIRMED",
      handle,
      transactionHash: handle.kind === "transaction" ? handle.hash : null,
      replacementHash: null,
      gasSpentNative: this.submitMode === "reverted" ? 333n : 111n,
      blockNumber: 10n,
    };
  }
  async queryRequest(requestId: string): Promise<SubmissionResult> {
    const handle = this.handles.get(requestId) ?? null;
    return {
      status: handle === null ? "UNKNOWN" : "CONFIRMED",
      handle,
      transactionHash: handle?.kind === "transaction" ? handle.hash : null,
      replacementHash: null,
      gasSpentNative: handle === null ? null : 111n,
      blockNumber: handle === null ? null : 10n,
    };
  }
  async revokeSession(): Promise<void> {
    this.revoked = true;
  }
}

async function makeHarness(input: {
  readonly ledgerPath?: string;
  readonly submitMode: SubmitMode;
  readonly hardCapabilities?: boolean;
  readonly existingState?: Harness["state"];
  readonly existingWallet?: FakeWallet;
  readonly now?: () => Date;
  readonly apiUnavailable?: boolean;
  readonly rejectStoredSessionOnce?: boolean;
  readonly progress?: (event: ProgressEvent) => void;
  readonly miner?: RandomXMiner;
  readonly stopPollMs?: number;
  readonly publicClient?: unknown;
  readonly workResponseLost?: boolean;
  readonly verifierUnavailable?: boolean;
  readonly onChallenge?: () => void;
  readonly onWorkSubmit?: (key: string) => void;
}): Promise<Harness> {
  const state = input.existingState ?? { issuedId: 0n, proofFails: false };
  let bearer: string | null = null;
  let rejectSession = input.rejectStoredSessionOnce === true;
  const manifest: AgentEnvironmentManifest = {
    schemaVersion: "1",
    mode: "local-fixture",
    environmentId: `31337:${deployment.core}`,
    chainId: "31337",
    apiUrl: "http://127.0.0.1:3000",
    rpcUrl: "http://127.0.0.1:8545",
    deployment,
    piRoot,
    worker: {
      binaryPath: "/test/worker",
      binarySha256: "aa".repeat(32),
      algorithmId: `0x${"44".repeat(32)}`,
      parameterDigest: `0x${"55".repeat(32)}`,
    },
    productionAuthorized: false,
  };
  const nowSeconds = 1_800_000_000n;
  const challenge: Challenge = {
    protocolVersion: 1,
    configDigest,
    challengeId: `0x${"66".repeat(32)}`,
    epochId: 0n,
    minter: walletAddress,
    mintNonce: 0n,
    challengeInput: `0x${"77".repeat(32)}`,
    mintFee: MINT_FEE_NATIVE,
    validAfter: nowSeconds,
    expiresAt: nowSeconds + 1200n,
    signerVersion: 1n,
  };
  const certificate: WorkCertificate = {
    protocolVersion: 1,
    challengeHash: hashChallengeStruct(challenge),
    workNonce: 7n,
    randomxHash,
    issuedAt: nowSeconds + 1n,
    expiresAt: nowSeconds + 301n,
    signerVersion: 1n,
  };
  const signer = privateKeyToAccount(toHex(randomBytes(32)));
  const issuerSignature = await signer.sign({ hash: `0x${"88".repeat(32)}` });
  const verifierSignature = await signer.sign({ hash: `0x${"99".repeat(32)}` });
  const config: ConfigDto = {
    environmentId: manifest.environmentId,
    chainId: manifest.chainId,
    deployment,
    piRoot,
    workConfig: {
      protocolVersion: 1,
      algorithmId: manifest.worker.algorithmId,
      parameterDigest: manifest.worker.parameterDigest,
      epochSeconds: "86400",
      keyLeadSeconds: "900",
      maxChallengeTtl: "1200",
      maxCertificateTtl: "300",
      target: UINT256_MAX.toString(),
      effectiveEpoch: "0",
      configDigest,
    },
    epoch: {
      epochId: "0",
      configDigest,
      epochKey,
      validFrom: nowSeconds.toString(),
      validUntil: (nowSeconds + 86_400n).toString(),
      anchorBlockNumber: "1",
      anchorBlockHash: `0x${"aa".repeat(32)}`,
    },
    capabilities: { mint: true, conversions: true, unattendedWallet: false },
  };
  const api = {
    getConfig: async () => {
      if (input.apiUnavailable) throw new Error("API offline");
      return config;
    },
    createAuthNonce: async () => ({
      nonce: `0x${"bb".repeat(32)}`,
      message: "authenticate runtime wallet",
      expiresAt: new Date(Number(nowSeconds + 300n) * 1000).toISOString(),
    }),
    createAuthSession: async () => {
      bearer = "runtime-session";
      return {
        sessionToken: "runtime-session",
        expiresAt: new Date(Number(nowSeconds + 3600n) * 1000).toISOString(),
      };
    },
    setBearerToken: (token: string) => {
      bearer = token;
    },
    issueChallenge: async () => {
      input.onChallenge?.();
      if (rejectSession && bearer === "stored-session") {
        rejectSession = false;
        throw new ArcalsApiError(
          401,
          {
            code: "WALLET_AUTH_REQUIRED",
            message: "session expired",
            retryable: false,
            retryAfterMs: null,
            action: "REAUTHENTICATE",
            operationId: null,
            details: null,
          } as never,
          {} as never,
        );
      }
      return { challenge, issuerSignature };
    },
    submitWork: async ({ idempotencyKey }: { idempotencyKey: string }) => {
      input.onWorkSubmit?.(idempotencyKey);
      if (input.workResponseLost)
        throw new Error("response lost after server accepted work");
      return "10000000-0000-4000-8000-000000000001";
    },
    getWorkJobState: async () => ({
      jobId: "10000000-0000-4000-8000-000000000001",
      status: "CERTIFICATE_READY",
      certificate: certificateToJson(certificate),
      verifierSignature,
      error: null,
    }),
    getWorkJob: async () => {
      if (input.verifierUnavailable)
        throw new Error("verifier connection interrupted");
      return { certificate, verifierSignature };
    },
    associateTransaction: async () => ({
      operationId: "10000000-0000-4000-8000-000000000001",
      state: "TX_PENDING",
      walletHandle: null,
      stopRequested: false,
      updatedAt: new Date().toISOString(),
    }),
    getPiProof: async (id: bigint) => {
      if (state.proofFails)
        throw new Error("Pi mirror temporarily unavailable");
      return {
        datasetId: "test-pi",
        id: id.toString(),
        packedDigits: `0x${"12".repeat(180)}`,
        proof: Array.from({ length: 20 }, () => `0x${"cc".repeat(32)}`),
        contentHash: `0x${"dd".repeat(32)}`,
        root: piRoot,
      };
    },
    getMint: async (txHash: Bytes32) => ({
      txHash,
      status: "FINAL",
      issuedId: "1",
      receiptHash: `0x${"ee".repeat(32)}`,
      workVerification: "verified",
    }),
  } as unknown as ArcalsWorkApiClient;
  const miner: RandomXMiner = {
    mine: async () => ({
      workNonce: 7n,
      randomxHash,
      hashesTried: "1",
      elapsedMs: "1",
      hashRate: "1000",
    }),
    close: async () => undefined,
  };
  const wallet =
    input.existingWallet ??
    new FakeWallet(
      input.submitMode,
      capabilities(input.hardCapabilities ?? false),
      (call) => {
        if (
          input.submitMode === "confirmed" &&
          call.to.toLowerCase() === deployment.controller
        ) {
          state.issuedId = 1n;
        }
      },
    );
  const ledger = new SqliteOperationLedger(input.ledgerPath ?? ":memory:");
  ledgers.push(ledger);
  let idSequence = 1;
  const runtime = new AgentRuntime({
    manifest,
    api,
    wallet,
    ledger,
    miner: input.miner ?? miner,
    publicClient: (input.publicClient ?? {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "contentRegistered") return true;
        throw new Error(`no chain fixture for ${functionName}`);
      },
    }) as never,
    chain: {
      nextMintNonce: async () => (state.issuedId === 0n ? 0n : 1n),
      issuedId: async () => state.issuedId,
    },
    verifyEnvironment: async () => undefined,
    verifyAssetEnvironment: async () => undefined,
    now: input.now ?? (() => new Date(Number(nowSeconds + 10n) * 1000)),
    sleep: async () => undefined,
    id: () =>
      `20000000-0000-4000-8000-${String(idSequence++).padStart(12, "0")}`,
    verificationPollLimit: 2,
    ...(input.progress === undefined ? {} : { progress: input.progress }),
    ...(input.stopPollMs === undefined ? {} : { stopPollMs: input.stopPollMs }),
  });
  return {
    runtime,
    ledger,
    wallet,
    state,
    close: async () => runtime.close(),
  };
}

class EstimateFailingWallet extends FakeWallet {
  estimateFailuresLeft = 1;
  override async estimateFees(): Promise<{
    gasLimit: bigint;
    maxGasNative: bigint;
  }> {
    if (this.estimateFailuresLeft > 0) {
      this.estimateFailuresLeft -= 1;
      throw new Error("provider estimate unavailable");
    }
    return super.estimateFees();
  }
}

class PrepareFailingWallet extends FakeWallet {
  prepareFailuresLeft = 1;
  override async prepareSubmission(): Promise<WalletHandle | null> {
    if (this.prepareFailuresLeft > 0) {
      this.prepareFailuresLeft -= 1;
      throw new Error("provider prepare unavailable");
    }
    return super.prepareSubmission();
  }
}

function countingMiner(counter: { calls: number }): RandomXMiner {
  return {
    mine: async () => {
      counter.calls += 1;
      return {
        workNonce: 7n,
        randomxHash,
        hashesTried: "1",
        elapsedMs: "1",
        hashRate: "1000",
      };
    },
    close: async () => undefined,
  };
}

describe("Agent Mint orchestration and recovery", () => {
  it("reuses an unsent certificate after wallet preparation fails", async () => {
    const state = { issuedId: 0n, proofFails: false };
    const mined = { calls: 0 };
    let challenges = 0;
    const wallet = new PrepareFailingWallet(
      "confirmed",
      capabilities(false),
      (call) => {
        if (call.to.toLowerCase() === deployment.controller)
          state.issuedId = 1n;
      },
    );
    const harness = await makeHarness({
      submitMode: "confirmed",
      existingState: state,
      existingWallet: wallet,
      miner: countingMiner(mined),
      onChallenge: () => {
        challenges++;
      },
    });
    const failed = await harness.runtime.mineOnce({
      confirmed: true,
      unattended: false,
      threads: 1,
    });
    expect(failed).toMatchObject({
      ok: false,
      error: { code: "DEPENDENCY_UNAVAILABLE" },
    });
    const [certified] = harness.ledger.listOperations(
      `31337:${deployment.core}`,
      walletAddress,
    );
    expect(certified).toMatchObject({
      state: "CERTIFICATE_READY",
      providerRequestId: null,
      walletHandle: null,
    });

    // Ledgers written by the previous runner used FAILED_RETRYABLE here.
    harness.ledger.resolveFailure({
      operationId: certified!.operationId,
      state: "FAILED_RETRYABLE",
      gasSpentNative: 0n,
      errorCode: "DEPENDENCY_UNAVAILABLE",
      message: "legacy pre-submission failure",
    });
    const resumed = await harness.runtime.mineOnce({
      confirmed: true,
      unattended: false,
      threads: 1,
    });
    expect(resumed.state).toBe("MINT_CONFIRMED");
    expect(resumed.operationId).toBe(certified!.operationId);
    expect(challenges).toBe(1);
    expect(mined.calls).toBe(1);
    expect(wallet.submitCount).toBe(1);
    await harness.close();
  });

  it("resumes a certified Mint with the same certificate after a pre-submission estimate failure", async () => {
    const state = { issuedId: 0n, proofFails: false };
    const mined = { calls: 0 };
    const wallet = new EstimateFailingWallet(
      "confirmed",
      capabilities(false),
      (call) => {
        if (call.to.toLowerCase() === deployment.controller)
          state.issuedId = 1n;
      },
    );
    const harness = await makeHarness({
      submitMode: "confirmed",
      existingState: state,
      existingWallet: wallet,
      miner: countingMiner(mined),
    });
    const failed = await harness.runtime.mineOnce({
      confirmed: true,
      unattended: false,
      threads: 1,
    });
    expect(failed.ok).toBe(false);
    expect(wallet.submitCount).toBe(0);
    const [pending] = harness.ledger.listOperations(
      `31337:${deployment.core}`,
      walletAddress,
    );
    expect(pending).toMatchObject({
      kind: "MINT",
      state: "CERTIFICATE_READY",
      providerRequestId: null,
    });
    expect(harness.ledger.pendingCall(pending!.operationId)?.to).toBe(
      deployment.controller,
    );

    const preview = await harness.runtime.mineOnce({
      confirmed: false,
      unattended: false,
      threads: 1,
    });
    expect(preview.state).toBe("NEEDS_USER_AUTH");
    expect(preview.operationId).toBe(pending!.operationId);
    expect(preview.data).toMatchObject({ resumesCertifiedMint: true });

    const resumed = await harness.runtime.mineOnce({
      confirmed: true,
      unattended: false,
      threads: 1,
    });
    expect(resumed.state).toBe("MINT_CONFIRMED");
    expect(resumed.operationId).toBe(pending!.operationId);
    expect(mined.calls).toBe(1);
    expect(wallet.submitCount).toBe(1);
    expect(
      harness.ledger.listOperations(`31337:${deployment.core}`, walletAddress),
    ).toHaveLength(1);
    await harness.close();
  });

  it("skips approvals that already exist on-chain before liquify and reform", async () => {
    const harness = await makeHarness({
      submitMode: "confirmed",
      publicClient: {
        readContract: async ({ functionName }: { functionName: string }) => {
          if (functionName === "contentRegistered") return true;
          if (functionName === "getApproved") return deployment.vault;
          if (functionName === "isApprovedForAll") return false;
          if (functionName === "allowance") return 360n * 10n ** 18n;
          throw new Error(`unexpected read ${functionName}`);
        },
      },
    });
    const liquify = await harness.runtime.liquify(1n, 2_000_000_000n, true);
    expect(liquify.data).toMatchObject({ approval: null });
    expect(harness.wallet.submitCount).toBe(1);
    const reform = await harness.runtime.reform(1n, 2_000_000_000n, true);
    expect(reform.data).toMatchObject({ approval: null });
    expect(harness.wallet.submitCount).toBe(2);
    const kinds = harness.ledger
      .listOperations(`31337:${deployment.core}`, walletAddress)
      .map((operation) => operation.kind);
    expect(kinds).toEqual(["LIQUIFY", "REFORM"]);
    await harness.close();
  });

  it("registers content from the same wallet right after Mint when requested", async () => {
    const harness = await makeHarness({ submitMode: "confirmed" });
    const preview = await harness.runtime.mineOnce({
      confirmed: false,
      unattended: false,
      threads: 1,
      registerContent: true,
    });
    expect(preview.data).toMatchObject({
      contentRegistration: "AFTER_MINT_SAME_WALLET_USER_PAID_GAS",
    });
    const minted = await harness.runtime.mineOnce({
      confirmed: true,
      unattended: false,
      threads: 1,
      registerContent: true,
    });
    expect(minted.state).toBe("MINT_CONFIRMED");
    expect(minted.data).toMatchObject({
      contentStatus: "REGISTERED",
      contentOperation: {
        kind: "CONTENT_REGISTER",
        state: "CONTENT_REGISTERED",
      },
      nextAction: null,
    });
    expect(harness.wallet.submitCount).toBe(2);
    await harness.close();
  });

  it("re-simulates a Mint the chain has not caught up to yet", async () => {
    const harness = await makeHarness({ submitMode: "confirmed" });
    // The controller rejects a certificate newer than the block it runs
    // against, so a simulation right after certification can revert while the
    // Mint itself is valid a block later.
    harness.wallet.simulationFailures = 2;
    const minted = await harness.runtime.mineOnce({
      confirmed: true,
      unattended: false,
      threads: 1,
      registerContent: false,
    });
    expect(minted.state).toBe("MINT_CONFIRMED");
    expect(harness.wallet.simulationCalls).toBe(3);
    await harness.close();
  });

  it("gives up on a Mint that keeps failing simulation and keeps the certificate", async () => {
    const harness = await makeHarness({ submitMode: "confirmed" });
    harness.wallet.simulationFailures = 99;
    const failed = await harness.runtime.mineOnce({
      confirmed: true,
      unattended: false,
      threads: 1,
      registerContent: false,
    });
    expect(failed.ok).toBe(false);
    expect(failed.error?.code).toBe("INVALID_WORK");
    expect(harness.wallet.simulationCalls).toBe(4);
    expect(harness.wallet.submitCount).toBe(0);
    await harness.close();
  });

  it("deploys a lazily deployed wallet after Mint confirmation and before API login", async () => {
    const harness = await makeHarness({ submitMode: "confirmed" });
    const events: string[] = [];
    let deployed = false;
    const wallet = harness.wallet as typeof harness.wallet & {
      deploymentStatus(): Promise<"DEPLOYED" | "UNDEPLOYED">;
      deployAccount(): Promise<void>;
    };
    wallet.deploymentStatus = async () =>
      deployed ? "DEPLOYED" : "UNDEPLOYED";
    wallet.deployAccount = async () => {
      events.push("deploy");
      deployed = true;
    };
    const authenticate = wallet.authenticate.bind(wallet);
    wallet.authenticate = async (...args) => {
      events.push(deployed ? "login-after-deploy" : "login-before-deploy");
      return authenticate(...args);
    };
    const preview = await harness.runtime.mineOnce({
      confirmed: false,
      unattended: false,
      threads: 1,
    });
    expect(preview.state).toBe("NEEDS_USER_AUTH");
    expect(preview.data).toMatchObject({ walletDeployment: "REQUIRED" });
    expect(events).toEqual([]);
    const minted = await harness.runtime.mineOnce({
      confirmed: true,
      unattended: false,
      threads: 1,
    });
    expect(minted.state).toBe("MINT_CONFIRMED");
    expect(events[0]).toBe("deploy");
    expect(events).not.toContain("login-before-deploy");
    const next = await harness.runtime.mineOnce({
      confirmed: false,
      unattended: false,
      threads: 1,
    });
    expect(next.data).toMatchObject({ walletDeployment: "NOT_REQUIRED" });
    await harness.close();
  });

  it("stops before login and any submission when wallet deployment does not take effect", async () => {
    const harness = await makeHarness({ submitMode: "confirmed" });
    const wallet = harness.wallet as typeof harness.wallet & {
      deploymentStatus(): Promise<"DEPLOYED" | "UNDEPLOYED">;
      deployAccount(): Promise<void>;
    };
    wallet.deploymentStatus = async () => "UNDEPLOYED";
    wallet.deployAccount = async () => undefined;
    const result = await harness.runtime.mineOnce({
      confirmed: true,
      unattended: false,
      threads: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("WALLET_UNDEPLOYED");
    expect(harness.wallet.submitCount).toBe(0);
    await harness.close();
  });

  it("reports every Mint lifecycle stage in order without changing the result", async () => {
    const events: ProgressEvent[] = [];
    const harness = await makeHarness({
      submitMode: "confirmed",
      progress: (event) => events.push(event),
    });
    const minted = await harness.runtime.mineOnce({
      confirmed: true,
      unattended: false,
      threads: 1,
      registerContent: true,
    });
    expect(minted.state).toBe("MINT_CONFIRMED");
    expect(events.map((event) => event.stage)).toEqual([
      "AUTHENTICATING",
      "CHALLENGE_ISSUED",
      "COMPUTING",
      "VERIFYING",
      "CERTIFICATE_READY",
      "WALLET_SUBMITTING",
      "TX_CONFIRMED",
      "CONTENT_REGISTERING",
      "COMPLETE",
    ]);
    expect(events.at(-1)?.detail).toMatchObject({
      issuedId: "1",
      contentStatus: "REGISTERED",
    });
    await harness.close();
  });

  it("reuses a stored Arcals API session instead of asking the wallet to sign again", async () => {
    const harness = await makeHarness({ submitMode: "confirmed" });
    // The harness clock is fixed in the future; keep the session valid there.
    const expires = "2100-01-01T00:00:00.000Z";
    harness.ledger.saveApiSession(
      `31337:${deployment.core}`,
      walletAddress,
      "stored-session",
      expires,
    );
    let signatures = 0;
    const authenticate = harness.wallet.authenticate.bind(harness.wallet);
    harness.wallet.authenticate = async (...args) => {
      signatures += 1;
      return authenticate(...args);
    };
    const minted = await harness.runtime.mineOnce({
      confirmed: true,
      unattended: false,
      threads: 1,
    });
    expect(minted.state).toBe("MINT_CONFIRMED");
    expect(signatures).toBe(0);
    await harness.close();
  });

  it("replaces a rejected stored session once and stores the new one", async () => {
    const harness = await makeHarness({
      submitMode: "confirmed",
      rejectStoredSessionOnce: true,
    });
    const environment = `31337:${deployment.core}`;
    harness.ledger.saveApiSession(
      environment,
      walletAddress,
      "stored-session",
      new Date(Date.now() + 3_600_000).toISOString(),
    );
    let signatures = 0;
    const authenticate = harness.wallet.authenticate.bind(harness.wallet);
    harness.wallet.authenticate = async (...args) => {
      signatures += 1;
      return authenticate(...args);
    };
    const minted = await harness.runtime.mineOnce({
      confirmed: true,
      unattended: false,
      threads: 1,
    });
    expect(minted.state).toBe("MINT_CONFIRMED");
    expect(signatures).toBe(1);
    expect(
      harness.ledger.apiSession(environment, walletAddress, new Date()),
    ).toBe("runtime-session");
    await harness.close();
  });

  it("registers pending content before approving and liquifying", async () => {
    let contentReads = 0;
    const harness = await makeHarness({
      submitMode: "confirmed",
      publicClient: {
        readContract: async ({ functionName }: { functionName: string }) => {
          // Pending before registration, registered when read back afterwards.
          if (functionName === "contentRegistered") return contentReads++ > 0;
          if (functionName === "getApproved")
            return "0x0000000000000000000000000000000000000000";
          if (functionName === "isApprovedForAll") return false;
          throw new Error(`unexpected read ${functionName}`);
        },
      },
    });
    const liquify = await harness.runtime.liquify(1n, 2_000_000_000n, true);
    expect(liquify.data).toMatchObject({
      contentOperation: {
        kind: "CONTENT_REGISTER",
        state: "CONTENT_REGISTERED",
      },
    });
    const kinds = harness.ledger
      .listOperations(`31337:${deployment.core}`, walletAddress)
      .map((operation) => operation.kind);
    expect(kinds).toEqual(["CONTENT_REGISTER", "NFT_APPROVAL", "LIQUIFY"]);
    expect(harness.wallet.submitCount).toBe(3);
    await harness.close();
  });

  it("releases a certified Mint that expired before it was ever sent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arcals-agent-expired-"));
    const path = join(directory, "ledger.sqlite");
    const state = { issuedId: 0n, proofFails: false };
    const wallet = new EstimateFailingWallet(
      "confirmed",
      capabilities(false),
      () => undefined,
    );
    const first = await makeHarness({
      ledgerPath: path,
      submitMode: "confirmed",
      existingState: state,
      existingWallet: wallet,
    });
    const failed = await first.runtime.mineOnce({
      confirmed: true,
      unattended: false,
      threads: 1,
    });
    expect(failed.ok).toBe(false);
    await first.close();
    first.ledger.close();
    ledgers.splice(ledgers.indexOf(first.ledger), 1);

    const later = await makeHarness({
      ledgerPath: path,
      submitMode: "confirmed",
      existingState: state,
      existingWallet: wallet,
      now: () => new Date(1_800_000_400_000),
    });
    await later.runtime.status();
    const [released] = later.ledger.listOperations(
      `31337:${deployment.core}`,
      walletAddress,
    );
    expect(released).toMatchObject({
      state: "FAILED_RETRYABLE",
      errorCode: "CERTIFICATE_EXPIRED",
      gasSpentNative: "0",
    });
    expect(
      later.ledger.canStartMint(`31337:${deployment.core}`, walletAddress),
    ).toBe(true);
    expect(wallet.submitCount).toBe(0);
    await later.close();
  });

  it("cancels local RandomX work when another CLI process requests stop", async () => {
    let cancelled = false;
    const blockingMiner: RandomXMiner = {
      mine: async (request) =>
        new Promise((_, reject) => {
          request.signal?.addEventListener(
            "abort",
            () => {
              cancelled = true;
              reject(new Error("RandomX search was cancelled"));
            },
            { once: true },
          );
        }),
      close: async () => undefined,
    };
    const harness = await makeHarness({
      submitMode: "confirmed",
      miner: blockingMiner,
      stopPollMs: 1,
    });
    setTimeout(
      () =>
        harness.ledger.requestStop(`31337:${deployment.core}`, walletAddress),
      5,
    );
    const result = await harness.runtime.mineOnce({
      confirmed: true,
      unattended: false,
      threads: 1,
    });
    expect(result.ok).toBe(false);
    expect(cancelled).toBe(true);
    expect(harness.wallet.submitCount).toBe(0);
    await harness.close();
  });

  it("requires separate user confirmation for Mint, content, liquify, and reform", async () => {
    const harness = await makeHarness({
      submitMode: "confirmed",
      apiUnavailable: true,
    });
    const [mint, content, liquify, reform] = await Promise.all([
      harness.runtime.mineOnce({
        confirmed: false,
        unattended: false,
        threads: 1,
      }),
      harness.runtime.registerContent(1n, false),
      harness.runtime.liquify(1n, 1_800_000_600n, false),
      harness.runtime.reform(1n, 1_800_000_600n, false),
    ]);
    expect([mint.state, content.state, liquify.state, reform.state]).toEqual([
      "NEEDS_USER_AUTH",
      "NEEDS_USER_AUTH",
      "NEEDS_USER_AUTH",
      "NEEDS_USER_AUTH",
    ]);
    expect(mint.data).toMatchObject({
      mintFeeNative: MINT_FEE_NATIVE.toString(),
      payer: walletAddress,
      recipient: walletAddress,
      authorizationScope: "ONE_MINT",
      assetRouting: {
        arcalRecipient: walletAddress,
        arclReserveRecipient: deployment.vault,
        arclReserveAmount: UNIT.toString(),
        mintRevenueRecipient: deployment.treasury,
        mintRevenueAmountNative: MINT_FEE_NATIVE.toString(),
        automaticNftTransfer: false,
      },
    });
    expect(harness.wallet.submitCount).toBe(0);
    await harness.close();
  });

  it("uses the trusted RPC path for conversion even when the API is offline", async () => {
    const harness = await makeHarness({
      submitMode: "confirmed",
      apiUnavailable: true,
    });
    const result = await harness.runtime.liquify(1n, 1_800_000_600n, true);
    expect(result).toMatchObject({ ok: true, state: "CONVERSION_CONFIRMED" });
    expect(harness.wallet.submitCount).toBe(2);
    await harness.close();
  });

  it("refuses continuous mode when limits exist only in CLI memory", async () => {
    const harness = await makeHarness({ submitMode: "confirmed" });
    const result = await harness.runtime.authorize({
      maxMints: 2,
      maxFeeNative: 2n * MINT_FEE_NATIVE,
      maxGasNative: 10_000n,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "WALLET_CAPABILITY_UNAVAILABLE" },
    });
    expect(
      harness.ledger.authorization(`31337:${deployment.core}`, walletAddress),
    ).toBeNull();
    await harness.close();
  });

  it("recovers a lost broadcast response after restart without a second Mint, even after certificate expiry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arcals-agent-restart-"));
    const path = join(directory, "ledger.sqlite");
    const first = await makeHarness({
      ledgerPath: path,
      submitMode: "unknown",
    });
    const result = await first.runtime.mineOnce({
      confirmed: true,
      unattended: false,
      threads: 1,
    });
    expect(result.state).toBe("SUBMISSION_UNKNOWN");
    expect(first.wallet.submitCount).toBe(1);
    await first.close();
    first.ledger.close();
    ledgers.splice(ledgers.indexOf(first.ledger), 1);

    first.state.issuedId = 1n;
    const second = await makeHarness({
      ledgerPath: path,
      submitMode: "unknown",
      existingState: first.state,
      existingWallet: first.wallet,
      now: () => new Date(1_800_000_500_000),
    });
    const status = await second.runtime.status();
    expect(status.ok).toBe(true);
    expect(second.wallet.submitCount).toBe(1);
    expect(
      second.ledger.listOperations(
        `31337:${deployment.core}`,
        walletAddress,
      )[0],
    ).toMatchObject({
      state: "MINT_CONFIRMED",
      issuedId: "1",
      gasSpentNative: "1000",
    });
    await second.close();
  });

  it("recovers an unresolved conversion from status without contacting the API", async () => {
    const harness = await makeHarness({
      submitMode: "confirmed",
      apiUnavailable: true,
    });
    const operationId = "20000000-0000-4000-8000-000000000002";
    harness.ledger.beginOperation({
      operationId,
      kind: "LIQUIFY",
      environmentId: `31337:${deployment.core}`,
      wallet: walletAddress,
      chainId: 31_337n,
      contentId: 1n,
      initialState: "CERTIFICATE_READY",
    });
    const handle: WalletHandle = {
      kind: "transaction",
      chainId: "31337",
      hash: `0x${"ab".repeat(32)}`,
      sender: walletAddress,
      transactionNonce: "7",
    };
    harness.ledger.attachSubmission({
      operationId,
      providerRequestId: "conversion-provider-request",
      walletHandle: handle,
    });
    harness.ledger.markSubmissionUnknown(
      operationId,
      "conversion response was lost",
    );

    const status = await harness.runtime.status();

    expect(status.ok).toBe(true);
    expect(harness.ledger.operation(operationId)).toMatchObject({
      state: "CONVERSION_CONFIRMED",
      candidateTxHash: handle.hash,
    });
    await harness.close();
  });

  it("releases project fee but accounts for failed Gas on a reverted unattended Mint", async () => {
    const harness = await makeHarness({
      submitMode: "reverted",
      hardCapabilities: true,
    });
    const authorization = await harness.runtime.authorize({
      maxMints: 2,
      maxFeeNative: 2n * MINT_FEE_NATIVE,
      maxGasNative: 10_000n,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
    });
    expect(authorization.ok).toBe(true);
    const result = await harness.runtime.mineOnce({
      confirmed: false,
      unattended: true,
      threads: 1,
    });
    expect(result.state).toBe("REVERTED");
    expect(
      harness.ledger.budgetSnapshot(`31337:${deployment.core}`, walletAddress),
    ).toMatchObject({
      spentFeeNative: "0",
      reservedFeeNative: "0",
      spentGasNative: "333",
      reservedGasNative: "0",
    });
    await harness.close();
  });

  it("lets an unattended authorization for exactly one Mint send that Mint", async () => {
    const harness = await makeHarness({
      submitMode: "confirmed",
      hardCapabilities: true,
    });
    await harness.runtime.authorize({
      maxMints: 1,
      maxFeeNative: MINT_FEE_NATIVE,
      maxGasNative: 1000n,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
    });
    const result = await harness.runtime.mineOnce({
      confirmed: false,
      unattended: true,
      threads: 1,
    });
    expect(result.state).toBe("MINT_CONFIRMED");
    expect(harness.wallet.submitCount).toBe(1);
    await harness.close();
  });

  it("refuses to resume a tampered stored Mint call or one too close to expiry", async () => {
    const state = { issuedId: 0n, proofFails: false };
    const wallet = new EstimateFailingWallet(
      "confirmed",
      capabilities(false),
      () => undefined,
    );
    const harness = await makeHarness({
      submitMode: "confirmed",
      existingState: state,
      existingWallet: wallet,
    });
    await harness.runtime.mineOnce({
      confirmed: true,
      unattended: false,
      threads: 1,
    });
    const [pending] = harness.ledger.listOperations(
      `31337:${deployment.core}`,
      walletAddress,
    );
    const original = harness.ledger.pendingCall(pending!.operationId)!;
    harness.ledger.setPendingCall(pending!.operationId, {
      ...original,
      to: deployment.vault,
    });
    const tampered = await harness.runtime.mineOnce({
      confirmed: true,
      unattended: false,
      threads: 1,
    });
    expect(tampered.error?.code).toBe("UNTRUSTED_DEPLOYMENT");
    expect(wallet.submitCount).toBe(0);
    await harness.close();

    const nearExpiry = await makeHarness({
      submitMode: "confirmed",
      existingState: { issuedId: 0n, proofFails: false },
      existingWallet: new EstimateFailingWallet(
        "confirmed",
        capabilities(false),
        () => undefined,
      ),
      // Certificate expires at nowSeconds + 301; 250s leaves under the 90s send window.
      now: () => new Date((1_800_000_000 + 250) * 1000),
    });
    const late = await nearExpiry.runtime.mineOnce({
      confirmed: true,
      unattended: false,
      threads: 1,
    });
    expect(late.error?.code).toBe("CERTIFICATE_EXPIRED");
    expect(nearExpiry.wallet.submitCount).toBe(0);
    await nearExpiry.close();
  });

  it("does not let an expiry release overwrite an operation another process already submitted", async () => {
    const harness = await makeHarness({ submitMode: "confirmed" });
    const environmentId = `31337:${deployment.core}`;
    harness.ledger.beginOperation({
      operationId: "30000000-0000-4000-8000-000000000001",
      kind: "MINT",
      environmentId,
      wallet: walletAddress,
      chainId: 31_337n,
      protocolNonce: 0n,
      receiptHash: `0x${"ab".repeat(32)}`,
      certificateExpiresAt: new Date(0),
      initialState: "CERTIFICATE_READY",
    });
    harness.ledger.attachSubmission({
      operationId: "30000000-0000-4000-8000-000000000001",
      providerRequestId: "30000000-0000-4000-8000-000000000002",
    });
    expect(
      harness.ledger.resolveUnsentFailure({
        operationId: "30000000-0000-4000-8000-000000000001",
        errorCode: "CERTIFICATE_EXPIRED",
        message: "should not apply",
      }),
    ).toBeNull();
    expect(
      harness.ledger.operation("30000000-0000-4000-8000-000000000001")?.state,
    ).toBe("WALLET_SUBMITTING");
    await harness.close();
  });

  it("stops liquify before any transaction when content registration cannot be read", async () => {
    const harness = await makeHarness({
      submitMode: "confirmed",
      publicClient: {
        readContract: async () => {
          throw new Error("rpc unavailable");
        },
      },
    });
    const liquify = await harness.runtime.liquify(1n, 2_000_000_000n, true);
    expect(liquify.error?.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(harness.wallet.submitCount).toBe(0);
    await harness.close();
  });

  it("retries only content after Mint succeeds and the Pi service temporarily fails", async () => {
    const harness = await makeHarness({ submitMode: "confirmed" });
    const minted = await harness.runtime.mineOnce({
      confirmed: true,
      unattended: false,
      threads: 1,
    });
    expect(minted.state).toBe("MINT_CONFIRMED");
    expect(minted.data.contentStatus).toBe("PENDING_CONTENT");
    expect(minted.data.assetRouting).toMatchObject({
      arcalRecipient: walletAddress,
      arclReserveRecipient: deployment.vault,
      arclReserveAmount: UNIT.toString(),
      automaticNftTransfer: false,
    });
    expect(harness.wallet.submitCount).toBe(1);
    harness.state.proofFails = true;
    const failedContent = await harness.runtime.registerContent(1n, true);
    expect(failedContent.state).toBe("FAILED_RETRYABLE");
    expect(harness.wallet.submitCount).toBe(1);
    harness.state.proofFails = false;
    const content = await harness.runtime.registerContent(1n, true);
    expect(content.state).toBe("CONTENT_REGISTERED");
    expect(harness.wallet.submitCount).toBe(2);
    expect(
      harness.ledger
        .listOperations(`31337:${deployment.core}`, walletAddress)
        .filter((operation) => operation.kind === "MINT"),
    ).toHaveLength(1);
    await harness.close();
  });

  it("stops new work while preserving an unknown pending Mint for recovery", async () => {
    const harness = await makeHarness({ submitMode: "unknown" });
    await harness.runtime.mineOnce({
      confirmed: true,
      unattended: false,
      threads: 1,
    });
    const stopped = await harness.runtime.stop();
    expect(stopped.data).toMatchObject({
      newSubmissionsStopped: true,
      pendingTransactionsCancelled: false,
    });
    expect(stopped.data.pendingStillTracked).toHaveLength(1);
    const rejected = await harness.runtime.mineOnce({
      confirmed: true,
      unattended: false,
      threads: 1,
    });
    expect(rejected.ok).toBe(false);
    expect(harness.wallet.submitCount).toBe(1);
    await harness.close();
  });

  it("authorizes a bounded session when the wallet cannot enforce limits", async () => {
    const harness = await makeHarness({ submitMode: "confirmed" });
    const { runtime, ledger } = harness;
    const environmentId = `31337:${deployment.core}`;
    // The harness clock is fixed at the fixture timestamp plus ten seconds.
    const harnessNow = (1_800_000_000 + 10) * 1000;
    const expiresAt = new Date(harnessNow + 30 * 60_000);

    await expect(
      runtime.authorize({
        maxMints: 5,
        maxFeeNative: 500_000_000_000_000_000n,
        maxGasNative: 10_000n,
        expiresAt,
      }),
    ).resolves.toMatchObject({ ok: false });

    const session = await runtime.authorize({
      maxMints: 5,
      maxFeeNative: 500_000_000_000_000_000n,
      maxGasNative: 10_000n,
      expiresAt,
      enforcement: "session",
    });
    expect(session.ok).toBe(true);
    expect(session.data.enforcement).toBe("session");
    expect(
      ledger.authorization(environmentId, walletAddress)?.enforcement,
    ).toBe("session");

    await expect(
      runtime.authorize({
        maxMints: 10_001,
        maxFeeNative: 2_000_000_000_000_000_000_000n,
        maxGasNative: 10_000n,
        expiresAt,
        enforcement: "session",
      }),
    ).resolves.toMatchObject({ ok: false });

    await expect(
      runtime.authorize({
        maxMints: 5,
        maxFeeNative: 500_000_000_000_000_000n,
        maxGasNative: 10_000n,
        expiresAt: new Date(harnessNow + 7 * 60 * 60_000),
        enforcement: "session",
      }),
    ).resolves.toMatchObject({ ok: false });
  });
});

describe("durable work verification recovery", () => {
  it("persists an issued Challenge before mining and resumes it after restart", async () => {
    const path = join(
      await mkdtemp(join(tmpdir(), "arcals-challenge-recovery-")),
      "ledger.sqlite",
    );
    let challenges = 0;
    const first = await makeHarness({
      ledgerPath: path,
      submitMode: "confirmed",
      onChallenge: () => {
        challenges++;
      },
      miner: {
        mine: async () => {
          throw new Error("process interrupted during RandomX");
        },
        close: async () => undefined,
      },
    });
    const interrupted = await first.runtime.mineOnce({
      confirmed: true,
      unattended: false,
      threads: 1,
    });
    expect(interrupted.ok).toBe(false);
    const saved = first.ledger.pendingWork(
      `31337:${deployment.core}`,
      walletAddress,
    );
    expect(saved).not.toBeNull();
    expect(JSON.parse(saved!)).toMatchObject({
      challenge: { minter: walletAddress, mintNonce: "0" },
      issuerSignature: expect.any(String),
    });
    expect(JSON.parse(saved!)).not.toHaveProperty("workNonce");
    await first.close();
    first.ledger.close();
    ledgers.splice(ledgers.indexOf(first.ledger), 1);

    const mined = { calls: 0 };
    const resumed = await makeHarness({
      ledgerPath: path,
      submitMode: "confirmed",
      onChallenge: () => {
        challenges++;
      },
      miner: countingMiner(mined),
    });
    const minted = await resumed.runtime.mineOnce({
      confirmed: true,
      unattended: false,
      threads: 1,
    });
    expect(minted.state).toBe("MINT_CONFIRMED");
    expect(challenges).toBe(1);
    expect(mined.calls).toBe(1);
    expect(
      resumed.ledger.pendingWork(`31337:${deployment.core}`, walletAddress),
    ).toBeNull();
    await resumed.close();
  });

  for (const failure of ["lost-response", "verifier-interrupted"] as const) {
    it(`resumes without new work after ${failure} and process restart`, async () => {
      const path = join(
        await mkdtemp(join(tmpdir(), "arcals-work-recovery-")),
        "ledger.sqlite",
      );
      const keys: string[] = [];
      let challenges = 0;
      const first = await makeHarness({
        ledgerPath: path,
        submitMode: "confirmed",
        workResponseLost: failure === "lost-response",
        verifierUnavailable: failure === "verifier-interrupted",
        onChallenge: () => {
          challenges++;
        },
        onWorkSubmit: (key) => keys.push(key),
      });
      const failed = await first.runtime.mineOnce({
        confirmed: true,
        unattended: false,
        threads: 1,
      });
      expect(failed.ok).toBe(false);
      expect(first.wallet.submitCount).toBe(0);
      await first.close();
      first.ledger.close();
      ledgers.splice(ledgers.indexOf(first.ledger), 1);
      const resumed = await makeHarness({
        ledgerPath: path,
        submitMode: "confirmed",
        onChallenge: () => {
          challenges++;
        },
        onWorkSubmit: (key) => keys.push(key),
        miner: {
          mine: async () => {
            throw new Error("must not recompute saved work");
          },
          close: async () => undefined,
        },
      });
      const minted = await resumed.runtime.mineOnce({
        confirmed: true,
        unattended: false,
        threads: 1,
      });
      expect(minted.state).toBe("MINT_CONFIRMED");
      expect(resumed.wallet.submitCount).toBe(1);
      expect(challenges).toBe(1);
      expect(keys.length).toBe(failure === "lost-response" ? 2 : 1);
      expect(new Set(keys).size).toBe(1);
      expect(
        resumed.ledger.pendingWork(`31337:${deployment.core}`, walletAddress),
      ).toBeNull();
      await resumed.close();
    });
  }
});
