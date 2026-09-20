import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";
import {
  concatHex,
  hashTypedData as viemHashTypedData,
  keccak256,
  recoverAddress,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  MINT_FEE_NATIVE,
  RANDOMX_ALGORITHM_ID,
  UNIT,
  assertCanonicalEcdsaSignature,
  buildRandomXInput,
  computeChallengeInput,
  createMintDomain,
  deriveEpochKey,
  hashCanonicalWorkParameters,
  hashChallengeStruct,
  hashChallengeTypedData,
  hashDomain,
  hashWorkCertificateStruct,
  hashWorkCertificateTypedData,
  hashWorkConfig,
  isHashAtOrBelowTarget,
} from "../src/index.js";
import type {
  Bytes32,
  Challenge,
  HexAddress,
  WorkCertificate,
  WorkConfigV1,
} from "../src/index.js";

const controller = "0x1000000000000000000000000000000000000001" as HexAddress;
const minter = "0x2000000000000000000000000000000000000002" as HexAddress;
const chainId = 31_337n;

function vector() {
  const config: WorkConfigV1 = {
    protocolVersion: 1,
    algorithmId: RANDOMX_ALGORITHM_ID,
    parameterDigest: hashCanonicalWorkParameters({ b: 2, a: 1 }),
    epochSeconds: 86_400n,
    keyLeadSeconds: 900n,
    maxChallengeTtl: 1_200n,
    maxCertificateTtl: 300n,
    target: BigInt(`0x0000${"ff".repeat(30)}`),
    effectiveEpoch: 42n,
  };
  const configDigest = hashWorkConfig(config);
  const withoutInput = {
    protocolVersion: 1,
    configDigest,
    challengeId: `0x${"11".repeat(32)}` as Bytes32,
    epochId: 42n,
    minter,
    mintNonce: 7n,
  };
  const challenge: Challenge = {
    ...withoutInput,
    challengeInput: computeChallengeInput(chainId, controller, withoutInput),
    mintFee: MINT_FEE_NATIVE,
    validAfter: 1_700_000_000n,
    expiresAt: 1_700_001_200n,
    signerVersion: 3n,
  };
  const domain = createMintDomain(chainId, controller);
  const certificate: WorkCertificate = {
    protocolVersion: 1,
    challengeHash: hashChallengeStruct(challenge),
    workNonce: 0x0102030405060708n,
    randomxHash: `0x00000abc${"00".repeat(28)}` as Bytes32,
    issuedAt: 1_700_000_100n,
    expiresAt: 1_700_000_400n,
    signerVersion: 3n,
  };
  return { config, domain, challenge, certificate };
}

