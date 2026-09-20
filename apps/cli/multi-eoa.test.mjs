import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { privateKeyToAccount } from "viem/accounts";

import {
  MINT_FEE_NATIVE,
  SharedMinerQueue,
  buildEqualDistribution,
  laneRetryDelay,
  machineProfile,
  mintOnlyAction,
  mintPlanForBalance,
  recommendRuntime,
  validateMultiEoaConfig,
} from "./multi-eoa-policy.mjs";
import {
  createWalletStore,
  loadWalletStore,
} from "./multi-eoa-wallet-store.mjs";

const profile = machineProfile({
  logicalCpus: 8,
  totalMemoryBytes: 16 * 1024 ** 3,
});
const baseConfig = {
  walletStoreDir: "private/wallets",
  stateDir: "private/state",
  walletCount: "auto",
  maxWallets: 12,
  maxConcurrency: "auto",
  miningThreads: "auto",
  sessionMinutes: 10080,
  funderReserveUSDC: "0.001",
  minimumWorkerGasUSDC: "0.001",
};

test("machine profile chooses a bounded wallet count from CPU and memory", () => {
  assert.deepEqual(recommendRuntime(profile, 12), {
    walletCount: 8,
    maxConcurrency: 8,
    miningThreads: 8,
  });
  assert.equal(
    recommendRuntime(
      machineProfile({
        logicalCpus: 32,
        totalMemoryBytes: 8 * 1024 ** 3,
      }),
      12,
    ).walletCount,
    4,
  );
});

test("config expands automatic values and rejects removed provider settings", () => {
  const config = validateMultiEoaConfig(baseConfig, profile);
  assert.equal(config.walletCount, 8);
  assert.equal(config.maxConcurrency, 8);
  assert.equal(config.miningThreads, 8);
  assert.equal(config.funderReserve, 10n ** 15n);
  assert.equal(config.minimumWorkerGas, 10n ** 15n);
  assert.equal(config.minimumWorkerBalance, 101n * 10n ** 15n);
  assert.throws(() =>
    validateMultiEoaConfig({ ...baseConfig, funder: {} }, profile),
  );
  assert.throws(() =>
    validateMultiEoaConfig({ ...baseConfig, walletCount: 13 }, profile),
  );
  assert.throws(() =>
    validateMultiEoaConfig(
      { ...baseConfig, walletCount: 2, maxConcurrency: 3 },
      profile,
    ),
  );
});

test("equal distribution reserves transfer gas and gives every worker the same amount", () => {
  const wallets = [
    { index: 1, address: "0x1000000000000000000000000000000000000001" },
    { index: 2, address: "0x2000000000000000000000000000000000000002" },
  ];
  const split = buildEqualDistribution(
    wallets,
    1_000_000_000_000_000_000n,
    10_000_000_000_000_000n,
    1_000_000_000_000_000n,
  );
  assert.equal(split.amountNative, 494_000_000_000_000_000n);
  assert.equal(split.totalGasNative, 2_000_000_000_000_000n);
  assert.equal(split.retainedNative, 10_000_000_000_000_000n);
  assert.deepEqual(
    split.transfers.map((item) => item.amountNative),
    [494_000_000_000_000_000n, 494_000_000_000_000_000n],
  );
  assert.throws(() => buildEqualDistribution(wallets, MINT_FEE_NATIVE, 0n, 1n));
});

test("mint plan binds a lane to its starting balance and stops below one fee", () => {
  assert.deepEqual(mintPlanForBalance(MINT_FEE_NATIVE), {
    maxMints: 0,
    mintBudgetNative: 0n,
    totalSpendCapNative: MINT_FEE_NATIVE,
  });
  assert.deepEqual(mintPlanForBalance(350000000000000000n), {
    maxMints: 3,
    mintBudgetNative: 300000000000000000n,
    totalSpendCapNative: 350000000000000000n,
  });
});

