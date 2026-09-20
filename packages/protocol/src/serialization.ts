import type { ChallengeJson, WorkCertificateJson } from "./api-types.js";
import type { Bytes32, HexAddress } from "./environment.js";
import type { Challenge, WorkCertificate } from "./types.js";

export function challengeToJson(challenge: Challenge): ChallengeJson {
  if (challenge.protocolVersion !== 1) {
    throw new RangeError("Unsupported Challenge protocolVersion");
  }
  return {
    protocolVersion: 1,
    configDigest: challenge.configDigest,
    challengeId: challenge.challengeId,
    epochId: challenge.epochId.toString(),
    minter: challenge.minter,
    mintNonce: challenge.mintNonce.toString(),
    challengeInput: challenge.challengeInput,
    mintFee: challenge.mintFee.toString(),
    validAfter: challenge.validAfter.toString(),
    expiresAt: challenge.expiresAt.toString(),
    signerVersion: challenge.signerVersion.toString(),
  };
}

export function challengeFromJson(challenge: ChallengeJson): Challenge {
  return {
    protocolVersion: challenge.protocolVersion,
    configDigest: challenge.configDigest as Bytes32,
    challengeId: challenge.challengeId as Bytes32,
    epochId: BigInt(challenge.epochId),
    minter: challenge.minter as HexAddress,
    mintNonce: BigInt(challenge.mintNonce),
    challengeInput: challenge.challengeInput as Bytes32,
    mintFee: BigInt(challenge.mintFee),
    validAfter: BigInt(challenge.validAfter),
    expiresAt: BigInt(challenge.expiresAt),
    signerVersion: BigInt(challenge.signerVersion),
  };
}

export function certificateToJson(
  certificate: WorkCertificate,
): WorkCertificateJson {
  if (certificate.protocolVersion !== 1) {
    throw new RangeError("Unsupported WorkCertificate protocolVersion");
  }
  return {
    protocolVersion: 1,
    challengeHash: certificate.challengeHash,
    workNonce: certificate.workNonce.toString(),
    randomxHash: certificate.randomxHash,
    issuedAt: certificate.issuedAt.toString(),
    expiresAt: certificate.expiresAt.toString(),
    signerVersion: certificate.signerVersion.toString(),
  };
}

export function certificateFromJson(
  certificate: WorkCertificateJson,
): WorkCertificate {
  return {
    protocolVersion: certificate.protocolVersion,
    challengeHash: certificate.challengeHash as Bytes32,
    workNonce: BigInt(certificate.workNonce),
    randomxHash: certificate.randomxHash as Bytes32,
    issuedAt: BigInt(certificate.issuedAt),
    expiresAt: BigInt(certificate.expiresAt),
    signerVersion: BigInt(certificate.signerVersion),
  };
}