describe("EIP-712 and work encoding", () => {
  it("canonicalizes work parameters before hashing", () => {
    expect(hashCanonicalWorkParameters({ b: 2, a: 1 })).toBe(
      hashCanonicalWorkParameters({ a: 1, b: 2 }),
    );
  });

  it("changes the Challenge hash when every encoded field changes", () => {
    const { challenge } = vector();
    const baseline = hashChallengeStruct(challenge);
    const mutations: readonly Challenge[] = [
      { ...challenge, configDigest: `0x${"12".repeat(32)}` },
      { ...challenge, challengeId: `0x${"13".repeat(32)}` },
      { ...challenge, epochId: challenge.epochId + 1n },
      { ...challenge, minter: "0x3000000000000000000000000000000000000003" },
      { ...challenge, mintNonce: challenge.mintNonce + 1n },
      { ...challenge, challengeInput: `0x${"14".repeat(32)}` },
      { ...challenge, mintFee: challenge.mintFee + 1n },
      { ...challenge, validAfter: challenge.validAfter + 1n },
      { ...challenge, expiresAt: challenge.expiresAt + 1n },
      { ...challenge, signerVersion: challenge.signerVersion + 1n },
    ];
    for (const mutation of mutations)
      expect(hashChallengeStruct(mutation)).not.toBe(baseline);
    expect(() =>
      hashChallengeStruct({ ...challenge, protocolVersion: 2 }),
    ).toThrow();
  });

  it("changes the Certificate hash when every encoded field changes", () => {
    const { certificate } = vector();
    const baseline = hashWorkCertificateStruct(certificate);
    const mutations: readonly WorkCertificate[] = [
      { ...certificate, challengeHash: `0x${"15".repeat(32)}` },
      { ...certificate, workNonce: certificate.workNonce + 1n },
      { ...certificate, randomxHash: `0x${"16".repeat(32)}` },
      { ...certificate, issuedAt: certificate.issuedAt + 1n },
      { ...certificate, expiresAt: certificate.expiresAt + 1n },
      { ...certificate, signerVersion: certificate.signerVersion + 1n },
    ];
    for (const mutation of mutations) {
      expect(hashWorkCertificateStruct(mutation)).not.toBe(baseline);
    }
    expect(() =>
      hashWorkCertificateStruct({ ...certificate, protocolVersion: 2 }),
    ).toThrow();
  });

  it("binds typed digests to chain and Controller Proxy", () => {
    const { challenge, certificate, domain } = vector();
    const challengeDigest = hashChallengeTypedData(domain, challenge);
    const certificateDigest = hashWorkCertificateTypedData(domain, certificate);
    expect(hashDomain(domain)).not.toBe(
      hashDomain(
        createMintDomain(domain.chainId + 1n, domain.verifyingContract),
      ),
    );
    expect(challengeDigest).not.toBe(
      hashChallengeTypedData(
        createMintDomain(
          domain.chainId,
          "0x4000000000000000000000000000000000000004",
        ),
        challenge,
      ),
    );
    expect(certificateDigest).not.toBe(challengeDigest);
  });

  it("matches viem independent EIP-712 encoding", () => {
    const { challenge, certificate, domain } = vector();
    const viemDomain = {
      name: domain.name,
      version: domain.version,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
    } as const;
    expect(
      viemHashTypedData({
        domain: viemDomain,
        primaryType: "Challenge",
        types: {
          Challenge: [
            { name: "protocolVersion", type: "uint32" },
            { name: "configDigest", type: "bytes32" },
            { name: "challengeId", type: "bytes32" },
            { name: "epochId", type: "uint64" },
            { name: "minter", type: "address" },
            { name: "mintNonce", type: "uint256" },
            { name: "challengeInput", type: "bytes32" },
            { name: "mintFee", type: "uint256" },
            { name: "validAfter", type: "uint64" },
            { name: "expiresAt", type: "uint64" },
            { name: "signerVersion", type: "uint64" },
          ],
        },
        message: challenge,
      }),
    ).toBe(hashChallengeTypedData(domain, challenge));
    expect(
      viemHashTypedData({
        domain: viemDomain,
        primaryType: "WorkCertificate",
        types: {
          WorkCertificate: [
            { name: "protocolVersion", type: "uint32" },
            { name: "challengeHash", type: "bytes32" },
            { name: "workNonce", type: "uint64" },
            { name: "randomxHash", type: "bytes32" },
            { name: "issuedAt", type: "uint64" },
            { name: "expiresAt", type: "uint64" },
            { name: "signerVersion", type: "uint64" },
          ],
        },
        message: certificate,
      }),
    ).toBe(hashWorkCertificateTypedData(domain, certificate));
  });

  it("encodes the RandomX nonce as eight little-endian bytes", () => {
    const { challenge } = vector();
    const input = buildRandomXInput(
      challenge.challengeInput,
      0x0102030405060708n,
    );
    expect(input.length).toBe(2 + 40 * 2);
    expect(input.slice(-16)).toBe("0807060504030201");
  });

  it("treats RandomX output as a big-endian uint256", () => {
    expect(isHashAtOrBelowTarget(`0x${"00".repeat(31)}02`, 2n)).toBe(true);
    expect(isHashAtOrBelowTarget(`0x${"00".repeat(31)}03`, 2n)).toBe(false);
  });

  it("derives Epoch keys from chain, proxy, epoch, anchor height, and hash", () => {
    const baseline = deriveEpochKey(
      chainId,
      controller,
      42n,
      123_456n,
      `0x${"22".repeat(32)}`,
    );
    expect(baseline).not.toBe(
      deriveEpochKey(
        chainId,
        controller,
        42n,
        123_457n,
        `0x${"22".repeat(32)}`,
      ),
    );
  });

  it("accepts runtime low-s signatures and rejects high-s or bad-v forms", async () => {
    const privateKey = toHex(randomBytes(32));
    const account = privateKeyToAccount(privateKey);
    const digest = keccak256(toHex(randomBytes(32)));
    const signature = await account.sign({ hash: digest });
    expect(() => assertCanonicalEcdsaSignature(signature)).not.toThrow();
    await expect(recoverAddress({ hash: digest, signature })).resolves.toBe(
      account.address,
    );

    const r = signature.slice(0, 66) as Bytes32;
    const s = BigInt(`0x${signature.slice(66, 130)}`);
    const curveOrder =
      0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const highS = curveOrder - s;
    const badHighS = concatHex([
      r,
      toHex(highS, { size: 32 }),
      signature.slice(130) as `0x${string}`,
    ]);
    expect(() => assertCanonicalEcdsaSignature(badHighS)).toThrow(/low-s/u);

    const badV = `${signature.slice(0, 130)}1d` as `0x${string}`;
    expect(() => assertCanonicalEcdsaSignature(badV)).toThrow(/v 27 or 28/u);
  });

  it("keeps canonical amount constants outside Number precision", () => {
    expect(MINT_FEE_NATIVE).toBe(100_000_000_000_000_000n);
    expect(UNIT).toBe(360_000_000_000_000_000_000n);
    expect(UNIT).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  });
});
