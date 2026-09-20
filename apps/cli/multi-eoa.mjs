#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { ArcalsWorkApiClient } from "@arcals/sdk";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  formatEther,
  http,
  keccak256,
} from "viem";

import {
  AgentRuntime,
  RealRandomXMiner,
  SqliteOperationLedger,
  ViemChainRecoveryGateway,
  loadAgentManifest,
  verifyApiConfiguration,
  verifyOnchainDeployment,
  verifyWorkerIntegrity,
} from "./dist/index.js";
import { loadWalletAccount, validateConfig } from "./evm-policy.mjs";
import { createBoundedWallet } from "./evm-wallet.mjs";
import {
  SharedMinerQueue,
  buildEqualDistribution,
  laneRetryDelay,
  machineProfile,
  mintOnlyAction,
  mintPlanForBalance,
  validateMultiEoaConfig,
} from "./multi-eoa-policy.mjs";
import {
  createWalletStore,
  loadWalletStore,
} from "./multi-eoa-wallet-store.mjs";

process.umask(0o077);

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const manifestPath = join(repositoryRoot, "manifests/arc-mainnet.json");
const ALLOWED_COMMANDS = new Set([
  "plan",
  "init",
  "run",
  "resume",
  "status",
  "stop",
]);
const SYSTEMIC_CODES = new Set(["WRONG_NETWORK", "UNTRUSTED_DEPLOYMENT"]);

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function safeMessage(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(?:0x)?[a-fA-F0-9]{64,}/g, "[redacted]")
    .slice(0, 500);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temporary, path);
}

function loadConfiguration(configArg) {
  const configPath = resolve(configArg);
  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  const profile = machineProfile();
  const validated = validateMultiEoaConfig(raw, profile);
  const base = dirname(configPath);
  const walletStoreDir = resolve(base, validated.walletStoreDir);
  return {
    configPath,
    raw,
    config: {
      ...validated,
      walletStoreDir,
      fundingStoreDir: join(walletStoreDir, "funding"),
      workerStoreDir: join(walletStoreDir, "workers"),
      stateDir: resolve(base, validated.stateDir),
    },
  };
}

function chainFor(manifest) {
  return defineChain({
    id: Number(manifest.chainId),
    name: "Arc Mainnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [manifest.rpcUrl] } },
  });
}

function clientsFor(manifest) {
  const chain = chainFor(manifest);
  const urls = [manifest.rpcUrl, ...(manifest.rpcFallbackUrls ?? [])];
  const transports = urls.map((url) =>
    http(url, {
      batch: { batchSize: 50, wait: 10 },
      retryCount: 1,
      retryDelay: 300,
      timeout: 15_000,
    }),
  );
  const transport =
    transports.length === 1
      ? transports[0]
      : fallback(transports, { rank: false, retryCount: 2, retryDelay: 400 });
  const publicClient = createPublicClient({ chain, transport });
  const broadcasters = urls.map((url) =>
    createPublicClient({
      chain,
      transport: http(url, { retryCount: 0, timeout: 10_000 }),
    }),
  );
  return { chain, transport, publicClient, broadcasters };
}

function fundingWallet(config, withKey = false) {
  const { wallets } = loadWalletStore(config.fundingStoreDir, 1);
  const record = wallets[0];
  return withKey
    ? { ...record, account: loadWalletAccount(record.keyPath, record.address) }
    : record;
}

function workerWallets(config, createIfMissing = false) {
  if (!existsSync(config.workerStoreDir)) {
    if (!createIfMissing) return null;
    return createWalletStore(
      config.workerStoreDir,
      config.walletCount,
    ).wallets.map((wallet) => ({
      ...wallet,
      keyPath: join(config.workerStoreDir, wallet.keyFile),
    }));
  }
  return loadWalletStore(config.workerStoreDir).wallets;
}

async function assertNetwork(publicClient, manifest) {
  if ((await publicClient.getChainId()) !== Number(manifest.chainId)) {
    throw new Error("WRONG_NETWORK");
  }
}

