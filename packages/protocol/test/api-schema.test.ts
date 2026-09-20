import { randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  OPENAPI_DOCUMENT,
  UINT64_MAX,
  assertApiSchema,
  compileApiSchema,
} from "../src/index.js";
import type { ApiSchemaName } from "../src/index.js";

const fixtureDirectory = new URL("../../test-fixtures/api/", import.meta.url);
const cliFixtureDirectory = new URL(
  "../../test-fixtures/cli/",
  import.meta.url,
);

interface ApiStory {
  readonly schema: ApiSchemaName;
  readonly signaturesIncluded: boolean;
  readonly value: Record<string, unknown>;
}

async function runtimeSignature(hash: `0x${string}`): Promise<`0x${string}`> {
  const account = privateKeyToAccount(toHex(randomBytes(32)));
  return account.sign({ hash });
}

async function hydrateRuntimeSignatures(story: ApiStory): Promise<unknown> {
  const value = structuredClone(story.value);
  if (story.schema === "ChallengeEnvelope") {
    const data = value.data as Record<string, unknown>;
    data.issuerSignature = await runtimeSignature(`0x${"11".repeat(32)}`);
  }
  if (story.schema === "WorkJobEnvelope") {
    const data = value.data as Record<string, unknown>;
    data.verifierSignature = await runtimeSignature(`0x${"22".repeat(32)}`);
  }
  return value;
}

describe("OpenAPI component schemas", () => {
  it("covers every v1 route and requires idempotency on every POST", () => {
    expect(Object.keys(OPENAPI_DOCUMENT.paths).sort()).toEqual(
      [
        "/v1/arcals/{id}",
        "/v1/arcals/{id}/image.svg",
        "/v1/public/config",
        "/v1/public/status",
        "/v1/public/skill",
        "/v1/auth/nonce",
        "/v1/auth/session",
        "/v1/challenges",
        "/v1/config",
        "/v1/health",
        "/v1/mints/{txHash}",
        "/v1/operations/{operationId}",
        "/v1/operations/{operationId}/transaction",
        "/v1/pi/{id}/proof",
        "/v1/stats",
        "/v1/vault",
        "/v1/vault/items",
        "/v1/wallets/{address}/arcals",
        "/v1/wallets/{address}/activity",
        "/v1/work/jobs/{jobId}",
        "/v1/work/verify",
      ].sort(),
    );
    for (const pathItem of Object.values(OPENAPI_DOCUMENT.paths)) {
      if (!("post" in pathItem)) continue;
      expect(
        pathItem.post.parameters.some(
          (parameter) => parameter.name === "Idempotency-Key",
        ),
      ).toBe(true);
    }
  });

  it("validates every offline API story without storing signatures", async () => {
    const names = (await readdir(fixtureDirectory)).filter((name) =>
      name.endsWith(".json"),
    );
    expect(names).toHaveLength(14);
    for (const name of names) {
      const story = JSON.parse(
        await readFile(new URL(name, fixtureDirectory), "utf8"),
      ) as ApiStory;
      expect(story.signaturesIncluded).toBe(false);
      const serialized = JSON.stringify(story);
      expect(serialized).not.toMatch(/"(?:issuer|verifier)Signature":"0x/u);
      assertApiSchema(story.schema, await hydrateRuntimeSignatures(story));
    }
  });

  it("validates the stable output envelope for every Agent CLI command", async () => {
    const names = (await readdir(cliFixtureDirectory)).filter((name) =>
      name.endsWith(".json"),
    );
    expect(names).toHaveLength(12);
    const commands = new Set<string>();
    for (const name of names) {
      const story = JSON.parse(
        await readFile(new URL(name, cliFixtureDirectory), "utf8"),
      ) as ApiStory;
      expect(story.schema).toBe("CliEnvelope");
      expect(story.signaturesIncluded).toBe(false);
      expect(JSON.stringify(story)).not.toMatch(
        /privateKey|mnemonic|issuerSignature|verifierSignature|rawTransaction/u,
      );
      assertApiSchema("CliEnvelope", story.value);
      commands.add(String(story.value.command));
    }
    expect(commands).toEqual(
      new Set([
        "preflight",
        "wallet.setup",
        "mine.once",
        "authorize",
        "run",
        "status",
        "stop",
        "verify-receipt",
        "content.register",
        "form.liquify",
        "form.reform",
      ]),
    );
  });

  it("rejects unsafe integer, BCD, ID, and extra-property inputs", () => {
    const uint64 = compileApiSchema("Uint64String");
    expect(uint64(UINT64_MAX.toString())).toBe(true);
    expect(uint64((UINT64_MAX + 1n).toString())).toBe(false);
    expect(uint64("01")).toBe(false);

    const arcalId = compileApiSchema("ArcalIdString");
    expect(arcalId("1000000")).toBe(true);
    expect(arcalId("1000001")).toBe(false);

    const packed = compileApiSchema("PackedPiDigits");
    expect(packed(`0x${"12".repeat(180)}`)).toBe(true);
    expect(packed(`0x${"12".repeat(179)}fa`)).toBe(false);

    const challengeRequest = compileApiSchema("ChallengeRequest");
    expect(
      challengeRequest({
        wallet: "0x2000000000000000000000000000000000000002",
        mintNonce: "0",
        protocolVersion: 1,
        recipient: "0x3000000000000000000000000000000000000003",
      }),
    ).toBe(false);
  });

  it("does not accept null as an EOA transaction nonce when the field is present", () => {
    const validate = compileApiSchema("WalletHandle");
    expect(
      validate({
        kind: "transaction",
        chainId: "31337",
        hash: `0x${"33".repeat(32)}`,
        sender: "0x2000000000000000000000000000000000000002",
        transactionNonce: null,
      }),
    ).toBe(false);
  });

  it("keeps protocol ECDSA signatures canonical while allowing bounded ERC-1271 auth bytes", () => {
    const protocolSignature = compileApiSchema("Signature");
    const walletSignature = compileApiSchema("WalletAuthSignature");
    const contractSignature = `0x${"ab".repeat(96)}`;
    expect(protocolSignature(contractSignature)).toBe(false);
    expect(walletSignature(contractSignature)).toBe(true);
    expect(walletSignature("0x")).toBe(false);
    expect(walletSignature(`0x${"ab".repeat(2049)}`)).toBe(false);
  });

  it("reuses compiled validators without leaking results between calls", () => {
    const signature = `0x${"ab".repeat(96)}`;
    const started = performance.now();
    for (let index = 0; index < 2_000; index += 1) {
      assertApiSchema("WalletAuthSignature", signature);
    }
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(() => assertApiSchema("WalletAuthSignature", "0x")).toThrow(
      "WalletAuthSignature schema validation failed",
    );
    expect(() =>
      assertApiSchema("WalletAuthSignature", signature),
    ).not.toThrow();
  });
});