test("wallet store is atomic, private, address-verified and never stores keys in its index", () => {
  const root = mkdtempSync(join(tmpdir(), "arcals-multi-eoa-"));
  const store = join(root, "wallets");
  const keys = [`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`];
  let cursor = 0;
  try {
    const created = createWalletStore(store, 2, () => keys[cursor++]);
    assert.equal(created.wallets.length, 2);
    assert.equal(statSync(store).mode & 0o077, 0);
    for (let index = 1; index <= 2; index += 1) {
      assert.equal(
        statSync(join(store, `wallet-${String(index).padStart(2, "0")}.key`))
          .mode & 0o077,
        0,
      );
    }
    const publicIndex = readFileSync(join(store, "wallets.json"), "utf8");
    assert.ok(!publicIndex.includes("11".repeat(32)));
    assert.ok(!publicIndex.includes("22".repeat(32)));
    const loaded = loadWalletStore(store);
    assert.equal(
      loaded.wallets[0].address,
      privateKeyToAccount(keys[0]).address.toLowerCase(),
    );
    assert.throws(() => createWalletStore(store, 2), /EXISTS/);
    chmodSync(join(store, "wallet-01.key"), 0o644);
    assert.throws(() => loadWalletStore(store), /INSECURE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shared RandomX queue never runs two jobs concurrently and closes once", async () => {
  let active = 0;
  let maximum = 0;
  let closes = 0;
  const miner = {
    async mine(request) {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, request.delay));
      active -= 1;
      return { id: request.id };
    },
    async close() {
      closes += 1;
    },
  };
  const queue = new SharedMinerQueue(miner);
  const results = await Promise.all([
    queue.mine({ id: 1, delay: 20 }),
    queue.mine({ id: 2, delay: 1 }),
    queue.mine({ id: 3, delay: 1 }),
  ]);
  assert.deepEqual(
    results.map((result) => result.id),
    [1, 2, 3],
  );
  assert.equal(maximum, 1);
  await queue.close();
  assert.equal(closes, 1);
  await assert.rejects(() => queue.mine({ id: 4, delay: 1 }), /closed/);
});

test("mint-only action waits for unresolved work and stops at the lane cap", () => {
  assert.deepEqual(mintOnlyAction({ unresolved: [{}], operations: [] }, 2), {
    kind: "wait",
  });
  assert.deepEqual(
    mintOnlyAction(
      {
        unresolved: [
          {
            kind: "MINT",
            state: "CERTIFICATE_READY",
            providerRequestId: null,
            walletHandle: null,
            certificateExpiresAt: "2027-01-01T00:05:00.000Z",
          },
        ],
        operations: [],
      },
      2,
      Date.parse("2027-01-01T00:00:00.000Z"),
    ),
    { kind: "mint", confirmed: 0 },
  );
  const minted = { kind: "MINT", state: "MINT_CONFIRMED" };
  assert.deepEqual(
    mintOnlyAction({ unresolved: [], operations: [minted, minted] }, 2),
    { kind: "complete", confirmed: 2 },
  );
});

test("active-operation retries start quickly and back off without a hot loop", () => {
  assert.deepEqual(laneRetryDelay("ACTIVE_OPERATION_EXISTS", null, 0), {
    waitMs: 500,
    failures: 1,
  });
  assert.deepEqual(laneRetryDelay("ACTIVE_OPERATION_EXISTS", null, 8), {
    waitMs: 5_000,
    failures: 9,
  });
  assert.deepEqual(laneRetryDelay("ACTIVE_OPERATION_EXISTS", 1_750, 0), {
    waitMs: 1_750,
    failures: 1,
  });
});

test("preview commands create neither wallet keys nor state", () => {
  const root = mkdtempSync(join(tmpdir(), "arcals-multi-eoa-cli-"));
  const configPath = join(root, "config.json");
  const store = join(root, "wallets");
  const state = join(root, "state");
  try {
    writeFileSync(
      configPath,
      JSON.stringify({ ...baseConfig, walletStoreDir: store, stateDir: state }),
    );
    for (const command of ["plan", "init", "run", "resume"]) {
      const result = spawnSync(
        process.execPath,
        [
          new URL("./multi-eoa.mjs", import.meta.url).pathname,
          command,
          configPath,
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.doesNotThrow(() => JSON.parse(result.stdout));
    }
    assert.equal(existsSync(store), false);
    assert.equal(existsSync(state), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
