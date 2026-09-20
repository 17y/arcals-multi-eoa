import { UINT256_MAX } from "@arcals/protocol";

const TWO_TO_256 = 1n << 256n;
const NANOSECONDS_PER_SECOND = 1_000_000_000n;

export interface TargetDerivation {
  readonly hashes: bigint;
  readonly elapsedNanoseconds: bigint;
  readonly desiredSeconds: bigint;
  readonly target: bigint;
  readonly targetHex: `0x${string}`;
  readonly expectedHashesNumerator: bigint;
  readonly expectedHashesDenominator: bigint;
}

export function deriveTargetFromMeasurement(
  hashes: bigint,
  elapsedNanoseconds: bigint,
  desiredSeconds = 120n,
): TargetDerivation {
  if (hashes <= 0n) throw new RangeError("hashes must be positive");
  if (elapsedNanoseconds <= 0n) {
    throw new RangeError("elapsedNanoseconds must be positive");
  }
  if (desiredSeconds <= 0n) {
    throw new RangeError("desiredSeconds must be positive");
  }
  const expectedHashesNumerator =
    hashes * desiredSeconds * NANOSECONDS_PER_SECOND;
  const expectedHashesDenominator = elapsedNanoseconds;
  const quotient =
    (TWO_TO_256 * expectedHashesDenominator) / expectedHashesNumerator;
  if (quotient === 0n)
    throw new RangeError("measured rate produces zero Target");
  const target = quotient - 1n;
  if (target > UINT256_MAX)
    throw new RangeError("derived Target exceeds uint256");
  return {
    hashes,
    elapsedNanoseconds,
    desiredSeconds,
    target,
    targetHex: `0x${target.toString(16).padStart(64, "0")}`,
    expectedHashesNumerator,
    expectedHashesDenominator,
  };
}
