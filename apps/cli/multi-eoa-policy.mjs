import { availableParallelism, totalmem } from "node:os";

import { formatEther, parseEther } from "viem";

export const MINT_FEE_NATIVE = 100000000000000000n;

function exactAmount(value, name, { allowZero = false } = {}) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(value)) {
    throw new Error(`${name} must be an exact decimal string`);
  }
  const parsed = parseEther(value);
  if (!allowZero && parsed <= 0n) throw new Error(`${name} must be positive`);
  return parsed;
}

function pathValue(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${name} must be a non-empty path`);
  }
  return value;
}

function integer(value, name, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be ${String(minimum)}..${String(maximum)}`);
  }
  return value;
}

export function machineProfile(overrides = {}) {
  const logicalCpus = integer(
    overrides.logicalCpus ?? availableParallelism(),
    "logicalCpus",
    1,
    1024,
  );
  const totalMemoryBytes = overrides.totalMemoryBytes ?? totalmem();
  if (
    !Number.isSafeInteger(totalMemoryBytes) ||
    totalMemoryBytes < 512 * 1024 * 1024
  ) {
    throw new Error("totalMemoryBytes must describe at least 512 MiB");
  }
  return {
    logicalCpus,
    totalMemoryBytes,
    totalMemoryGiB: Number((totalMemoryBytes / 1024 ** 3).toFixed(1)),
  };
}

export function recommendRuntime(profile, maxWallets = 12) {
  integer(maxWallets, "maxWallets", 1, 12);
  const cpuWallets = profile.logicalCpus;
  // One RandomX dataset is shared. Keep roughly 2 GiB available per active
  // lane so the OS and the Node process are not forced into swap.
  const memoryWallets = Math.max(
    1,
    Math.floor(profile.totalMemoryBytes / 2 ** 31),
  );
  const walletCount = Math.max(
    1,
    Math.min(maxWallets, cpuWallets, memoryWallets),
  );
  return {
    walletCount,
    maxConcurrency: walletCount,
    miningThreads: Math.max(1, Math.min(64, profile.logicalCpus)),
  };
}

export function validateMultiEoaConfig(config, profile = machineProfile()) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Config must be a JSON object");
  }
  for (const removed of ["funder", "mintsPerWallet"]) {
    if (removed in config) {
      throw new Error(`${removed} is not supported by the local-EOA workflow`);
    }
  }
  const maxWallets = integer(config.maxWallets ?? 12, "maxWallets", 1, 12);
  const recommended = recommendRuntime(profile, maxWallets);
  const walletCount =
    config.walletCount === undefined || config.walletCount === "auto"
      ? recommended.walletCount
      : integer(config.walletCount, "walletCount", 1, maxWallets);
  const maxConcurrency =
    config.maxConcurrency === undefined || config.maxConcurrency === "auto"
      ? walletCount
      : integer(config.maxConcurrency, "maxConcurrency", 1, walletCount);
  const miningThreads =
    config.miningThreads === undefined || config.miningThreads === "auto"
      ? recommended.miningThreads
      : integer(config.miningThreads, "miningThreads", 1, 64);
  const sessionMinutes = integer(
    config.sessionMinutes ?? 10080,
    "sessionMinutes",
    1,
    10080,
  );
  const funderReserve = exactAmount(
    config.funderReserveUSDC ?? "0.001",
    "funderReserveUSDC",
    { allowZero: true },
  );
  const minimumWorkerGas = exactAmount(
    config.minimumWorkerGasUSDC ?? "0.001",
    "minimumWorkerGasUSDC",
  );
  return {
    walletStoreDir: pathValue(config.walletStoreDir, "walletStoreDir"),
    stateDir: pathValue(config.stateDir, "stateDir"),
    maxWallets,
    walletCount,
    maxConcurrency,
    miningThreads,
    sessionMinutes,
    funderReserve,
    minimumWorkerGas,
    minimumWorkerBalance: MINT_FEE_NATIVE + minimumWorkerGas,
    machine: profile,
    automatic: {
      walletCount:
        config.walletCount === undefined || config.walletCount === "auto",
      maxConcurrency:
        config.maxConcurrency === undefined || config.maxConcurrency === "auto",
      miningThreads:
        config.miningThreads === undefined || config.miningThreads === "auto",
    },
  };
}