async function planCommand(config, manifest) {
  const fundingReady = existsSync(config.fundingStoreDir);
  const workers = workerWallets(config, false);
  const base = {
    state: "PLAN",
    signing: false,
    fundingWallet: fundingReady ? "READY" : "NOT_CREATED",
    workerWallets: workers === null ? "NOT_CREATED" : "READY",
    walletCount: workers?.length ?? config.walletCount,
    maxConcurrency: Math.min(
      config.maxConcurrency,
      workers?.length ?? config.walletCount,
    ),
    miningThreads: config.miningThreads,
    automatic: config.automatic,
    machine: config.machine,
    privateKeysPrinted: false,
  };
  if (!fundingReady) {
    emit({ ...base, next: "init CONFIG --execute" });
    return;
  }
  const funder = fundingWallet(config);
  const { publicClient } = clientsFor(manifest);
  await assertNetwork(publicClient, manifest);
  const balance = await publicClient.getBalance({ address: funder.address });
  emit({
    ...base,
    fundingAddress: funder.address,
    fundingBalanceUSDC: formatEther(balance),
    next: "Deposit native USDC on Arc Mainnet, then run CONFIG --execute",
  });
}

function distributionPath(config) {
  return join(config.stateDir, "distribution.json");
}

function loadDistribution(config) {
  const path = distributionPath(config);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

async function createDistribution(
  config,
  manifest,
  funder,
  wallets,
  publicClient,
) {
  const existing = loadDistribution(config);
  if (existing !== null) {
    if (
      existing.fundingAddress !== funder.address ||
      JSON.stringify(existing.workerAddresses) !==
        JSON.stringify(wallets.map((wallet) => wallet.address))
    ) {
      throw new Error(
        "DISTRIBUTION_CONFIG_CHANGED: restore the original wallet store and config",
      );
    }
    return existing;
  }
  const workerBalances = await Promise.all(
    wallets.map((wallet) =>
      publicClient.getBalance({ address: wallet.address }),
    ),
  );
  if (workerBalances.some((balance) => balance !== 0n)) {
    throw new Error(
      "WORKER_BALANCE_NOT_ZERO: refusing to create a new equal-split plan for funded workers",
    );
  }
  const funderBalance = await publicClient.getBalance({
    address: funder.address,
  });
  const estimatedGas = await publicClient.estimateGas({
    account: funder.address,
    to: wallets[0].address,
    value: 1n,
  });
  const gas = (estimatedGas * 120n + 99n) / 100n;
  const fees = await publicClient.estimateFeesPerGas();
  const feeFields =
    fees.maxFeePerGas !== undefined
      ? {
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n,
        }
      : { gasPrice: fees.gasPrice };
  const gasPrice = fees.maxFeePerGas ?? fees.gasPrice;
  const split = buildEqualDistribution(
    wallets,
    funderBalance,
    config.funderReserve,
    gas * gasPrice,
    config.minimumWorkerBalance,
  );
  const startingNonce = await publicClient.getTransactionCount({
    address: funder.address,
    blockTag: "pending",
  });
  const transfers = [];
  for (const transfer of split.transfers) {
    const transaction = {
      chainId: Number(manifest.chainId),
      nonce: startingNonce + transfer.index - 1,
      to: transfer.address,
      value: transfer.amountNative,
      gas,
      ...feeFields,
    };
    const serializedTransaction =
      await funder.account.signTransaction(transaction);
    transfers.push({
      index: transfer.index,
      address: transfer.address,
      amountNative: transfer.amountNative.toString(),
      amountUSDC: transfer.amountUSDC,
      nonce: transaction.nonce,
      transactionHash: keccak256(serializedTransaction),
      serializedTransaction,
      state: "PREPARED",
    });
  }
  const journal = {
    schemaVersion: "1",
    environmentId: manifest.environmentId,
    chainId: manifest.chainId,
    fundingAddress: funder.address,
    workerAddresses: wallets.map((wallet) => wallet.address),
    startingBalanceNative: funderBalance.toString(),
    startingBalanceUSDC: formatEther(funderBalance),
    funderReserveNative: config.funderReserve.toString(),
    gasLimit: gas.toString(),
    maxGasPerTransferNative: (gas * gasPrice).toString(),
    equalAmountNative: split.amountNative.toString(),
    equalAmountUSDC: split.amountUSDC,
    retainedMaximumNative: split.retainedNative.toString(),
    createdAt: new Date().toISOString(),
    transfers,
  };
  writeJsonAtomic(distributionPath(config), journal);
  emit({
    state: "DISTRIBUTION_PREPARED",
    fundingAddress: funder.address,
    walletCount: wallets.length,
    amountPerWalletUSDC: split.amountUSDC,
    totalTransferUSDC: formatEther(split.totalTransferNative),
    maximumTransferGasUSDC: formatEther(split.totalGasNative),
  });
  return journal;
}

async function receiptOrNull(publicClient, hash) {
  try {
    return await publicClient.getTransactionReceipt({ hash });
  } catch {
    return null;
  }
}

async function transactionOrNull(publicClient, hash) {
  try {
    return await publicClient.getTransaction({ hash });
  } catch {
    return null;
  }
}

async function waitForReceipt(publicClient, hash, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await receiptOrNull(publicClient, hash);
    if (receipt !== null) return receipt;
    await delay(2_000);
  }
  return null;
}

