import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  MintProgressSummary,
  describeEvent,
  nodeVersionSupported,
  platformSupported,
  shouldResume,
  workerPlatformKey,
} from "./wizard.mjs";

test("wizard aggregates routine Mint events into low-frequency progress", () => {
  const progress = new MintProgressSummary(1_000);
  assert.deepEqual(
    progress.event(
      {
        state: "RUNNING",
        wallets: 12,
        maxConcurrency: 12,
        maximumMints: 84,
        confirmedMints: 12,
      },
      2_000,
    ),
    [
      "Mint 已启动：12 个钱包，最多 12 路并发。",
      "进度：12/84（14%）｜剩余 72｜已结束钱包 0/12｜自动重试 0｜运行 0秒",
    ],
  );
  assert.deepEqual(
    progress.event(
      {
        state: "COMPUTING",
        lane: 1,
        detail: { threads: "16" },
      },
      3_000,
    ),
    [],
  );
  for (let index = 0; index < 4; index += 1) {
    assert.deepEqual(
      progress.event(
        { state: "LANE_RESULT", ok: true, resultState: "MINT_CONFIRMED" },
        4_000 + index,
      ),
      [],
    );
  }
  assert.deepEqual(
    progress.event(
      { state: "LANE_RESULT", ok: true, resultState: "MINT_CONFIRMED" },
      5_000,
    ),
    ["进度：17/84（20%）｜剩余 67｜已结束钱包 0/12｜自动重试 0｜运行 3秒"],
  );
  assert.deepEqual(progress.tick(35_000), [
    "进度：17/84（20%）｜剩余 67｜已结束钱包 0/12｜自动重试 0｜运行 33秒",
  ]);
});

test("wizard reports retries compactly and prints a final aggregate", () => {
  const progress = new MintProgressSummary(0);
  progress.event(
    {
      state: "RUNNING",
      wallets: 2,
      maxConcurrency: 2,
      maximumMints: 4,
      confirmedMints: 3,
    },
    1_000,
  );
  assert.deepEqual(progress.event({ state: "LANE_RETRY", index: 1 }, 2_000), [
    "网络或服务暂时不可用，正在自动重试（累计 1 次）。",
  ]);
  assert.deepEqual(
    progress.event(
      {
        state: "COMPLETE",
        results: [
          { index: 1, state: "COMPLETE" },
          { index: 2, state: "BALANCE_EXHAUSTED" },
        ],
      },
      3_000,
    ),
    [
      "进度：3/4（75%）｜剩余 1｜已结束钱包 2/2｜自动重试 1｜运行 2秒",
      "全部钱包已完成，或余额已不足下一次 Mint。",
    ],
  );
});

test("wizard enforces the documented Node.js minimum", () => {
  assert.equal(nodeVersionSupported("22.21.9"), false);
  assert.equal(nodeVersionSupported("22.22.0"), true);
  assert.equal(nodeVersionSupported("24.1.0"), true);
});

test("wizard chooses resume when wallet or runtime state already exists", () => {
  assert.equal(
    shouldResume({ workersExist: false, stateExists: false }),
    false,
  );
  assert.equal(shouldResume({ workersExist: true, stateExists: false }), true);
  assert.equal(shouldResume({ workersExist: false, stateExists: true }), true);
});

test("wizard maps every operating system to the shared worker manifest", () => {
  const manifest = {
    worker: {
      platforms: {
        "darwin-arm64": {},
        "linux-x64": {},
        "linux-arm64": {},
        "win32-x64": {},
      },
    },
  };
  assert.equal(workerPlatformKey("win32", "x64"), "win32-x64");
  assert.equal(platformSupported(manifest, "darwin", "arm64"), true);
  assert.equal(platformSupported(manifest, "linux", "x64"), true);
  assert.equal(platformSupported(manifest, "win32", "x64"), true);
  assert.equal(platformSupported(manifest, "darwin", "x64"), false);
});

test("wizard turns machine plans into readable Chinese output", () => {
  const lines = describeEvent({
    state: "PLAN",
    fundingAddress: "0x1111111111111111111111111111111111111111",
    fundingBalanceUSDC: "12.5",
    walletCount: 4,
    maxConcurrency: 4,
    miningThreads: 8,
    machine: { logicalCpus: 8, totalMemoryGiB: 16 },
  });
  assert.match(lines.join("\n"), /12\.5 USDC/u);
  assert.match(lines.join("\n"), /4 个工作钱包/u);
  assert.match(lines.join("\n"), /8 CPU/u);
});

test("wizard never prints key material from funding events", () => {
  const lines = describeEvent({
    state: "FUNDING_WALLET_CREATED",
    fundingAddress: "0x1111111111111111111111111111111111111111",
    privateKey: "should-not-appear",
  });
  assert.doesNotMatch(lines.join("\n"), /should-not-appear/u);
});

test("wizard opens its menu and exits without creating wallets", () => {
  const directory = mkdtempSync(join(tmpdir(), "arcals-wizard-test-"));
  try {
    const localConfig = join(directory, "multi-eoa.config.json");
    const wizardPath = fileURLToPath(new URL("./wizard.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [wizardPath], {
      encoding: "utf8",
      input: "0\n",
      env: { ...process.env, ARCALS_WIZARD_CONFIG: localConfig },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /开始或继续自动流程/u);
    assert.equal(existsSync(localConfig), true);
    assert.equal(existsSync(join(directory, "private")), false);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
