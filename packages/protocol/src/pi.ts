import {
  bytesToHex,
  concatHex,
  hexToBytes,
  keccak256,
  numberToHex,
} from "viem";
import type { Hex } from "viem";

import {
  MAX_ARCALS,
  PACKED_PI_BYTES,
  PI_DIGITS_PER_ARCAL,
  PI_TREE_HEIGHT,
  PI_TREE_LEAF_COUNT,
} from "./constants.js";
import { assertBytes32 } from "./encoding.js";
import type { Bytes32 } from "./environment.js";

function assertUint32(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${field} must fit uint32`);
  }
}

export function assertArcalId(id: bigint): void {
  if (id < 1n || id > MAX_ARCALS) {
    throw new RangeError(
      `arcalId must be between 1 and ${MAX_ARCALS.toString()}`,
    );
  }
}

export function piRange(id: bigint): {
  readonly startDigit: bigint;
  readonly endDigit: bigint;
} {
  assertArcalId(id);
  const digits = BigInt(PI_DIGITS_PER_ARCAL);
  return {
    startDigit: (id - 1n) * digits + 1n,
    endDigit: id * digits,
  };
}

export function packPiDigits(digits: string): Hex {
  if (digits.length !== PI_DIGITS_PER_ARCAL || !/^\d{360}$/u.test(digits)) {
    throw new TypeError(
      `Pi content must contain exactly ${PI_DIGITS_PER_ARCAL} decimal digits`,
    );
  }
  const packed = new Uint8Array(PACKED_PI_BYTES);
  for (let index = 0; index < PACKED_PI_BYTES; index += 1) {
    const high = Number(digits[index * 2]);
    const low = Number(digits[index * 2 + 1]);
    packed[index] = (high << 4) | low;
  }
  return bytesToHex(packed);
}

export function validatePackedPiDigits(packedDigits: Hex): boolean {
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(packedDigits);
  } catch {
    return false;
  }
  if (bytes.length !== PACKED_PI_BYTES) {
    return false;
  }
  return bytes.every((byte) => byte >> 4 <= 9 && (byte & 0x0f) <= 9);
}

export function unpackPiDigits(packedDigits: Hex): string {
  if (!validatePackedPiDigits(packedDigits)) {
    throw new TypeError(
      "Packed Pi content must be 180 BCD bytes with nibbles 0 through 9",
    );
  }
  return [...hexToBytes(packedDigits)]
    .map((byte) => `${String(byte >> 4)}${String(byte & 0x0f)}`)
    .join("");
}

export function piContentHash(packedDigits: Hex): Bytes32 {
  if (!validatePackedPiDigits(packedDigits)) {
    throw new TypeError("Cannot hash invalid packed Pi content");
  }
  return keccak256(packedDigits);
}

export function piLeaf(id: bigint, contentHash: Bytes32): Bytes32 {
  assertArcalId(id);
  assertBytes32(contentHash, "contentHash");
  return keccak256(
    concatHex(["0x00", numberToHex(id, { size: 4 }), contentHash]),
  );
}

export function piEmptyLeaf(index: number): Bytes32 {
  assertUint32(index, "empty leaf index");
  if (index < Number(MAX_ARCALS) || index >= PI_TREE_LEAF_COUNT) {
    throw new RangeError("Empty leaf index must be in the fixed padding range");
  }
  return keccak256(concatHex(["0x02", numberToHex(index, { size: 4 })]));
}

export function piNode(left: Bytes32, right: Bytes32): Bytes32 {
  assertBytes32(left, "left");
  assertBytes32(right, "right");
  return keccak256(concatHex(["0x01", left, right]));
}

export function computePiRootFromProof(
  id: bigint,
  contentHash: Bytes32,
  proof: readonly Bytes32[],
): Bytes32 {
  assertArcalId(id);
  if (proof.length !== PI_TREE_HEIGHT) {
    throw new RangeError(
      `Pi proof must contain exactly ${PI_TREE_HEIGHT} siblings`,
    );
  }
  let current = piLeaf(id, contentHash);
  let index = Number(id - 1n);
  for (const sibling of proof) {
    assertBytes32(sibling, "proof sibling");
    current =
      (index & 1) === 0 ? piNode(current, sibling) : piNode(sibling, current);
    index >>= 1;
  }
  return current;
}

export function verifyPiProof(
  id: bigint,
  packedDigits: Hex,
  proof: readonly Bytes32[],
  expectedRoot: Bytes32,
): boolean {
  assertBytes32(expectedRoot, "expectedRoot");
  if (!validatePackedPiDigits(packedDigits)) {
    return false;
  }
  return (
    computePiRootFromProof(id, piContentHash(packedDigits), proof) ===
    expectedRoot
  );
}