async function executeDistribution(
  config,
  publicClient,
  broadcasters,
  journal,
) {
  if (existsSync(join(config.stateDir, "runner.lock"))) {
    throw new Error(
      "RUNNER_ACTIVE: refusing to distribute while the mint runner is active",
    );
  }
  for (let index = 0; index < journal.transfers.length; index += 1) {
    const transfer = journal.transfers[index];
    let receipt = await receiptOrNull(publicClient, transfer.transactionHash);
    if (receipt === null) {
      const known = await transactionOrNull(
        publicClient,
        transfer.transactionHash,
      );
      if (known === null) {
        const hash = await Promise.any(
          broadcasters.map((client) =>
            client.sendRawTransaction({
              serializedTransaction: transfer.serializedTransaction,
            }),
          ),
        ).catch((error) => {
          const cause =
            error instanceof AggregateError
              ? error.errors.find((item) => item instanceof Error)
              : error;
          throw new Error(
            `DISTRIBUTION_BROADCAST_FAILED: ${safeMessage(cause ?? error)}`,
          );
        });
        if (hash.toLowerCase() !== transfer.transactionHash.toLowerCase()) {
          throw new Error("Distribution transaction hash mismatch");
        }
      }
      transfer.state = "SUBMITTED";
      transfer.submittedAt ??= new Date().toISOString();
      writeJsonAtomic(distributionPath(config), journal);
      receipt = await waitForReceipt(publicClient, transfer.transactionHash);
    }
    if (receipt === null) {
      throw new Error(
        `DISTRIBUTION_PENDING: transfer ${String(transfer.index)} has an unknown outcome; resume later`,
      );
    }
    if (receipt.status !== "success") {
      transfer.state = "REVERTED";
      transfer.confirmedAt = new Date().toISOString();
      writeJsonAtomic(distributionPath(config), journal);
      throw new Error(
        `DISTRIBUTION_REVERTED: transfer ${String(transfer.index)} failed on chain`,
      );
    }
    transfer.state = "CONFIRMED";
    transfer.blockNumber = receipt.blockNumber.toString();
    transfer.confirmedAt ??= new Date().toISOString();
    writeJsonAtomic(distributionPath(config), journal);
    emit({
      state: "WORKER_FUNDED",
      index: transfer.index,
      address: transfer.address,
      amountUSDC: transfer.amountUSDC,
      transactionHash: transfer.transactionHash,
    });
  }
}

class Semaphore {
  active = 0;
  queue = [];

  constructor(limit) {
    this.limit = limit;
  }

