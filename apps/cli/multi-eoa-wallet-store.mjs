import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const SCHEMA_VERSION = "1";

function assertPrivateDirectory(path) {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error(
      "WALLET_STORE_INSECURE: wallet store must be a private 0700 directory",
    );
  }
  if (process.getuid && stat.uid !== process.getuid()) {
    throw new Error(
      "WALLET_STORE_INSECURE: wallet store must be owned by the current user",
    );
  }
}

function writeSecret(path, value) {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, `${value}\n`, { encoding: "utf8" });
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
}

export function createWalletStore(
  path,
  count,
  keyFactory = generatePrivateKey,
) {
  const destination = resolve(path);
  if (existsSync(destination))
    throw new Error(
      "WALLET_STORE_EXISTS: refusing to overwrite existing wallets",
    );
  if (!Number.isInteger(count) || count < 1 || count > 12)
    throw new Error("wallet count must be 1..12");
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = join(
    dirname(destination),
    `.${basename(destination)}.${process.pid}.${Date.now()}.tmp`,
  );
  mkdirSync(temporary, { mode: 0o700 });
  try {
    const wallets = [];
    const seen = new Set();
    for (let index = 1; index <= count; index += 1) {
      const privateKey = keyFactory();
      const account = privateKeyToAccount(privateKey);
      const address = account.address.toLowerCase();
      if (seen.has(address)) throw new Error("Generated duplicate EOA address");
      seen.add(address);
      const keyFile = `wallet-${String(index).padStart(2, "0")}.key`;
      writeSecret(join(temporary, keyFile), privateKey);
      wallets.push({ index, address, keyFile });
    }
    const indexPath = join(temporary, "wallets.json");
    writeSecret(
      indexPath,
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, wallets }, null, 2),
    );
    renameSync(temporary, destination);
    assertPrivateDirectory(destination);
    return { schemaVersion: SCHEMA_VERSION, wallets };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

export function loadWalletStore(path, expectedCount) {
  const directory = resolve(path);
  assertPrivateDirectory(directory);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(directory, "wallets.json"), "utf8"));
  } catch {
    throw new Error("WALLET_STORE_INVALID: cannot read wallets.json");
  }
  if (
    parsed?.schemaVersion !== SCHEMA_VERSION ||
    !Array.isArray(parsed.wallets)
  ) {
    throw new Error("WALLET_STORE_INVALID: unsupported wallet store");
  }
  if (expectedCount !== undefined && parsed.wallets.length !== expectedCount) {
    throw new Error("WALLET_STORE_COUNT_MISMATCH");
  }
  const seen = new Set();
  const wallets = parsed.wallets.map((wallet, offset) => {
    if (
      wallet?.index !== offset + 1 ||
      typeof wallet.address !== "string" ||
      !/^0x[a-f0-9]{40}$/.test(wallet.address) ||
      typeof wallet.keyFile !== "string" ||
      !/^wallet-\d{2}\.key$/.test(wallet.keyFile)
    ) {
      throw new Error("WALLET_STORE_INVALID: malformed wallet entry");
    }
    const keyPath = join(directory, wallet.keyFile);
    const stat = lstatSync(keyPath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    ) {
      throw new Error("WALLET_STORE_INSECURE: key must be a regular 0600 file");
    }
    const account = privateKeyToAccount(readFileSync(keyPath, "utf8").trim());
    if (
      account.address.toLowerCase() !== wallet.address ||
      seen.has(wallet.address)
    ) {
      throw new Error(
        "WALLET_STORE_INVALID: key/address mismatch or duplicate",
      );
    }
    seen.add(wallet.address);
    return { ...wallet, keyPath };
  });
  return { schemaVersion: SCHEMA_VERSION, wallets };
}
