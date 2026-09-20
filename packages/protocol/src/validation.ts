import {
  EXECUTOR_LAG_MARGIN_SECONDS,
  MINT_FEE_NATIVE,
  PROTOCOL_VERSION,
  UINT64_MAX,
} from "./constants.js";
import type { Challenge, WorkCertificate } from "./types.js";

/**
 * The `issuedAt` a Work Certificate carries, dated back so that a wallet whose
 * node trails the backend's still accepts it. The Verifier writes this value
 * and the Signer recomputes it, so both must derive it here and nowhere else.
 * It never predates the Challenge, which the controller also rejects.
 */
export function certificateIssuedAt(
  verificationStartedAtMs: number,
  challengeValidAfter: bigint,
): bigint {
  const started = BigInt(Math.floor(verificationStartedAtMs / 1000));
  const dated = started - EXECUTOR_LAG_MARGIN_SECONDS;
  return dated < challengeValidAfter ? challengeValidAfter : dated;
}

/**
 * The `validAfter` a Challenge carries, dated back for the same reason. The
 * caller must derive `expiresAt` from this value, not from the head block, so
 * that the Challenge window stays within `maxChallengeTtl`. It never predates
 * the Epoch commitment, which the controller rejects, so the first Challenges
 * of an Epoch are simply dated at its start.
 */
export function challengeValidAfter(
  headBlockTimestamp: bigint,
  epochValidFrom: bigint,
): bigint {
  const dated =
    headBlockTimestamp < EXECUTOR_LAG_MARGIN_SECONDS
      ? 0n
      : headBlockTimestamp - EXECUTOR_LAG_MARGIN_SECONDS;
  return dated < epochValidFrom ? epochValidFrom : dated;
}

export type ValidationCode =
  | "UNSUPPORTED_PROTOCOL_VERSION"
  | "WRONG_MINT_FEE"
  | "CHALLENGE_INPUT_MISMATCH"
  | "CHALLENGE_NOT_ACTIVE"
  | "CHALLENGE_EXPIRED"
  | "CHALLENGE_TTL_EXCEEDED"
  | "CHALLENGE_CROSSES_EPOCH"
  | "CERTIFICATE_BEFORE_CHALLENGE"
  | "CERTIFICATE_FROM_FUTURE"
  | "CERTIFICATE_EXPIRED"
  | "CERTIFICATE_TTL_EXCEEDED"
  | "CERTIFICATE_OUTLIVES_CHALLENGE"
  | "CERTIFICATE_CROSSES_EPOCH"
  | "SIGNER_VERSION_MISMATCH";

export class ProtocolValidationError extends Error {
  constructor(readonly code: ValidationCode) {
    super(code);
    this.name = "ProtocolValidationError";
  }
}

export interface ValidityContext {
  readonly now: bigint;
  readonly epochEnd: bigint;
  readonly maxChallengeTtl: bigint;
  readonly maxCertificateTtl: bigint;
  readonly signerVersion: bigint;
}

function fail(code: ValidationCode): never {
  throw new ProtocolValidationError(code);
}

export function validateChallengeWindow(
  challenge: Challenge,
  context: ValidityContext,
): void {
  if (challenge.protocolVersion !== PROTOCOL_VERSION)
    fail("UNSUPPORTED_PROTOCOL_VERSION");
  if (challenge.mintFee !== MINT_FEE_NATIVE) fail("WRONG_MINT_FEE");
  if (challenge.signerVersion !== context.signerVersion)
    fail("SIGNER_VERSION_MISMATCH");
  if (context.now < challenge.validAfter) fail("CHALLENGE_NOT_ACTIVE");
  if (context.now >= challenge.expiresAt) fail("CHALLENGE_EXPIRED");
  if (challenge.expiresAt - challenge.validAfter > context.maxChallengeTtl) {
    fail("CHALLENGE_TTL_EXCEEDED");
  }
  if (challenge.expiresAt > context.epochEnd) fail("CHALLENGE_CROSSES_EPOCH");
}

export function validateCertificateWindow(
  challenge: Challenge,
  certificate: WorkCertificate,
  context: ValidityContext,
): void {
  if (certificate.protocolVersion !== PROTOCOL_VERSION)
    fail("UNSUPPORTED_PROTOCOL_VERSION");
  if (certificate.signerVersion !== context.signerVersion)
    fail("SIGNER_VERSION_MISMATCH");
  if (certificate.issuedAt < challenge.validAfter)
    fail("CERTIFICATE_BEFORE_CHALLENGE");
  if (certificate.issuedAt > context.now) fail("CERTIFICATE_FROM_FUTURE");
  if (context.now >= certificate.expiresAt) fail("CERTIFICATE_EXPIRED");
  if (
    certificate.expiresAt - certificate.issuedAt >
    context.maxCertificateTtl
  ) {
    fail("CERTIFICATE_TTL_EXCEEDED");
  }
  if (certificate.expiresAt > challenge.expiresAt)
    fail("CERTIFICATE_OUTLIVES_CHALLENGE");
  if (certificate.expiresAt > context.epochEnd)
    fail("CERTIFICATE_CROSSES_EPOCH");
  if (certificate.expiresAt > UINT64_MAX) fail("CERTIFICATE_CROSSES_EPOCH");
}
