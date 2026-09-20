import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  describeEvent,
  nodeVersionSupported,
  shouldResume,
} from "./wizard.mjs";

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
