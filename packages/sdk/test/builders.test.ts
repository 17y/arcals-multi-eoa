import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { decodeFunctionData, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  arclBaseAbi,
  arcalMirrorAbi,
  arcalsVaultAbi,
  mintControllerAbi,
  revenueTreasuryAbi,
} from "@arcals/contract-bindings";
import { certificateFromJson, challengeFromJson } from "@arcals/protocol";

import {
  buildActivateConversionsCall,
  buildArclApprovalCall,
  buildEncodedMintCall,
  buildLiquifyCall,
  buildMintCall,
  buildNftApprovalCall,
  buildReformCall,
  buildRegisterContentCall,
  buildTreasuryWithdrawCall,
  ArcalsWorkApiClient,
  environmentId,
  isReadModelFresh,
  isHardCapability,
  unsupportedCapabilities,
} from "../src/index.js";

const fixture = JSON.parse(
  await readFile(
    new URL("../../test-fixtures/golden/protocol-v1.json", import.meta.url),
    "utf8",
  ),
);
const controller = "0x1000000000000000000000000000000000000001";
const mirror = "0x1000000000000000000000000000000000000003";
const vault = "0x1000000000000000000000000000000000000004";
const recipient = "0x2000000000000000000000000000000000000002";

async function signature(hashByte: number) {
  const account = privateKeyToAccount(toHex(randomBytes(32)));
  return account.sign({ hash: toHex(new Uint8Array(32).fill(hashByte)) });
}

