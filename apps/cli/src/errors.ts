import { PROTOCOL_ERRORS, isProtocolErrorCode } from "@arcals/protocol";
import type { ApiError, ProtocolErrorCode } from "@arcals/protocol";
import { ArcalsApiError } from "@arcals/sdk";

export interface ClassifiedFailure {
  readonly code: ProtocolErrorCode;
  readonly message: string;
  readonly operationId: string | null;
}

const RATE_LIMITED =
  /rate limit|too many requests|request exceeds defined limit|\b429\b|-32005/iu;
const LEDGER_BUSY = /database is locked|SQLITE_BUSY/iu;

function redact(message: string): string {
  return message.replace(/0x[0-9a-fA-F]{130,}/gu, "[REDACTED]");
}

/**
 * Maps any failure to a stable protocol code. Specific causes are preferred
 * over the generic DEPENDENCY_UNAVAILABLE so agents can tell the user what
 * actually happened and whether waiting or retrying helps.
 */
export function classifyFailure(
  error: unknown,
  runtimeError?: {
    readonly code: ProtocolErrorCode;
    readonly operationId: string | null;
  },
): ClassifiedFailure {
  const message =
    error instanceof Error ? error.message : "Agent command failed";
  const prefix = message.split(":", 1)[0] ?? "";
  // An explicit code at the start of the message is authoritative.
  if (isProtocolErrorCode(prefix) && prefix !== "DEPENDENCY_UNAVAILABLE") {
    return {
      code: prefix,
      message: redact(message),
      operationId: runtimeError?.operationId ?? null,
    };
  }
  if (error instanceof ArcalsApiError) {
    const apiCode = error.apiError.code;
    if (apiCode === "DEPENDENCY_UNAVAILABLE" && error.meta?.stale === true) {
      return {
        code: "INDEXER_LAGGING",
        message: error.apiError.message,
        operationId: error.apiError.operationId,
      };
    }
    if (isProtocolErrorCode(apiCode)) {
      return {
        code: apiCode,
        message: error.apiError.message,
        operationId: error.apiError.operationId,
      };
    }
  }
  const operationId = runtimeError?.operationId ?? null;
  if (LEDGER_BUSY.test(message)) {
    return { code: "LOCAL_LEDGER_BUSY", message: redact(message), operationId };
  }
  if (RATE_LIMITED.test(message)) {
    return { code: "RPC_RATE_LIMITED", message: redact(message), operationId };
  }
  return {
    code:
      runtimeError?.code ??
      (isProtocolErrorCode(prefix) ? prefix : "DEPENDENCY_UNAVAILABLE"),
    message: redact(message),
    operationId,
  };
}

export function apiErrorFor(failure: ClassifiedFailure): ApiError {
  const definition = PROTOCOL_ERRORS[failure.code];
  return {
    code: failure.code,
    message: failure.message,
    retryable: definition.retryable,
    retryAfterMs: null,
    action: definition.action,
    operationId: failure.operationId,
    details: null,
  };
}
