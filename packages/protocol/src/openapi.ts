import { API_SCHEMAS } from "./schemas.js";

const schemaRef = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const jsonContent = (schemaName: string) => ({
  "application/json": { schema: schemaRef(schemaName) },
});
const requestBody = (schemaName: string) => ({
  required: true,
  content: jsonContent(schemaName),
});
const response = (description: string, schemaName: string) => ({
  description,
  content: jsonContent(schemaName),
});
const defaultError = response("Structured Arcals error", "ErrorEnvelope");
const idempotencyHeader = {
  name: "Idempotency-Key",
  in: "header",
  required: true,
  schema: { type: "string", minLength: 16, maxLength: 128 },
};
const pathParameter = (name: string, schemaName: string) => ({
  name,
  in: "path",
  required: true,
  schema: schemaRef(schemaName),
});

export const OPENAPI_DOCUMENT = {
  openapi: "3.1.0",
  info: {
    title: "Arcals API",
    version: "0.2.0",
    description:
      "Versioned Challenge, work, recovery, content, Vault, and read-model API. Chain events remain authoritative.",
  },
  servers: [{ url: "/", description: "Environment-bound server" }],
  tags: [
    { name: "Auth" },
    { name: "Work" },
    { name: "Operations" },
    { name: "Read" },
    { name: "Content" },
    { name: "System" },
  ],
  paths: {
    "/v1/auth/nonce": {
      post: {
        tags: ["Auth"],
        operationId: "createAuthNonce",
        parameters: [idempotencyHeader],
        requestBody: requestBody("AuthNonceRequest"),
        responses: {
          "200": response("Authentication nonce", "AuthNonceEnvelope"),
          default: defaultError,
        },
      },
    },
    "/v1/auth/session": {
      post: {
        tags: ["Auth"],
        operationId: "createAuthSession",
        parameters: [idempotencyHeader],
        requestBody: requestBody("AuthSessionRequest"),
        responses: {
          "200": response("Authenticated session", "AuthSessionEnvelope"),
          default: defaultError,
        },
      },
    },
    "/v1/config": {
      get: {
        tags: ["System"],
        operationId: "getConfig",
        responses: {
          "200": response(
            "Trusted environment configuration",
            "ConfigEnvelope",
          ),
          default: defaultError,
        },
      },
    },
    "/v1/challenges": {
      post: {
        tags: ["Work"],
        operationId: "createChallenge",
        security: [{ bearerAuth: [] }],
        parameters: [idempotencyHeader],
        requestBody: requestBody("ChallengeRequest"),
        responses: {
          "200": response("Wallet-bound Challenge", "ChallengeEnvelope"),
          default: defaultError,
        },
      },
    },
    "/v1/work/verify": {
      post: {
        tags: ["Work"],
        operationId: "submitWorkVerification",
        security: [{ bearerAuth: [] }],
        parameters: [idempotencyHeader],
        requestBody: requestBody("WorkVerifyRequest"),
        responses: {
          "202": response("Verification job accepted", "WorkAcceptedEnvelope"),
          default: defaultError,
        },
      },
    },
    "/v1/work/jobs/{jobId}": {
      get: {
        tags: ["Work"],
        operationId: "getWorkJob",
        security: [{ bearerAuth: [] }],
        parameters: [pathParameter("jobId", "Uuid")],
        responses: {
          "200": response("Verification job state", "WorkJobEnvelope"),
          default: defaultError,
        },
      },
    },
    "/v1/operations/{operationId}": {
      get: {
        tags: ["Operations"],
        operationId: "getOperation",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "operationId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": response("Durable operation state", "OperationEnvelope"),
          default: defaultError,
        },
      },
    },
    "/v1/operations/{operationId}/transaction": {
      post: {
        tags: ["Operations"],
        operationId: "associateOperationTransaction",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "operationId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
          idempotencyHeader,
        ],
        requestBody: requestBody("AssociateTransactionRequest"),
        responses: {
          "200": response("Updated durable operation", "OperationEnvelope"),
          default: defaultError,
        },
      },
    },
    "/v1/mints/{txHash}": {
      get: {
        tags: ["Read"],
        operationId: "getMint",
        parameters: [pathParameter("txHash", "Bytes32")],
        responses: {
          "200": response("Mint chain state", "MintEnvelope"),
          default: defaultError,
        },
      },
    },
    "/v1/arcals/{id}": {
      get: {
        tags: ["Read"],
        operationId: "getArcal",
        parameters: [pathParameter("id", "ArcalIdString")],
        responses: {
          "200": response("Arcal chain projection", "ArcalEnvelope"),
          default: defaultError,
        },
      },
    },
    "/v1/public/config": {
      get: {
        tags: ["Read"],
        operationId: "getPublicConfig",
        description:
          "Stable public surface: network, contract addresses and frozen protocol parameters.",
        responses: {
          "200": {
            description: "Public configuration",
            content: { "application/json": { schema: { type: "object" } } },
          },
          default: defaultError,
        },
      },
    },
    "/v1/public/status": {
      get: {
        tags: ["Read"],
        operationId: "getPublicStatus",
        description:
          "Live protocol state, Mint counters and read-model freshness. Safe to poll every 5 seconds.",
        responses: {
          "200": {
            description: "Public status",
            content: { "application/json": { schema: { type: "object" } } },
          },
          default: defaultError,
        },
      },
    },
    "/v1/public/skill": {
      get: {
        tags: ["Read"],
        operationId: "getPublicSkill",
        description: "Where to install the official Agent Skill and CLI.",
        responses: {
          "200": {
            description: "Skill release pointer",
            content: { "application/json": { schema: { type: "object" } } },
          },
          default: defaultError,
        },
      },
    },
    "/v1/arcals/{id}/image.svg": {
      get: {
        tags: ["Content"],
        operationId: "getArcalImage",
        parameters: [pathParameter("id", "ArcalIdString")],
        responses: {
          "200": {
            description:
              "Arcal artwork, identical to the on-chain renderer output",
            content: { "image/svg+xml": { schema: { type: "string" } } },
          },
          default: defaultError,
        },
      },
    },
    "/v1/wallets/{address}/arcals": {
      get: {
        tags: ["Read"],
        operationId: "listWalletArcals",
        parameters: [
          pathParameter("address", "Address"),
          { name: "cursor", in: "query", schema: { type: "string" } },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 100 },
          },
        ],
        responses: {
          "200": response("Current owner index", "ArcalListEnvelope"),
          default: defaultError,
        },
      },
    },
    "/v1/wallets/{address}/activity": {
      get: {
        tags: ["Read"],
        operationId: "listWalletActivity",
        parameters: [
          pathParameter("address", "Address"),
          { name: "cursor", in: "query", schema: { type: "string" } },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 100 },
          },
        ],
        responses: {
          "200": response(
            "Confirmed wallet-related Arcals activity",
            "WalletActivityListEnvelope",
          ),
          default: defaultError,
        },
      },
    },
    "/v1/vault": {
      get: {
        tags: ["Read"],
        operationId: "getVault",
        responses: {
          "200": response("Vault FIFO state", "VaultEnvelope"),
          default: defaultError,
        },
      },
    },
    "/v1/vault/items": {
      get: {
        tags: ["Read"],
        operationId: "listVaultItems",
        parameters: [
          { name: "cursor", in: "query", schema: { type: "string" } },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 100 },
          },
        ],
        responses: {
          "200": response("Vault FIFO items", "VaultItemsEnvelope"),
          default: defaultError,
        },
      },
    },
    "/v1/pi/{id}/proof": {
      get: {
        tags: ["Content"],
        operationId: "getPiProof",
        parameters: [pathParameter("id", "ArcalIdString")],
        responses: {
          "200": response("Deterministic Pi proof", "PiProofEnvelope"),
          default: defaultError,
        },
      },
    },
    "/v1/stats": {
      get: {
        tags: ["Read"],
        operationId: "getStats",
        responses: {
          "200": response(
            "Single-snapshot protocol statistics",
            "StatsEnvelope",
          ),
          default: defaultError,
        },
      },
    },
    "/v1/health": {
      get: {
        tags: ["System"],
        operationId: "getHealth",
        responses: {
          "200": response("Public dependency health", "HealthEnvelope"),
          default: defaultError,
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "opaque" },
    },
    schemas: API_SCHEMAS,
  },
  "x-arcals-environment-bound": true,
} as const;
