import { describe, expect, it } from "vitest";
import { keccak256, stringToHex } from "viem";

import {
  computePiRootFromProof,
  packPiDigits,
  piContentHash,
  piEmptyLeaf,
  piLeaf,
  piNode,
  piRange,
  unpackPiDigits,
  validatePackedPiDigits,
  verifyPiProof,
} from "../src/index.js";
import type { Bytes32 } from "../src/index.js";

const leadingZeroDigits = "0012345678".repeat(36);
const proof = Array.from({ length: 20 }, (_, level) =>
  keccak256(stringToHex(`ARCALS_PI_TEST:${String(level)}`)),
) as Bytes32[];

describe("Pi BCD and positional proof", () => {
  it("round-trips exactly 360 digits including leading zeroes", () => {
    const packed = packPiDigits(leadingZeroDigits);
    expect(packed.length).toBe(2 + 180 * 2);
    expect(packed.startsWith("0x0012345678")).toBe(true);
    expect(unpackPiDigits(packed)).toBe(leadingZeroDigits);
  });

  it("rejects wrong lengths, non-digits, and invalid BCD nibbles", () => {
    expect(() => packPiDigits("1".repeat(359))).toThrow();
    expect(() => packPiDigits(`${"1".repeat(359)}x`)).toThrow();
    expect(validatePackedPiDigits(`0x${"12".repeat(179)}fa`)).toBe(false);
  });

  it("uses fixed one-based ranges at the first, middle, and final IDs", () => {
    expect(piRange(1n)).toEqual({ startDigit: 1n, endDigit: 360n });
    expect(piRange(500_000n)).toEqual({
      startDigit: 179_999_641n,
      endDigit: 180_000_000n,
    });
    expect(piRange(1_000_000n)).toEqual({
      startDigit: 359_999_641n,
      endDigit: 360_000_000n,
    });
  });

  it("binds a leaf to its ID and preserves left/right proof direction", () => {
    const packed = packPiDigits(leadingZeroDigits);
    const contentHash = piContentHash(packed);
    expect(piLeaf(1n, contentHash)).not.toBe(piLeaf(2n, contentHash));

    const root = computePiRootFromProof(500_000n, contentHash, proof);
    expect(verifyPiProof(500_000n, packed, proof, root)).toBe(true);
    const swapped = [...proof];
    [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
    expect(verifyPiProof(500_000n, packed, swapped, root)).toBe(false);
  });

  it("uses domain-separated real, empty, and internal nodes", () => {
    const packed = packPiDigits(leadingZeroDigits);
    const contentHash = piContentHash(packed);
    const real = piLeaf(1n, contentHash);
    const empty = piEmptyLeaf(1_000_000);
    expect(real).not.toBe(empty);
    expect(piNode(real, empty)).not.toBe(piNode(empty, real));
    expect(() => piEmptyLeaf(999_999)).toThrow();
    expect(() => piEmptyLeaf(1_048_576)).toThrow();
  });

  it("requires exactly twenty proof siblings", () => {
    const packed = packPiDigits(leadingZeroDigits);
    expect(() =>
      computePiRootFromProof(1n, piContentHash(packed), proof.slice(1)),
    ).toThrow(/20/u);
  });

  it("verifies the four sequential local-loop records against one root", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL("../../test-fixtures/pi/local-loop-v1.json", import.meta.url),
        "utf8",
      ),
    ) as {
      mode: string;
      productionRoot: boolean;
      root: Bytes32;
      vectors: {
        id: string;
        packedDigits: `0x${string}`;
        proof: Bytes32[];
      }[];
    };
    expect(fixture.mode).toBe("local-fixture");
    expect(fixture.productionRoot).toBe(false);
    expect(fixture.vectors.map(({ id }) => id)).toEqual(["1", "2", "3", "4"]);
    for (const vector of fixture.vectors) {
      expect(
        verifyPiProof(
          BigInt(vector.id),
          vector.packedDigits,
          vector.proof,
          fixture.root,
        ),
      ).toBe(true);
    }
  });
});
import { readFile } from "node:fs/promises";
