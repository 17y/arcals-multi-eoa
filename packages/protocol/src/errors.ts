export const ERROR_ACTIONS = [
  "RETRY_SAME_OPERATION",
  "REAUTHORIZE",
  "WAIT_NEXT_EPOCH",
  "RECOVER_TRANSACTION",
  "FUND_WALLET",
  "CONTACT_SUPPORT",
  "NONE",
] as const;

export type ErrorAction = (typeof ERROR_ACTIONS)[number];

export interface ProtocolErrorDefinition {
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly action: ErrorAction;
}

export const PROTOCOL_ERRORS = {
  WRONG_NETWORK: { httpStatus: 400, retryable: false, action: "REAUTHORIZE" },
  UNTRUSTED_DEPLOYMENT: {
    httpStatus: 409,
    retryable: false,
    action: "CONTACT_SUPPORT",
  },
  WALLET_AUTH_REQUIRED: {
    httpStatus: 401,
    retryable: false,
    action: "REAUTHORIZE",
  },
  WALLET_CAPABILITY_UNAVAILABLE: {
    httpStatus: 409,
    retryable: false,
    action: "NONE",
  },
  IDEMPOTENCY_CONFLICT: { httpStatus: 409, retryable: false, action: "NONE" },
  ACTIVE_OPERATION_EXISTS: {
    httpStatus: 409,
    retryable: true,
    action: "RETRY_SAME_OPERATION",
  },
  MINT_PAUSED: { httpStatus: 409, retryable: true, action: "NONE" },
  SOLD_OUT: { httpStatus: 409, retryable: false, action: "NONE" },
  EPOCH_UNAVAILABLE: {
    httpStatus: 503,
    retryable: true,
    action: "WAIT_NEXT_EPOCH",
  },
  EPOCH_EXPIRED: {
    httpStatus: 409,
    retryable: true,
    action: "WAIT_NEXT_EPOCH",
  },
  CHALLENGE_EXPIRED: {
    httpStatus: 409,
    retryable: true,
    action: "RETRY_SAME_OPERATION",
  },
  CERTIFICATE_EXPIRED: {
    httpStatus: 409,
    retryable: true,
    action: "RECOVER_TRANSACTION",
  },
  INVALID_SIGNATURE: {
    httpStatus: 422,
    retryable: false,
    action: "CONTACT_SUPPORT",
  },
  INVALID_WORK: { httpStatus: 422, retryable: false, action: "NONE" },
  NONCE_CONSUMED: {
    httpStatus: 409,
    retryable: false,
    action: "RECOVER_TRANSACTION",
  },
  RECEIPT_CONSUMED: {
    httpStatus: 409,
    retryable: false,
    action: "RECOVER_TRANSACTION",
  },
  INSUFFICIENT_FUNDS: {
    httpStatus: 409,
    retryable: true,
    action: "FUND_WALLET",
  },
  INSUFFICIENT_ALLOWANCE: {
    httpStatus: 409,
    retryable: true,
    action: "REAUTHORIZE",
  },
  SUBMISSION_UNKNOWN: {
    httpStatus: 202,
    retryable: true,
    action: "RECOVER_TRANSACTION",
  },
  CONTENT_NOT_REGISTERED: {
    httpStatus: 409,
    retryable: true,
    action: "RETRY_SAME_OPERATION",
  },
  INVALID_CONTENT_PROOF: {
    httpStatus: 422,
    retryable: false,
    action: "CONTACT_SUPPORT",
  },
  NOT_NFT_OWNER: { httpStatus: 409, retryable: true, action: "NONE" },
  CONVERSIONS_CLOSED: { httpStatus: 409, retryable: true, action: "NONE" },
  VAULT_EMPTY: {
    httpStatus: 409,
    retryable: true,
    action: "RETRY_SAME_OPERATION",
  },
  HEAD_CHANGED: {
    httpStatus: 409,
    retryable: true,
    action: "RETRY_SAME_OPERATION",
  },
  DEADLINE_EXPIRED: {
    httpStatus: 409,
    retryable: true,
    action: "RETRY_SAME_OPERATION",
  },
  DIRECT_VAULT_TRANSFER_FORBIDDEN: {
    httpStatus: 422,
    retryable: false,
    action: "NONE",
  },
  RESOURCE_NOT_FOUND: {
    httpStatus: 404,
    retryable: false,
    action: "NONE",
  },
  INDEXER_STALE: {
    httpStatus: 503,
    retryable: true,
    action: "RETRY_SAME_OPERATION",
  },
  DEPENDENCY_UNAVAILABLE: {
    httpStatus: 503,
    retryable: true,
    action: "RETRY_SAME_OPERATION",
  },
  // Specific causes that would otherwise surface only as
  // DEPENDENCY_UNAVAILABLE or UNTRUSTED_DEPLOYMENT.
  WALLET_UNDEPLOYED: {
    httpStatus: 409,
    retryable: true,
    action: "RETRY_SAME_OPERATION",
  },
  RPC_RATE_LIMITED: {
    httpStatus: 429,
    retryable: true,
    action: "RETRY_SAME_OPERATION",
  },
  INDEXER_LAGGING: {
    httpStatus: 503,
    retryable: true,
    action: "RETRY_SAME_OPERATION",
  },
  LOCAL_LEDGER_BUSY: {
    httpStatus: 409,
    retryable: true,
    action: "RETRY_SAME_OPERATION",
  },
  WORKER_PLATFORM_UNSUPPORTED: {
    httpStatus: 409,
    retryable: false,
    action: "CONTACT_SUPPORT",
  },
  WORKER_DOWNLOAD_FAILED: {
    httpStatus: 503,
    retryable: true,
    action: "RETRY_SAME_OPERATION",
  },
} as const satisfies Record<string, ProtocolErrorDefinition>;

export type ProtocolErrorCode = keyof typeof PROTOCOL_ERRORS;

export function isProtocolErrorCode(value: string): value is ProtocolErrorCode {
  return Object.hasOwn(PROTOCOL_ERRORS, value);
}
