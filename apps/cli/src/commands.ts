import { assertBytes32 } from "@arcals/protocol";

import { AgentRuntime } from "./agent.js";
import type { CliEnvelope } from "./types.js";

const BOOLEAN_FLAGS = new Set([
  "--json",
  "--once",
  "--confirm",
  "--with-content",
  "--session",
  "--detach",
]);

export interface ParsedArguments {
  readonly positionals: readonly string[];
  readonly values: Readonly<Record<string, string>>;
  readonly flags: ReadonlySet<string>;
}

export function parseArguments(args: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (/private[-_]?key|mnemonic|seed|otp/iu.test(token)) {
      throw new Error(
        "Wallet secrets are never accepted as Arcals CLI arguments",
      );
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    if (BOOLEAN_FLAGS.has(token)) {
      flags.add(token);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${token} requires a value`);
    }
    values[token] = value;
    index += 1;
  }
  return { positionals, values, flags };
}

function required(parsed: ParsedArguments, name: string): string {
  const value = parsed.values[name];
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return parsed;
}

function unsigned(value: string, name: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new RangeError(`${name} must be an unsigned decimal integer`);
  }
  return BigInt(value);
}

export async function executeParsedCommand(
  runtime: AgentRuntime,
  parsed: ParsedArguments,
): Promise<CliEnvelope> {
  const command = parsed.positionals.join(" ");
  const threads = positiveInteger(
    parsed.values["--threads"] ?? "4",
    "--threads",
  );
  if (command === "preflight") return runtime.preflight();
  if (command === "wallet setup") return runtime.walletSetup();
  if (command === "mine" && parsed.flags.has("--once")) {
    return runtime.mineOnce({
      confirmed: parsed.flags.has("--confirm"),
      unattended: false,
      threads,
      registerContent: parsed.flags.has("--with-content"),
    });
  }
  if (command === "authorize") {
    const expiresAt = new Date(required(parsed, "--until"));
    if (Number.isNaN(expiresAt.getTime()))
      throw new RangeError("--until must be RFC3339");
    return runtime.authorize({
      maxMints: positiveInteger(required(parsed, "--max-mints"), "--max-mints"),
      maxFeeNative: unsigned(
        required(parsed, "--mint-budget"),
        "--mint-budget",
      ),
      maxGasNative: unsigned(required(parsed, "--gas-budget"), "--gas-budget"),
      expiresAt,
      // Without --session the wallet must enforce every boundary itself.
      enforcement: parsed.flags.has("--session") ? "session" : "wallet",
    });
  }
  if (command === "run") return runtime.run({ threads });
  if (command === "status") return runtime.status();
  if (command === "stop") return runtime.stop();
  if (command === "verify-receipt") {
    const transactionHash = required(parsed, "--tx");
    assertBytes32(transactionHash, "--tx");
    return runtime.verifyReceipt(transactionHash);
  }
  if (command === "content register") {
    return runtime.registerContent(
      unsigned(required(parsed, "--id"), "--id"),
      parsed.flags.has("--confirm"),
    );
  }
  const deadline = unsigned(
    parsed.values["--deadline"] ?? String(Math.floor(Date.now() / 1000) + 600),
    "--deadline",
  );
  if (command === "form liquify") {
    return runtime.liquify(
      unsigned(required(parsed, "--id"), "--id"),
      deadline,
      parsed.flags.has("--confirm"),
    );
  }
  if (command === "form reform") {
    return runtime.reform(
      unsigned(parsed.values["--expected-head"] ?? "0", "--expected-head"),
      deadline,
      parsed.flags.has("--confirm"),
    );
  }
  throw new Error(
    "unknown command; expected preflight, wallet setup, mine --once, authorize [--session], run, status, stop, verify-receipt, content register, form liquify, or form reform",
  );
}

export function renderHuman(envelope: CliEnvelope): string {
  const marker = envelope.ok ? "OK" : "ERROR";
  const detail = envelope.error?.message ?? envelope.state;
  const tx = envelope.txHash === null ? "" : ` tx=${envelope.txHash}`;
  const operation =
    envelope.operationId === null ? "" : ` operation=${envelope.operationId}`;
  return `[${marker}] ${envelope.command}: ${detail}${operation}${tx}\n`;
}
