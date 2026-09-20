import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  certificateFromJson,
  challengeFromJson,
  compileApiSchema,
  computeChallengeInput,
  computePiRootFromProof,
  createMintDomain,
  deriveEpochKey,
  hashChallengeStruct,
  hashChallengeTypedData,
  hashDomain,
  hashWorkCertificateStruct,
  hashWorkCertificateTypedData,
  hashWorkConfig,
  piContentHash,
  piLeaf,
  verifyPiProof,
} from "../src/index.js";
import type {
  ApiSchemaName,
  Bytes32,
  ChallengeJson,
  HexAddress,
  WorkCertificateJson,
  WorkConfigV1,
} from "../src/index.js";

const fixture = JSON.parse(
  await readFile(
    new URL("../../test-fixtures/golden/protocol-v1.json", import.meta.url),
    "utf8",
  ),
) as any;

describe("committed golden protocol vector", () => {
  it("recomputes every EIP-712 and work commitment", () => {
    const domain = createMintDomain(
      BigInt(fixture.domain.input.chainId),
      fixture.domain.input.verifyingContract as HexAddress,
    );
    const workInput = fixture.workConfig.input;
    const workConfig: WorkConfigV1 = {
      protocolVersion: workInput.protocolVersion,
      algorithmId: workInput.algorithmId,
      parameterDigest: workInput.parameterDigest,
      epochSeconds: BigInt(workInput.epochSeconds),
      keyLeadSeconds: BigInt(workInput.keyLeadSeconds),
      maxChallengeTtl: BigInt(workInput.maxChallengeTtl),
      maxCertificateTtl: BigInt(workInput.maxCertificateTtl),
      target: BigInt(workInput.target),
      effectiveEpoch: BigInt(workInput.effectiveEpoch),
    };
    const challenge = challengeFromJson(
      fixture.challenge.input as ChallengeJson,
    );
    const certificate = certificateFromJson(
      fixture.certificate.input as WorkCertificateJson,
    );

    expect(hashWorkConfig(workConfig)).toBe(fixture.workConfig.configDigest);
    expect(hashDomain(domain)).toBe(fixture.domain.separator);
    expect(
      computeChallengeInput(domain.chainId, domain.verifyingContract, {
        protocolVersion: challenge.protocolVersion,
        configDigest: challenge.configDigest,
        challengeId: challenge.challengeId,
        epochId: challenge.epochId,
        minter: challenge.minter,
        mintNonce: challenge.mintNonce,
      }),
    ).toBe(challenge.challengeInput);
    expect(hashChallengeStruct(challenge)).toBe(
      fixture.challenge.challengeHash,
    );
    expect(hashChallengeTypedData(domain, challenge)).toBe(
      fixture.challenge.typedDataDigest,
    );
    expect(hashWorkCertificateStruct(certificate)).toBe(
      fixture.certificate.certificateHash,
    );
    expect(hashWorkCertificateTypedData(domain, certificate)).toBe(
      fixture.certificate.receiptHash,
    );
    expect(
      deriveEpochKey(
        domain.chainId,
        domain.verifyingContract,
        BigInt(fixture.epoch.epochId),
        BigInt(fixture.epoch.anchorBlockNumber),
        fixture.epoch.anchorBlockHash as Bytes32,
      ),
    ).toBe(fixture.epoch.epochKey);
  });

  it("recomputes first, middle, and final positional Pi vectors", () => {
    for (const key of ["first", "middle", "last"] as const) {
      const vector = fixture.pi[key];
      const id = BigInt(vector.id);
      const contentHash = piContentHash(vector.packedDigits);
      expect(contentHash).toBe(vector.contentHash);
      expect(piLeaf(id, contentHash)).toBe(vector.leaf);
      expect(computePiRootFromProof(id, contentHash, vector.proof)).toBe(
        vector.root,
      );
      expect(
        verifyPiProof(id, vector.packedDigits, vector.proof, vector.root),
      ).toBe(true);
    }
  });

  it("keeps signatures out and commits reusable invalid inputs", () => {
    expect(fixture.signaturesIncluded).toBe(false);
    expect(JSON.stringify(fixture)).not.toMatch(/signature":"0x/iu);
    for (const invalid of fixture.invalidCases as {
      schema: ApiSchemaName;
      value: unknown;
    }[]) {
      expect(compileApiSchema(invalid.schema)(invalid.value)).toBe(false);
    }
  });
});
