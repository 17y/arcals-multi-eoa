import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { arcalArtworkSvg } from "../src/index.js";
import type { Hex } from "viem";

const fixtures = new URL("../../test-fixtures/", import.meta.url);

describe("Arcal artwork reference", () => {
  it("matches the renderer fixtures byte for byte", async () => {
    const sparse = JSON.parse(
      await readFile(new URL("pi/sparse-membership-v1.json", fixtures), "utf8"),
    ) as { vectors: { id: string; packedDigits: Hex }[] };
    for (const { id, packedDigits } of sparse.vectors) {
      expect(arcalArtworkSvg(BigInt(id), packedDigits)).toBe(
        await readFile(new URL(`render/arcal-${id}.svg`, fixtures), "utf8"),
      );
    }
    expect(arcalArtworkSvg(1_000_000n, null)).toBe(
      await readFile(
        new URL("render/unregistered-1000000.svg", fixtures),
        "utf8",
      ),
    );
  });

  it("rejects IDs outside the collection", () => {
    expect(() => arcalArtworkSvg(0n, null)).toThrow(RangeError);
    expect(() => arcalArtworkSvg(1_000_001n, null)).toThrow(RangeError);
  });
});