  async use(action) {
    if (this.active >= this.limit) {
      await new Promise((resolveWaiter) => this.queue.push(resolveWaiter));
    }
    this.active += 1;
    try {
      return await action();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}

function sharedVerifier(manifest, publicClient, refreshMs = 60_000) {
  let workerVerified = false;
  let lastChainCheck = 0;
  let inflight = null;
  return async (config) => {
    verifyApiConfiguration(manifest, config);
    if (workerVerified && Date.now() - lastChainCheck < refreshMs) return;
    if (inflight === null) {
      inflight = (async () => {
        if (!workerVerified) {
          await verifyWorkerIntegrity(manifest);
          workerVerified = true;
        }
        await verifyOnchainDeployment(manifest, publicClient);
        lastChainCheck = Date.now();
      })().finally(() => {
        inflight = null;
      });
    }
    await inflight;
  };
}

async function runLane(context, global) {
  let failures = 0;
  const retryable = new Set([
    "ACTIVE_OPERATION_EXISTS",
    "CHALLENGE_EXPIRED",
    "CERTIFICATE_EXPIRED",
    "DEPENDENCY_UNAVAILABLE",
    "RPC_RATE_LIMITED",
    "SUBMISSION_UNKNOWN",
  ]);
  for (;;) {
    if (global.stopping() || existsSync(global.stopPath)) {
      return {
        index: context.index,
        address: context.address,
        state: "STOPPED",
      };
    }
    if (Date.now() >= global.expiresAt) {
      return {
        index: context.index,
        address: context.address,
        state: "SESSION_EXPIRED",
      };
    }
    try {
      const status = await context.runtime.status();
      if (!status.ok) {
        throw Object.assign(new Error(status.error?.message ?? status.state), {
          api: status.error,
        });
      }
      const action = mintOnlyAction(status.data, context.maxMints);
      if (action.kind === "complete") {
        emit({
          state: "LANE_COMPLETE",
          index: context.index,
          address: context.address,
          confirmed: action.confirmed,
        });
        return {
          index: context.index,
          address: context.address,
          state: "COMPLETE",
          confirmed: action.confirmed,
        };
      }
      if (action.kind === "wait") {
        await delay(350);
        continue;
      }
      const result = await global.semaphore.use(() =>
        context.runtime.mineOnce({
          confirmed: false,
          unattended: true,
          threads: global.config.miningThreads,
        }),
      );
      emit({
        state: "LANE_RESULT",
        index: context.index,
        address: context.address,
        ok: result.ok,
        resultState: result.state,
        operationId: result.operationId,
        txHash: result.txHash,
        issuedId: result.data?.issuedId ?? null,
        error: result.error ?? null,
      });
      if (result.ok) {
        failures = 0;
        if (result.state !== "MINT_CONFIRMED") await delay(350);
        continue;
      }
      const code = result.error?.code ?? "UNKNOWN";
      if (SYSTEMIC_CODES.has(code)) {
        throw Object.assign(new Error(result.error?.message ?? code), {
          api: result.error,
        });
      }
      if (code === "INSUFFICIENT_FUNDS") {
        return {
          index: context.index,
          address: context.address,
          state: "BALANCE_EXHAUSTED",
        };
      }
      if (!result.error?.retryable && !retryable.has(code)) {
        return {
          index: context.index,
          address: context.address,
          state: "NEEDS_ATTENTION",
          error: result.error,
        };
      }
      const retry = laneRetryDelay(
        code,
        result.error?.retryAfterMs ?? null,
        failures,
      );
      failures = retry.failures;
      await delay(retry.waitMs);
    } catch (error) {
      if (SYSTEMIC_CODES.has(error.api?.code)) throw error;
      const message = safeMessage(error);
      if (message.startsWith("INSUFFICIENT_FUNDS")) {
        return {
          index: context.index,
          address: context.address,
          state: "BALANCE_EXHAUSTED",
        };
      }
      emit({
        state: "LANE_RETRY",
        index: context.index,
        address: context.address,
        message,
      });
      await delay(Math.min(30_000, 1_000 * 2 ** Math.min(failures++, 5)));
    }
  }
}

async function mintCommand(
  requestedCommand,
  config,
  manifest,
  wallets,
  rawConfig,
  initialPlans,
) {
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const lock = join(config.stateDir, "runner.lock");
  let ownsLock = false;
  try {
    mkdirSync(lock, { mode: 0o700 });
    ownsLock = true;
  } catch {
    throw new Error(
      "RUNNER_LOCKED: another runner is active or its lock needs inspection",
    );
  }
  writeFileSync(join(lock, "pid"), String(process.pid), { mode: 0o600 });
  const stopPath = join(config.stateDir, "STOP");
  const sessionPath = join(config.stateDir, "session.json");
  const fingerprint = digest(
    JSON.stringify({
      rawConfig,
      wallets: wallets.map((wallet) => wallet.address),
      manifest: digest(readFileSync(manifestPath)),
    }),
  );
  const runtimes = [];
  let miner = null;
  let stopping = false;
  const requestStop = () => {
    stopping = true;
    writeFileSync(stopPath, "stop\n", { mode: 0o600 });
  };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  try {
    let session;
    if (existsSync(sessionPath)) {
      session = JSON.parse(readFileSync(sessionPath, "utf8"));
      if (session.fingerprint !== fingerprint) {
        throw new Error(
          "CONFIG_CHANGED: resume requires the original config and wallet set",
        );
      }
      if (requestedCommand === "run") {
        throw new Error("SESSION_EXISTS: use resume with the same config");
      }
    } else {
      session = {
        schemaVersion: "1",
        fingerprint,
        startedAt: new Date().toISOString(),
        expiresAt: new Date(
          Date.now() + config.sessionMinutes * 60_000,
        ).toISOString(),
        addresses: wallets.map((wallet) => wallet.address),
        lanes: initialPlans.map((plan, index) => ({
          index: wallets[index].index,
          address: wallets[index].address,
          startingBalanceNative: plan.totalSpendCapNative.toString(),
          maxMints: plan.maxMints,
          mintBudgetNative: plan.mintBudgetNative.toString(),
          totalSpendCapNative: plan.totalSpendCapNative.toString(),
        })),
      };
      writeJsonAtomic(sessionPath, session);
    }
    if (Date.parse(session.expiresAt) <= Date.now()) {
      throw new Error("SESSION_EXPIRED: the configured session window ended");
    }
    if (existsSync(stopPath)) unlinkSync(stopPath);
    const { chain, transport, publicClient, broadcasters } =
      clientsFor(manifest);
    await assertNetwork(publicClient, manifest);
    const verifyEnvironment = sharedVerifier(manifest, publicClient);
    const sharedMiner = new SharedMinerQueue(
      new RealRandomXMiner(manifest.worker.binaryPath),
    );
    miner = sharedMiner;
    for (let offset = 0; offset < wallets.length; offset += 1) {
      const walletRecord = wallets[offset];
      const plan = session.lanes[offset];
      if (
        plan.address !== walletRecord.address ||
        plan.index !== walletRecord.index
      ) {
        throw new Error("SESSION_WALLET_MISMATCH");
      }
      const laneDir = join(
        config.stateDir,
        `wallet-${String(walletRecord.index).padStart(2, "0")}`,
      );
      mkdirSync(laneDir, { recursive: true, mode: 0o700 });
      const account = loadWalletAccount(
        walletRecord.keyPath,
        walletRecord.address,
      );
      const ledger = new SqliteOperationLedger(join(laneDir, "ledger.sqlite"));
      const operations = () =>
        ledger.listOperations(manifest.environmentId, walletRecord.address);
      const walletClient = createWalletClient({ account, chain, transport });
      const laneConfig = {
        count: plan.maxMints,
        mintBudgetUSDC: formatEther(BigInt(plan.mintBudgetNative)),
        gasBudgetUSDC: formatEther(BigInt(plan.totalSpendCapNative)),
        threads: config.miningThreads,
        sessionMinutes: config.sessionMinutes,
        keyFile: walletRecord.keyPath,
        stateDir: laneDir,
      };
      const limits = validateConfig(laneConfig);
      const guard = () => {
        if (
          stopping ||
          existsSync(stopPath) ||
          Date.now() >= Date.parse(session.expiresAt)
        ) {
          throw new Error("SIGNING_DISABLED_OR_SESSION_STOPPED");
        }
      };
      const Wallet = createBoundedWallet({
        guard,
        manifest,
        config: laneConfig,
        operations,
        publicClient,
        walletClient,
        account,
        address: walletRecord.address,
        limits,
        broadcasters,
        totalSpendCapNative: BigInt(plan.totalSpendCapNative),
      });
      const adapter = new Wallet({
        account,
        chainId: BigInt(manifest.chainId),
        publicClient,
        walletClient,
      });
      const runtime = new AgentRuntime({
        manifest,
        api: new ArcalsWorkApiClient(manifest.apiUrl),
        wallet: adapter,
        ledger,
        miner: {
          mine: (request) => sharedMiner.mine(request),
          close: async () => {},
        },
        publicClient,
        chain: new ViemChainRecoveryGateway(
          publicClient,
          manifest.deployment.core,
        ),
        verifyEnvironment,
        progress: (event) =>
          emit({
            lane: walletRecord.index,
            address: walletRecord.address,
            ...event,
          }),
      });
      const preflight = await runtime.preflight();
      if (!preflight.ok) {
        throw new Error(
          `Lane ${String(walletRecord.index)} preflight failed: ${preflight.error?.message ?? preflight.state}`,
        );
      }
      const authorization = await runtime.authorize({
        maxMints: plan.maxMints,
        maxFeeNative: BigInt(plan.mintBudgetNative),
        maxGasNative: BigInt(plan.totalSpendCapNative),
        expiresAt: new Date(session.expiresAt),
        enforcement: "session",
      });
      if (!authorization.ok) {
        throw new Error(
          `Lane ${String(walletRecord.index)} authorization failed: ${authorization.error?.message ?? authorization.state}`,
        );
      }
      runtimes.push({
        index: walletRecord.index,
        address: walletRecord.address,
        maxMints: plan.maxMints,
        confirmedMints: operations().filter(
          (operation) =>
            operation.kind === "MINT" && operation.state === "MINT_CONFIRMED",
        ).length,
        runtime,
        ledger,
      });
    }
    emit({
      state: "RUNNING",
      wallets: runtimes.length,
      maxConcurrency: Math.min(config.maxConcurrency, runtimes.length),
      maximumMints: session.lanes.reduce((sum, lane) => sum + lane.maxMints, 0),
      confirmedMints: runtimes.reduce(
        (sum, runtime) => sum + runtime.confirmedMints,
        0,
      ),
      sharedRandomX: true,
      expiresAt: session.expiresAt,
    });
    const semaphore = new Semaphore(
      Math.min(config.maxConcurrency, runtimes.length),
    );
    const global = {
      config,
      stopPath,
      expiresAt: Date.parse(session.expiresAt),
      semaphore,
      stopping: () => stopping,
    };
    const results = await Promise.all(
      runtimes.map((context) => runLane(context, global)),
    );
    const terminal = results.every((result) =>
      ["COMPLETE", "BALANCE_EXHAUSTED"].includes(result.state),
    );
    emit({
      state:
        stopping || existsSync(stopPath)
          ? "STOPPED"
          : terminal
            ? "COMPLETE"
            : "NEEDS_ATTENTION",
      results,
    });
  } finally {
    process.removeListener("SIGINT", requestStop);
    process.removeListener("SIGTERM", requestStop);
    for (const context of runtimes) {
      await context.runtime.close().catch(() => {});
      context.ledger.close();
    }
    await miner?.close().catch(() => {});
    if (ownsLock) rmSync(lock, { recursive: true, force: true });
  }
}

async function statusCommand(config, manifest, wallets) {
  const distribution = loadDistribution(config);
  const rows = [];
  for (const wallet of wallets ?? []) {
    const path = join(
      config.stateDir,
      `wallet-${String(wallet.index).padStart(2, "0")}`,
      "ledger.sqlite",
    );
    if (!existsSync(path)) {
      rows.push({
        index: wallet.index,
        address: wallet.address,
        confirmed: 0,
        unresolved: 0,
        state: "NOT_STARTED",
      });
      continue;
    }
    const ledger = new SqliteOperationLedger(path);
    try {
      const operations = ledger.listOperations(
        manifest.environmentId,
        wallet.address,
      );
      rows.push({
        index: wallet.index,
        address: wallet.address,
        confirmed: operations.filter(
          (item) => item.kind === "MINT" && item.state === "MINT_CONFIRMED",
        ).length,
        unresolved: operations.filter((item) =>
          [
            "CERTIFICATE_READY",
            "WALLET_SUBMITTING",
            "TX_PENDING",
            "SUBMISSION_UNKNOWN",
            "RECOVERING",
            "UNKNOWN",
          ].includes(item.state),
        ).length,
        state: "READY",
      });
    } finally {
      ledger.close();
    }
  }
  emit({
    state:
      existsSync(join(config.stateDir, "workflow.lock")) ||
      existsSync(join(config.stateDir, "runner.lock"))
        ? "RUNNING"
        : "IDLE",
    fundingWallet: existsSync(config.fundingStoreDir) ? "READY" : "NOT_CREATED",
    workerWallets: wallets === null ? "NOT_CREATED" : "READY",
    distribution:
      distribution === null
        ? "NOT_STARTED"
        : distribution.transfers.every(
              (transfer) => transfer.state === "CONFIRMED",
            )
          ? "CONFIRMED"
          : "INCOMPLETE",
    stopRequested: existsSync(join(config.stateDir, "STOP")),
    totalConfirmed: rows.reduce((sum, row) => sum + row.confirmed, 0),
    wallets: rows,
  });
}

async function executeRun(command, config, raw, manifest) {
  if (!existsSync(config.fundingStoreDir)) {
    throw new Error("FUNDING_WALLET_NOT_CREATED: run init first");
  }
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const workflowLock = join(config.stateDir, "workflow.lock");
  let ownsLock = false;
  try {
    mkdirSync(workflowLock, { mode: 0o700 });
    ownsLock = true;
  } catch {
    throw new Error(
      "WORKFLOW_LOCKED: another distribution or mint process is active, or its stale lock needs inspection",
    );
  }
  writeFileSync(join(workflowLock, "pid"), String(process.pid), {
    mode: 0o600,
  });
  try {
    const funder = fundingWallet(config, true);
    const wallets = workerWallets(config, true);
    const { publicClient, broadcasters } = clientsFor(manifest);
    await assertNetwork(publicClient, manifest);
    const distribution = await createDistribution(
      config,
      manifest,
      funder,
      wallets,
      publicClient,
    );
    await executeDistribution(config, publicClient, broadcasters, distribution);
    const balances = await Promise.all(
      wallets.map((wallet) =>
        publicClient.getBalance({ address: wallet.address }),
      ),
    );
    const plans = balances.map(mintPlanForBalance);
    if (plans.some((plan) => plan.maxMints < 1)) {
      throw new Error(
        "WORKER_BALANCE_INSUFFICIENT: every worker must be able to pay at least one mint",
      );
    }
    await mintCommand(command, config, manifest, wallets, raw, plans);
  } finally {
    if (ownsLock) rmSync(workflowLock, { recursive: true, force: true });
  }
}

async function main() {
  const [command = "plan", configArg = "multi-eoa.config.json", ...flags] =
    process.argv.slice(2);
  if (
    !ALLOWED_COMMANDS.has(command) ||
    flags.some((flag) => flag !== "--execute")
  ) {
    throw new Error(
      "usage: multi-eoa.mjs plan|init|run|resume|status|stop CONFIG [--execute]",
    );
  }
  const execute = flags.includes("--execute");
  const { raw, config } = loadConfiguration(configArg);
  const manifest = await loadAgentManifest(manifestPath);
  if (manifest.chainId !== "5042" || manifest.mode !== "arc-mainnet") {
    throw new Error("Unexpected manifest network");
  }
  if (command === "init") {
    if (!execute) {
      emit({
        state: "INIT_PREVIEW",
        signing: false,
        creates: "one local funding wallet",
        fundingStoreDir: config.fundingStoreDir,
        privateKeysPrinted: false,
        next: "init CONFIG --execute",
      });
      return;
    }
    const created = createWalletStore(config.fundingStoreDir, 1);
    emit({
      state: "FUNDING_WALLET_CREATED",
      fundingAddress: created.wallets[0].address,
      network: "Arc Mainnet",
      asset: "native USDC",
      privateKeysPrinted: false,
      next: "Deposit native USDC to fundingAddress, then run plan",
    });
    return;
  }
  if (command === "stop") {
    mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(config.stateDir, "STOP"), "stop\n", { mode: 0o600 });
    emit({
      state: "STOP_REQUESTED",
      newSignaturesBlocked: true,
      submittedTransactionsMayStillConfirm: true,
    });
    return;
  }
  if (command === "plan") {
    await planCommand(config, manifest);
    return;
  }
  const wallets = workerWallets(config, false);
  if (command === "status") {
    await statusCommand(config, manifest, wallets);
    return;
  }
  if (!execute) {
    const funder = existsSync(config.fundingStoreDir)
      ? fundingWallet(config)
      : null;
    emit({
      state: "RUN_PREVIEW",
      signing: false,
      command,
      fundingAddress: funder?.address ?? null,
      workerWalletCount: wallets?.length ?? config.walletCount,
      maxConcurrency: config.maxConcurrency,
      miningThreads: config.miningThreads,
      actions: [
        "create performance-sized worker wallets if absent",
        "split available native USDC equally with a recoverable journal",
        "mint concurrently until each session balance cannot cover another mint",
      ],
      next: `${command} CONFIG --execute`,
    });
    return;
  }
  await executeRun(command, config, raw, manifest);
}

main().catch((error) => {
  emit({ state: "STOPPED_ERROR", message: safeMessage(error) });
  process.exitCode = 1;
});