export function buildEqualDistribution(
  wallets,
  funderBalance,
  funderReserve,
  gasPerTransfer,
  minimumWorkerBalance = MINT_FEE_NATIVE,
) {
  if (!Array.isArray(wallets) || wallets.length === 0) {
    throw new Error("At least one worker wallet is required");
  }
  for (const value of [
    funderBalance,
    funderReserve,
    gasPerTransfer,
    minimumWorkerBalance,
  ]) {
    if (typeof value !== "bigint" || value < 0n) {
      throw new Error(
        "Distribution amounts must be non-negative bigint values",
      );
    }
  }
  const totalGas = gasPerTransfer * BigInt(wallets.length);
  if (funderBalance <= funderReserve + totalGas) {
    throw new Error(
      "FUNDER_BALANCE_INSUFFICIENT: balance cannot cover reserve and transfer gas",
    );
  }
  const distributable = funderBalance - funderReserve - totalGas;
  const amount = distributable / BigInt(wallets.length);
  if (amount < minimumWorkerBalance) {
    throw new Error(
      "FUNDER_BALANCE_INSUFFICIENT: each worker must cover one mint and its minimum gas reserve",
    );
  }
  return {
    amountNative: amount,
    amountUSDC: formatEther(amount),
    totalGasNative: totalGas,
    totalTransferNative: amount * BigInt(wallets.length),
    retainedNative: funderBalance - amount * BigInt(wallets.length) - totalGas,
    transfers: wallets.map((wallet) => ({
      index: wallet.index,
      address: wallet.address,
      amountNative: amount,
      amountUSDC: formatEther(amount),
    })),
  };
}

export function mintPlanForBalance(balance) {
  if (typeof balance !== "bigint" || balance <= MINT_FEE_NATIVE) {
    return { maxMints: 0, mintBudgetNative: 0n, totalSpendCapNative: balance };
  }
  const maxMints = Number(balance / MINT_FEE_NATIVE);
  if (!Number.isSafeInteger(maxMints) || maxMints > 10000) {
    throw new Error(
      "WORKER_BALANCE_TOO_LARGE: one wallet may authorize at most 10000 mints",
    );
  }
  return {
    maxMints,
    mintBudgetNative: BigInt(maxMints) * MINT_FEE_NATIVE,
    totalSpendCapNative: balance,
  };
}

export function mintOnlyAction(status, count, nowMs = Date.now()) {
  if (
    !status ||
    !Array.isArray(status.operations) ||
    !Array.isArray(status.unresolved)
  ) {
    throw new Error("Invalid status payload");
  }
  if (status.unresolved.length > 0) {
    const resumableCertifiedMint = status.unresolved.some(
      (operation) =>
        operation?.kind === "MINT" &&
        operation.state === "CERTIFICATE_READY" &&
        operation.providerRequestId === null &&
        operation.walletHandle === null &&
        typeof operation.certificateExpiresAt === "string" &&
        Date.parse(operation.certificateExpiresAt) > nowMs + 90_000,
    );
    if (!resumableCertifiedMint) return { kind: "wait" };
  }
  const confirmed = status.operations.filter(
    (operation) =>
      operation.kind === "MINT" && operation.state === "MINT_CONFIRMED",
  ).length;
  return confirmed >= count
    ? { kind: "complete", confirmed }
    : { kind: "mint", confirmed };
}

export function laneRetryDelay(code, retryAfterMs, failures) {
  if (!Number.isInteger(failures) || failures < 0) {
    throw new Error("failures must be a non-negative integer");
  }
  if (
    retryAfterMs !== null &&
    retryAfterMs !== undefined &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs >= 0
  ) {
    return {
      waitMs: Math.max(250, Math.min(30_000, Math.trunc(retryAfterMs))),
      failures: failures + 1,
    };
  }
  const activeOperation = code === "ACTIVE_OPERATION_EXISTS";
  const baseMs = activeOperation ? 500 : 1_000;
  const capMs = activeOperation ? 5_000 : 30_000;
  return {
    waitMs: Math.min(capMs, baseMs * 2 ** Math.min(failures, 5)),
    failures: failures + 1,
  };
}

export class SharedMinerQueue {
  #tail = Promise.resolve();
  #closed = false;

  constructor(miner) {
    this.miner = miner;
  }

  async mine(request) {
    if (this.#closed) throw new Error("Shared miner is closed");
    let release;
    const turn = new Promise((resolve) => {
      release = resolve;
    });
    const previous = this.#tail;
    this.#tail = previous.catch(() => {}).then(() => turn);
    await previous.catch(() => {});
    try {
      if (request.signal?.aborted)
        throw new Error("RandomX search was cancelled");
      return await this.miner.mine(request);
    } finally {
      release();
    }
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await this.#tail.catch(() => {});
    await this.miner.close();
  }
}
