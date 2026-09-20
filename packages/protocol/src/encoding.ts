import { canonicalize } from "json-canonicalize";
import {
  bytesToHex,
  concatHex,
  encodeAbiParameters,
  hexToBytes,
  isAddress,
  keccak256,
  parseAbiParameters,
  stringToHex,
} from "viem";
import type { Address, Hex } from "viem";

import {
  CHALLENGE_DOMAIN,
  CHALLENGE_TYPEHASH,
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_TYPEHASH,
  EIP712_DOMAIN_VERSION,
  EPOCH_KEY_DOMAIN,
  PROTOCOL_VERSION,
  UINT32_MAX,
  UINT64_MAX,
  UINT256_MAX,
  WORK_CERTIFICATE_TYPEHASH,
  WORK_CONFIG_TYPEHASH,
} from "./constants.js";
import type { Bytes32, HexAddress } from "./environment.js";
import type {
  Challenge,
  Eip712Domain,
  WorkCertificate,
  WorkConfigV1,
} from "./types.js";

const bytes32Pattern = /^0x[0-9a-fA-F]{64}$/u;
const signaturePattern = /^0x[0-9a-fA-F]{130}$/u;
const secp256k1HalfOrder =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

function assertInteger(value: bigint, maximum: bigint, field: string): void {
  if (value < 0n || value > maximum) {
    throw new RangeError(`${field} is outside its unsigned integer range`);
  }
}

function assertProtocolVersion(value: number): void {
  if (!Number.isInteger(value) || value !== PROTOCOL_VERSION) {
    throw new RangeError(`Unsupported protocolVersion: ${String(value)}`);
  }
}

export function assertBytes32(
  value: string,
  field = "bytes32",
): asserts value is Bytes32 {
  if (!bytes32Pattern.test(value)) {
    throw new TypeError(`${field} must be 0x-prefixed 32-byte hex`);
  }
}

export function assertHexAddress(
  value: string,
  field = "address",
): asserts value is HexAddress {
  if (!isAddress(value, { strict: true })) {
    throw new TypeError(`${field} must be a 20-byte EVM address`);
  }
}

export function createMintDomain(
  chainId: bigint,
  verifyingContract: HexAddress,
): Eip712Domain {
  assertInteger(chainId, UINT256_MAX, "chainId");
  assertHexAddress(verifyingContract, "verifyingContract");
  return {
    name: EIP712_DOMAIN_NAME,
    version: EIP712_DOMAIN_VERSION,
    chainId,
    verifyingContract,
  };
}

export function hashDomain(domain: Eip712Domain): Bytes32 {
  assertInteger(domain.chainId, UINT256_MAX, "domain.chainId");
  assertHexAddress(domain.verifyingContract, "domain.verifyingContract");
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters("bytes32, bytes32, bytes32, uint256, address"),
      [
        EIP712_DOMAIN_TYPEHASH,
        keccak256(stringToHex(domain.name)),
        keccak256(stringToHex(domain.version)),
        domain.chainId,
        domain.verifyingContract as Address,
      ],
    ),
  );
}

export function computeChallengeInput(
  chainId: bigint,
  controllerProxy: HexAddress,
  challenge: Omit<
    Challenge,
    "challengeInput" | "mintFee" | "validAfter" | "expiresAt" | "signerVersion"
  >,
): Bytes32 {
  assertProtocolVersion(challenge.protocolVersion);
  assertInteger(chainId, UINT256_MAX, "chainId");
  assertHexAddress(controllerProxy, "controllerProxy");
  assertBytes32(challenge.challengeId, "challengeId");
  assertInteger(challenge.epochId, UINT64_MAX, "epochId");
  assertHexAddress(challenge.minter, "minter");
  assertInteger(challenge.mintNonce, UINT256_MAX, "mintNonce");
  assertBytes32(challenge.configDigest, "configDigest");

  return keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        "bytes32, uint256, address, bytes32, uint64, address, uint256, bytes32",
      ),
      [
        CHALLENGE_DOMAIN,
        chainId,
        controllerProxy as Address,
        challenge.challengeId,
        challenge.epochId,
        challenge.minter as Address,
        challenge.mintNonce,
        challenge.configDigest,
      ],
    ),
  );
}

function validateChallengeForHash(challenge: Challenge): void {
  assertProtocolVersion(challenge.protocolVersion);
  assertBytes32(challenge.configDigest, "configDigest");
  assertBytes32(challenge.challengeId, "challengeId");
  assertInteger(challenge.epochId, UINT64_MAX, "epochId");
  assertHexAddress(challenge.minter, "minter");
  assertInteger(challenge.mintNonce, UINT256_MAX, "mintNonce");
  assertBytes32(challenge.challengeInput, "challengeInput");
  assertInteger(challenge.mintFee, UINT256_MAX, "mintFee");
  assertInteger(challenge.validAfter, UINT64_MAX, "validAfter");
  assertInteger(challenge.expiresAt, UINT64_MAX, "expiresAt");
  assertInteger(challenge.signerVersion, UINT64_MAX, "signerVersion");
}

export function hashChallengeStruct(challenge: Challenge): Bytes32 {
  validateChallengeForHash(challenge);
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        "bytes32, uint32, bytes32, bytes32, uint64, address, uint256, bytes32, uint256, uint64, uint64, uint64",
      ),
      [
        CHALLENGE_TYPEHASH,
        challenge.protocolVersion,
        challenge.configDigest,
        challenge.challengeId,
        challenge.epochId,
        challenge.minter as Address,
        challenge.mintNonce,
        challenge.challengeInput,
        challenge.mintFee,
        challenge.validAfter,
        challenge.expiresAt,
        challenge.signerVersion,
      ],
    ),
  );
}

