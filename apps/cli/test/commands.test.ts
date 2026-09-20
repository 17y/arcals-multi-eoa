import { describe, expect, it, vi } from "vitest";

import type { CliEnvelope } from "@arcals/protocol";

import { executeParsedCommand, parseArguments } from "../src/commands.js";
import type { AgentRuntime } from "../src/agent.js";

const envelope = (command: CliEnvelope["command"]): CliEnvelope => ({
  ok: true,
  schemaVersion: "1",
  command,
  state: "READY",
  operationId: null,
  chainId: "31337",
  wallet: "0x2000000000000000000000000000000000000002",
  txHash: null,
  data: {},
  error: null,
  asOf: "2026-09-12T00:00:00Z",
});

describe("stable CLI command parser", () => {
  it("routes every frozen command without accepting secret arguments", async () => {
    const runtime = {
      preflight: vi.fn(async () => envelope("preflight")),
      walletSetup: vi.fn(async () => envelope("wallet.setup")),
      mineOnce: vi.fn(async () => envelope("mine.once")),
      authorize: vi.fn(async () => envelope("authorize")),
      run: vi.fn(async () => envelope("run")),
      status: vi.fn(async () => envelope("status")),
      stop: vi.fn(async () => envelope("stop")),
      verifyReceipt: vi.fn(async () => envelope("verify-receipt")),
      registerContent: vi.fn(async () => envelope("content.register")),
      liquify: vi.fn(async () => envelope("form.liquify")),
      reform: vi.fn(async () => envelope("form.reform")),
    } as unknown as AgentRuntime;
    const commands: readonly [readonly string[], CliEnvelope["command"]][] = [
      [["preflight"], "preflight"],
      [["wallet", "setup"], "wallet.setup"],
      [["mine", "--once", "--confirm"], "mine.once"],
      [
        [
          "authorize",
          "--max-mints",
          "2",
          "--mint-budget",
          "200000000000000000",
          "--gas-budget",
          "1000",
          "--until",
          "2030-01-01T00:00:00Z",
        ],
        "authorize",
      ],
      [["run"], "run"],
      [["status"], "status"],
      [["stop"], "stop"],
      [["verify-receipt", "--tx", `0x${"11".repeat(32)}`], "verify-receipt"],
      [["content", "register", "--id", "1"], "content.register"],
      [["form", "liquify", "--id", "1"], "form.liquify"],
      [["form", "reform", "--expected-head", "1"], "form.reform"],
    ];
    for (const [arguments_, expected] of commands) {
      await expect(
        executeParsedCommand(runtime, parseArguments(arguments_)),
      ).resolves.toMatchObject({ command: expected });
    }
    expect(() =>
      parseArguments(["wallet", "setup", "--private-key", "0xsecret"]),
    ).toThrow(/never accepted/u);
    expect(() => parseArguments(["--otp", "123456", "status"])).toThrow(
      /never accepted/u,
    );
  });
});
