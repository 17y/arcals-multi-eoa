import {
  constants,
  openSync,
  fstatSync,
  readFileSync,
  closeSync,
} from "node:fs";
import { parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export function loadSecret(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 256 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error();
    const key = readFileSync(fd, "utf8").trim();
    if (!/^(0x)?[a-fA-F0-9]{64}$/.test(key)) throw new Error();
    return key.startsWith("0x") ? key : `0x${key}`;
  } catch {
    throw new Error(
      "KEY_FILE_INVALID: use an owned regular 0600 file containing only one EVM key",
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export function validateConfig(c) {
  if (!Number.isInteger(c.count) || c.count < 1 || c.count > 10000)
    throw new Error("count must be 1..10000");
  if (!Number.isInteger(c.threads) || c.threads < 1 || c.threads > 64)
    throw new Error("threads must be 1..64");
  if (
    !Number.isInteger(c.sessionMinutes) ||
    c.sessionMinutes < 1 ||
    c.sessionMinutes > 360
  )
    throw new Error("sessionMinutes must be 1..360");
  if (
    c.walletAddress !== undefined &&
    (!/^0x[a-fA-F0-9]{40}$/.test(c.walletAddress) ||
      /^0x0{40}$/i.test(c.walletAddress))
  )
    throw new Error("Invalid optional walletAddress");
  for (const name of ["keyFile", "stateDir"])
    if (typeof c[name] !== "string" || !c[name]) throw new Error(`Set ${name}`);
  for (const name of ["mintBudgetUSDC", "gasBudgetUSDC"]) {
    if (
      typeof c[name] !== "string" ||
      !/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(c[name])
    )
      throw new Error(`${name} must be an exact decimal string`);
  }
  const mint = parseEther(c.mintBudgetUSDC),
    gas = parseEther(c.gasBudgetUSDC);
  if (mint !== BigInt(c.count) * 10n ** 17n)
    throw new Error("mintBudgetUSDC must equal count * 0.1");
  if (gas <= 0n) throw new Error("gasBudgetUSDC must be positive");
  return { mint, gas };
}
// Conservative: charge each operation its signed maximum even after success/failure.
// This bounds auxiliary gas too, and never relies on a possibly missing receipt.
export function reservedGas(operations) {
  return operations.reduce(
    (sum, op) =>
      sum +
      (BigInt(op.gasCommittedNative) > BigInt(op.gasSpentNative)
        ? BigInt(op.gasCommittedNative)
        : BigInt(op.gasSpentNative)),
    0n,
  );
}
export function assertGasBudget(operations, cap) {
  if (reservedGas(operations) > cap)
    throw new Error("TOTAL_GAS_BUDGET_EXCEEDED");
}
export function actionFor(status, count, contentRegistered) {
  if (status.unresolved.length) return { kind: "wait" };
  const mints = status.operations.filter(
    (op) => op.kind === "MINT" && op.state === "MINT_CONFIRMED",
  );
  for (const mint of mints) {
    if (mint.issuedId === null)
      throw new Error("Confirmed Mint has no issuedId");
    if (!contentRegistered.has(mint.issuedId))
      return { kind: "content", id: mint.issuedId };
  }
  return mints.length >= count ? { kind: "complete" } : { kind: "mint" };
}

export function loadWalletAccount(path, expectedAddress) {
  let account;
  try {
    account = privateKeyToAccount(loadSecret(path));
  } catch {
    throw new Error("Cannot load EVM key: check file permissions and format");
  }
  if (
    expectedAddress !== undefined &&
    account.address.toLowerCase() !== expectedAddress.toLowerCase()
  )
    throw new Error("KEY_ADDRESS_MISMATCH");
  return account;
}
