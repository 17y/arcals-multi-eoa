import { describe, expect, it } from "vitest";

import { deriveTargetFromMeasurement } from "../src/target.js";

describe("exact RandomX Target derivation", () => {
  it("uses integer rational arithmetic without floating-point rate loss", () => {
    const result = deriveTargetFromMeasurement(9_600n, 1_000_000_000n, 120n);
    const expected =
      ((1n << 256n) * 1_000_000_000n) / (9_600n * 120n * 1_000_000_000n) - 1n;
    expect(result.target).toBe(expected);
    expect(result.targetHex).toMatch(/^0x[0-9a-f]{64}$/u);
  });

  it("rejects empty or nonsensical measurements", () => {
    expect(() => deriveTargetFromMeasurement(0n, 1n)).toThrow();
    expect(() => deriveTargetFromMeasurement(1n, 0n)).toThrow();
    expect(() => deriveTargetFromMeasurement(1n, 1n, 0n)).toThrow();
  });
});