describe("wallet-independent transaction builders", () => {
  it("authenticates the wallet-private operation read", async () => {
    const originalFetch = globalThis.fetch;
    let authorization: string | undefined;
    globalThis.fetch = async (_input, init) => {
      authorization = (init?.headers as Record<string, string> | undefined)
        ?.authorization;
      return new Response(
        JSON.stringify({
          ok: true,
          schemaVersion: "1",
          requestId: "00000000-0000-4000-8000-000000000001",
          data: {
            operationId: "00000000-0000-4000-8000-000000000002",
            state: "CERTIFICATE_READY",
            walletHandle: null,
            stopRequested: false,
            updatedAt: "2026-09-12T00:00:00.000Z",
          },
          error: null,
          meta: {
            environmentId: `31337:${controller}`,
            asOf: "2026-09-12T00:00:00.000Z",
            indexedBlock: null,
            indexedBlockHash: null,
            chainTip: null,
            stale: true,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    try {
      const client = new ArcalsWorkApiClient("https://api.arcals.invalid");
      client.setBearerToken("test-session-token");
      await expect(
        client.getOperation("00000000-0000-4000-8000-000000000002"),
      ).resolves.toMatchObject({ state: "CERTIFICATE_READY" });
      expect(authorization).toBe("Bearer test-session-token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not confuse CLI counters with wallet/account policy evidence", () => {
    const capabilities = unsupportedCapabilities();
    capabilities.mintCountLimit = {
      supported: true,
      enforcement: "cli",
      evidenceRef: "local-ledger",
    };
    expect(isHardCapability(capabilities.mintCountLimit)).toBe(false);
    capabilities.mintCountLimit = {
      supported: true,
      enforcement: "account",
      evidenceRef: null,
    };
    expect(isHardCapability(capabilities.mintCountLimit)).toBe(false);
    capabilities.mintCountLimit = {
      supported: true,
      enforcement: "account",
      evidenceRef: "wallet-policy:runtime-proof",
    };
    expect(isHardCapability(capabilities.mintCountLimit)).toBe(true);
  });

  it("builds Mint only for the fixed fee and has no separate recipient", async () => {
    const challenge = challengeFromJson(fixture.challenge.input);
    const certificate = certificateFromJson(fixture.certificate.input);
    const issuerSignature = await signature(1);
    const verifierSignature = await signature(2);
    const call = buildMintCall(
      31_337n,
      controller,
      challenge,
      issuerSignature,
      certificate,
      verifierSignature,
    );
    expect(call.valueNative).toBe(100_000_000_000_000_000n);
    const decoded = decodeFunctionData({
      abi: mintControllerAbi,
      data: call.data,
    });
    expect(decoded.functionName).toBe("mint");
    expect(decoded.args).toHaveLength(4);
    const encodedCall = buildEncodedMintCall(call);
    const encoded = decodeFunctionData({
      abi: mintControllerAbi,
      data: encodedCall.data,
    });
    expect(encoded.functionName).toBe("mintEncoded");
    expect(encoded.args).toEqual([`0x${call.data.slice(10)}`]);
    expect(encodedCall.valueNative).toBe(call.valueNative);
    expect(encodedCall.to).toBe(call.to);
    expect(() =>
      buildMintCall(
        31_337n,
        controller,
        { ...challenge, mintFee: challenge.mintFee + 1n },
        issuerSignature,
        certificate,
        verifierSignature,
      ),
    ).toThrow(/fixed protocol fee/u);
  });

  it("builds content, liquify, and FIFO-head-protected reform calls", () => {
    const content = buildRegisterContentCall(
      31_337n,
      mirror,
      1n,
      fixture.pi.first.packedDigits,
      fixture.pi.first.proof,
    );
    expect(
      decodeFunctionData({ abi: arcalMirrorAbi, data: content.data })
        .functionName,
    ).toBe("registerContent");

    const liquify = buildLiquifyCall(
      31_337n,
      vault,
      1n,
      recipient,
      1_800_000_000n,
    );
    expect(
      decodeFunctionData({ abi: arcalsVaultAbi, data: liquify.data })
        .functionName,
    ).toBe("liquify");
    const reform = buildReformCall(
      31_337n,
      vault,
      recipient,
      7n,
      1_800_000_000n,
    );
    const decoded = decodeFunctionData({
      abi: arcalsVaultAbi,
      data: reform.data,
    });
    expect(decoded.functionName).toBe("reform");
    expect(decoded.args?.[1]).toBe(7n);
  });

  it("binds environment identity and refuses stale or future read projections", () => {
    expect(environmentId(31_337n, controller)).toBe(`31337:${controller}`);
    const baseMeta = {
      environmentId: `31337:${controller}`,
      asOf: "2026-09-11T00:00:00Z",
      indexedBlock: "99",
      indexedBlockHash: `0x${"11".repeat(32)}`,
      chainTip: "100",
      stale: false,
    } as const;
    expect(isReadModelFresh(baseMeta, 1n)).toBe(true);
    expect(isReadModelFresh({ ...baseMeta, stale: true }, 1n)).toBe(false);
    expect(isReadModelFresh({ ...baseMeta, indexedBlock: "101" }, 1n)).toBe(
      false,
    );
  });

  it("builds explicit approvals, activation, and revenue withdrawal", () => {
    const nftApproval = buildNftApprovalCall(31_337n, mirror, vault, 1n);
    expect(
      decodeFunctionData({ abi: arcalMirrorAbi, data: nftApproval.data })
        .functionName,
    ).toBe("approve");

    const arclApproval = buildArclApprovalCall(
      31_337n,
      "0x1000000000000000000000000000000000000002",
      vault,
      720_000_000_000_000_000_000n,
    );
    const decodedApproval = decodeFunctionData({
      abi: arclBaseAbi,
      data: arclApproval.data,
    });
    expect(decodedApproval.functionName).toBe("approve");
    expect(decodedApproval.args?.[1]).toBe(720_000_000_000_000_000_000n);
    expect(() =>
      buildArclApprovalCall(
        31_337n,
        "0x1000000000000000000000000000000000000002",
        vault,
        1n,
      ),
    ).toThrow(/at least one UNIT/u);

    expect(
      decodeFunctionData({
        abi: arcalsVaultAbi,
        data: buildActivateConversionsCall(31_337n, vault).data,
      }).functionName,
    ).toBe("activateConversions");
    expect(
      decodeFunctionData({
        abi: revenueTreasuryAbi,
        data: buildTreasuryWithdrawCall(
          31_337n,
          "0x1000000000000000000000000000000000000006",
          recipient,
          100_000_000_000_000_000n,
        ).data,
      }).functionName,
    ).toBe("withdraw");
  });
});