function validateCertificateForHash(certificate: WorkCertificate): void {
  assertProtocolVersion(certificate.protocolVersion);
  assertBytes32(certificate.challengeHash, "challengeHash");
  assertInteger(certificate.workNonce, UINT64_MAX, "workNonce");
  assertBytes32(certificate.randomxHash, "randomxHash");
  assertInteger(certificate.issuedAt, UINT64_MAX, "issuedAt");
  assertInteger(certificate.expiresAt, UINT64_MAX, "expiresAt");
  assertInteger(certificate.signerVersion, UINT64_MAX, "signerVersion");
}

export function hashWorkCertificateStruct(
  certificate: WorkCertificate,
): Bytes32 {
  validateCertificateForHash(certificate);
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        "bytes32, uint32, bytes32, uint64, bytes32, uint64, uint64, uint64",
      ),
      [
        WORK_CERTIFICATE_TYPEHASH,
        certificate.protocolVersion,
        certificate.challengeHash,
        certificate.workNonce,
        certificate.randomxHash,
        certificate.issuedAt,
        certificate.expiresAt,
        certificate.signerVersion,
      ],
    ),
  );
}

export function hashTypedData(
  domainSeparator: Bytes32,
  structHash: Bytes32,
): Bytes32 {
  assertBytes32(domainSeparator, "domainSeparator");
  assertBytes32(structHash, "structHash");
  return keccak256(concatHex(["0x1901", domainSeparator, structHash]));
}

export function hashChallengeTypedData(
  domain: Eip712Domain,
  challenge: Challenge,
): Bytes32 {
  return hashTypedData(hashDomain(domain), hashChallengeStruct(challenge));
}

export function hashWorkCertificateTypedData(
  domain: Eip712Domain,
  certificate: WorkCertificate,
): Bytes32 {
  return hashTypedData(
    hashDomain(domain),
    hashWorkCertificateStruct(certificate),
  );
}

export function hashWorkConfig(config: WorkConfigV1): Bytes32 {
  assertProtocolVersion(config.protocolVersion);
  assertBytes32(config.algorithmId, "algorithmId");
  assertBytes32(config.parameterDigest, "parameterDigest");
  for (const [field, value] of [
    ["epochSeconds", config.epochSeconds],
    ["keyLeadSeconds", config.keyLeadSeconds],
    ["maxChallengeTtl", config.maxChallengeTtl],
    ["maxCertificateTtl", config.maxCertificateTtl],
    ["effectiveEpoch", config.effectiveEpoch],
  ] as const) {
    assertInteger(value, UINT64_MAX, field);
  }
  assertInteger(config.target, UINT256_MAX, "target");

  return keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        "bytes32, uint32, bytes32, bytes32, uint64, uint64, uint64, uint64, uint256, uint64",
      ),
      [
        WORK_CONFIG_TYPEHASH,
        config.protocolVersion,
        config.algorithmId,
        config.parameterDigest,
        config.epochSeconds,
        config.keyLeadSeconds,
        config.maxChallengeTtl,
        config.maxCertificateTtl,
        config.target,
        config.effectiveEpoch,
      ],
    ),
  );
}

export function hashCanonicalWorkParameters(value: unknown): Bytes32 {
  const encoded = canonicalize(value);
  if (encoded === undefined) {
    throw new TypeError("Work parameters are not JSON-canonicalizable");
  }
  return keccak256(stringToHex(encoded));
}

export function deriveEpochKey(
  chainId: bigint,
  controllerProxy: HexAddress,
  epochId: bigint,
  anchorBlockNumber: bigint,
  anchorBlockHash: Bytes32,
): Bytes32 {
  assertInteger(chainId, UINT256_MAX, "chainId");
  assertHexAddress(controllerProxy, "controllerProxy");
  assertInteger(epochId, UINT64_MAX, "epochId");
  assertInteger(anchorBlockNumber, UINT64_MAX, "anchorBlockNumber");
  assertBytes32(anchorBlockHash, "anchorBlockHash");
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters("bytes32, uint256, address, uint64, uint64, bytes32"),
      [
        EPOCH_KEY_DOMAIN,
        chainId,
        controllerProxy as Address,
        epochId,
        anchorBlockNumber,
        anchorBlockHash,
      ],
    ),
  );
}

export function buildRandomXInput(
  challengeInput: Bytes32,
  workNonce: bigint,
): Hex {
  assertBytes32(challengeInput, "challengeInput");
  assertInteger(workNonce, UINT64_MAX, "workNonce");
  const input = new Uint8Array(40);
  input.set(hexToBytes(challengeInput), 0);
  new DataView(input.buffer).setBigUint64(32, workNonce, true);
  return bytesToHex(input);
}

export function isHashAtOrBelowTarget(
  randomxHash: Bytes32,
  target: bigint,
): boolean {
  assertBytes32(randomxHash, "randomxHash");
  assertInteger(target, UINT256_MAX, "target");
  return BigInt(randomxHash) <= target;
}

export function assertCanonicalEcdsaSignature(signature: Hex): void {
  if (!signaturePattern.test(signature)) {
    throw new TypeError("signature must be 65 bytes");
  }
  const r = BigInt(`0x${signature.slice(2, 66)}`);
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = Number.parseInt(signature.slice(130, 132), 16);
  if (
    r === 0n ||
    s === 0n ||
    s > secp256k1HalfOrder ||
    (v !== 27 && v !== 28)
  ) {
    throw new TypeError(
      "signature must have non-zero r/s, low-s, and v 27 or 28",
    );
  }
}
