import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTransaction, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcalMirrorAbi } from "@arcals/contract-bindings";
import {
  validateConfig,
  loadSecret,
  assertGasBudget,
  actionFor,
} from "./evm-policy.mjs";
import { createBoundedWallet } from "./evm-wallet.mjs";
const address = "0x1000000000000000000000000000000000000001";
const config = {
  walletAddress: address,
  count: 2,
  mintBudgetUSDC: "0.2",
  gasBudgetUSDC: "0.1",
  threads: 4,
  sessionMinutes: 60,
  keyFile: "k",
  stateDir: "s",
};
test("exact budgets reject float input, malformed amount and over-limit sessions", () => {
  assert.equal(validateConfig(config).mint, 200000000000000000n);
  for (const override of [
    { mintBudgetUSDC: 0.2 },
    { mintBudgetUSDC: "0.1" },
    { gasBudgetUSDC: "1e-2" },
    { count: 10001 },
    { sessionMinutes: 361 },
  ])
    assert.throws(() => validateConfig({ ...config, ...override }));
});
test("key reader rejects public permissions, symlinks and invalid contents without disclosure", () => {
  const dir = mkdtempSync(join(tmpdir(), "arcals-key-test-"));
  try {
    const path = join(dir, "key"),
      key = "11".repeat(32);
    writeFileSync(path, key, { mode: 0o600 });
    assert.equal(loadSecret(path), `0x${key}`);
    chmodSync(path, 0o644);
    assert.throws(() => loadSecret(path), /KEY_FILE_INVALID/);
    chmodSync(path, 0o600);
    symlinkSync(path, join(dir, "link"));
    assert.throws(() => loadSecret(join(dir, "link")));
    writeFileSync(path, "secret-invalid");
    assert.throws(
      () => loadSecret(path),
      (e) => !e.message.includes("secret-invalid"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("budget includes content gas and never releases the signed maximum after failure", () => {
  const ops = [
    { kind: "MINT", gasCommittedNative: "60", gasSpentNative: "20" },
    { kind: "CONTENT_REGISTER", gasCommittedNative: "50", gasSpentNative: "0" },
  ];
  assert.throws(() => assertGasBudget(ops, 100n));
  assert.doesNotThrow(() => assertGasBudget(ops, 110n));
});
test("resume waits on unknown transactions and registers existing NFT before new mint", () => {
  const minted = { kind: "MINT", state: "MINT_CONFIRMED", issuedId: "123" };
  assert.equal(
    actionFor({ unresolved: [{}], operations: [] }, 2, new Set()).kind,
    "wait",
  );
  assert.deepEqual(
    actionFor({ unresolved: [], operations: [minted] }, 2, new Set()),
    { kind: "content", id: "123" },
  );
  assert.equal(
    actionFor({ unresolved: [], operations: [minted] }, 1, new Set(["123"]))
      .kind,
    "complete",
  );
});
function harness(totalSpendCapNative) {
  const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const manifest = {
    deployment: {
      controller: address,
      mirror: "0x2000000000000000000000000000000000000002",
    },
  };
  let blocked = false,
    signed;
  const ops = [];
  const publicClient = {
    estimateGas: async () => 100n,
    estimateFeesPerGas: async () => ({
      maxFeePerGas: 10n,
      maxPriorityFeePerGas: 2n,
    }),
    sendRawTransaction: async () => {
      throw new Error("No network in tests");
    },
  };
  const walletClient = {
    prepareTransactionRequest: async (r) => {
      const { account, chain, ...tx } = r;
      return { ...tx, chainId: 5042, nonce: 7, type: "eip1559" };
    },
  };
  const signingAccount = {
    ...account,
    signTransaction: async (r) => {
      signed = await account.signTransaction(r);
      return signed;
    },
  };
  const Wallet = createBoundedWallet({
    guard: () => {
      if (blocked) throw new Error("stopped");
    },
    manifest,
    config,
    operations: () => ops,
    publicClient,
    walletClient,
    account: signingAccount,
    address: account.address.toLowerCase(),
    limits: { gas: 5000n },
    totalSpendCapNative,
  });
  const wallet = new Wallet({
    account: signingAccount,
    chainId: 5042n,
    publicClient,
    walletClient,
  });
  return {
    wallet,
    ops,
    manifest,
    publicClient,
    block: () => (blocked = true),
    signed: () => signed,
    call: {
      chainId: 5042n,
      to: address,
      data: "0x88e832cc",
      valueNative: 10n ** 17n,
    },
  };
}
test("EOA signs exact bounded gas/fees and chain, then stop prevents broadcast", async () => {
  const h = harness();
  const quote = await h.wallet.estimateFees(h.call);
  assert.equal(quote.maxGasNative, 1200n);
  h.ops.push({ gasCommittedNative: "1200", gasSpentNative: "0" });
  const handle = await h.wallet.prepareSubmission("id", h.call);
  const tx = parseTransaction(h.signed());
  assert.equal(tx.chainId, 5042);
  assert.equal(tx.gas, 120n);
  assert.equal(tx.maxFeePerGas, 10n);
  assert.equal(tx.value, 10n ** 17n);
  assert.equal(handle.transactionNonce, "7");
  h.block();
  await assert.rejects(h.wallet.submitCall("id"), /stopped/);
});
test("wallet rejects unknown targets, fee changes, unauthorized content and aggregate overflow", async () => {
  const h = harness();
  await assert.rejects(h.wallet.estimateFees({ ...h.call, valueNative: 1n }));
  await assert.rejects(h.wallet.estimateFees({ ...h.call, chainId: 1n }));
  await assert.rejects(
    h.wallet.estimateFees({ ...h.call, to: h.manifest.deployment.mirror }),
  );
  h.ops.push({ gasCommittedNative: "4900", gasSpentNative: "0" });
  await assert.rejects(h.wallet.estimateFees(h.call), /GAS_BUDGET/);
});

test("wallet refuses a new mint when its session balance cap cannot cover value plus maximum gas", async () => {
  const h = harness(10n ** 17n + 1199n);
  await assert.rejects(h.wallet.estimateFees(h.call), /INSUFFICIENT_FUNDS/);
  const enough = harness(10n ** 17n + 1200n);
  assert.equal(
    (await enough.wallet.estimateFees(enough.call)).maxGasNative,
    1200n,
  );
});
test("content allowlist accepts only this batch confirmed NFT with zero value", async () => {
  const h = harness();
  const call = {
    chainId: 5042n,
    to: h.manifest.deployment.mirror,
    valueNative: 0n,
    data: encodeFunctionData({
      abi: arcalMirrorAbi,
      functionName: "registerContent",
      args: [123n, "0x", []],
    }),
  };
  await assert.rejects(h.wallet.estimateFees(call));
  h.ops.push({
    kind: "MINT",
    state: "MINT_CONFIRMED",
    issuedId: "123",
    gasCommittedNative: "1",
    gasSpentNative: "1",
  });
  assert.equal((await h.wallet.estimateFees(call)).maxGasNative, 1200n);
});

test("address is derived from the local key and an optional mismatch is rejected", async () => {
  const { loadWalletAccount } = await import("./evm-policy.mjs");
  const { walletAddress, ...automatic } = config;
  assert.equal(validateConfig(automatic).mint, 200000000000000000n);
  const dir = mkdtempSync(join(tmpdir(), "arcals-auto-address-"));
  try {
    const file = join(dir, "wallet.key");
    writeFileSync(file, `0x${"11".repeat(32)}\n`, { mode: 0o600 });
    const account = loadWalletAccount(file);
    assert.equal(
      account.address,
      privateKeyToAccount(`0x${"11".repeat(32)}`).address,
    );
    assert.throws(
      () => loadWalletAccount(file, address),
      /KEY_ADDRESS_MISMATCH/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("receipt indexing lag must not mark a successful transaction as replaced", async () => {
  const h = harness();
  let reads = 0;
  h.publicClient.getTransactionReceipt = async () => {
    if (++reads === 1) throw new Error("not indexed yet");
    return {
      status: "success",
      gasUsed: 100n,
      effectiveGasPrice: 2n,
      blockNumber: 50n,
    };
  };
  h.publicClient.getTransaction = async () => {
    throw new Error("not indexed yet");
  };
  h.publicClient.getTransactionCount = async () => 8;
  const result = await h.wallet.querySubmission({
    kind: "transaction",
    chainId: "5042",
    hash: `0x${"22".repeat(32)}`,
    sender: address,
    transactionNonce: "7",
  });
  assert.equal(result.status, "CONFIRMED");
  assert.equal(result.gasSpentNative, 200n);
});

test("broadcast races the same signed transaction across RPCs and accepts the first matching hash", async () => {
  const h = harness();
  let slowFinished = false;
  let expectedHash;
  const broadcasters = [
    {
      sendRawTransaction: async () => {
        throw new Error("first RPC unavailable");
      },
    },
    { sendRawTransaction: async () => expectedHash },
    {
      sendRawTransaction: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        slowFinished = true;
        return expectedHash;
      },
    },
  ];
  const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const Wallet = createBoundedWallet({
    guard: () => {},
    manifest: h.manifest,
    config,
    operations: () => [],
    publicClient: h.publicClient,
    walletClient: {
      prepareTransactionRequest: async (request) => {
        const { account: ignoredAccount, chain: ignoredChain, ...tx } = request;
        return { ...tx, chainId: 5042, nonce: 8, type: "eip1559" };
      },
    },
    account,
    address: account.address.toLowerCase(),
    limits: { gas: 5000n },
    broadcasters,
  });
  const raced = new Wallet({
    account,
    chainId: 5042n,
    publicClient: h.publicClient,
    walletClient: {},
  });
  await raced.estimateFees(h.call);
  const prepared = await raced.prepareSubmission("race-2", h.call);
  expectedHash = prepared.hash;
  assert.equal((await raced.submitCall("race-2", h.call)).hash, prepared.hash);
  assert.equal(slowFinished, false);
});
