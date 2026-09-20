import { ERROR_ACTIONS, PROTOCOL_ERRORS } from "./errors.js";
import { CLI_COMMANDS } from "./api-types.js";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const nullableRef = (name: string) => ({
  anyOf: [ref(name), { type: "null" }],
});

const closedObject = (
  properties: Record<string, unknown>,
  required: readonly string[],
): Record<string, unknown> => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

const successEnvelope = (dataSchema: Record<string, unknown>) =>
  closedObject(
    {
      ok: { const: true },
      schemaVersion: { const: "1" },
      requestId: { type: "string", format: "uuid" },
      data: dataSchema,
      error: { type: "null" },
      meta: ref("ApiMeta"),
    },
    ["ok", "schemaVersion", "requestId", "data", "error", "meta"],
  );

const addressProperties = Object.fromEntries(
  ["core", "base", "mirror", "vault", "controller", "treasury"].map((name) => [
    name,
    nullableRef("Address"),
  ]),
);

export const API_SCHEMAS = {
  DecimalString: { type: "string", format: "decimal-uint256" },
  Uint64String: { type: "string", format: "decimal-uint64" },
  ArcalIdString: { type: "string", pattern: "^(?:[1-9][0-9]{0,5}|1000000)$" },
  Address: { type: "string", pattern: "^0x[0-9a-f]{40}$" },
  Bytes32: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
  Signature: { type: "string", format: "ecdsa-signature" },
  WalletAuthSignature: {
    type: "string",
    pattern: "^0x(?:[0-9a-fA-F]{2}){1,2048}$",
  },
  PackedPiDigits: { type: "string", format: "pi-bcd-360" },
  DatasetId: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,127}$" },
  Rfc3339: { type: "string", format: "date-time" },
  Uuid: { type: "string", format: "uuid" },
  ApiMeta: {
    ...closedObject(
      {
        environmentId: ref("EnvironmentId"),
        asOf: ref("Rfc3339"),
        indexedBlock: nullableRef("DecimalString"),
        indexedBlockHash: nullableRef("Bytes32"),
        chainTip: nullableRef("DecimalString"),
        stale: { type: "boolean" },
      },
      [
        "environmentId",
        "asOf",
        "indexedBlock",
        "indexedBlockHash",
        "chainTip",
        "stale",
      ],
    ),
    allOf: [
      {
        if: { properties: { stale: { const: false } } },
        then: {
          properties: {
            indexedBlock: ref("DecimalString"),
            indexedBlockHash: ref("Bytes32"),
            chainTip: ref("DecimalString"),
          },
        },
      },
    ],
  },
  ApiError: closedObject(
    {
      code: { type: "string", enum: Object.keys(PROTOCOL_ERRORS) },
      message: { type: "string", minLength: 1 },
      retryable: { type: "boolean" },
      retryAfterMs: { type: ["integer", "null"], minimum: 0 },
      action: {
        type: "string",
        enum: ERROR_ACTIONS,
      },
      operationId: { type: ["string", "null"], format: "uuid" },
      details: { type: ["object", "null"], additionalProperties: true },
    },
    [
      "code",
      "message",
      "retryable",
      "retryAfterMs",
      "action",
      "operationId",
      "details",
    ],
  ),
  ErrorEnvelope: closedObject(
    {
      ok: { const: false },
      schemaVersion: { const: "1" },
      requestId: { type: "string", format: "uuid" },
      data: { type: "null" },
      error: ref("ApiError"),
      meta: ref("ApiMeta"),
    },
    ["ok", "schemaVersion", "requestId", "data", "error", "meta"],
  ),
  Challenge: closedObject(
    {
      protocolVersion: { const: 1 },
      configDigest: ref("Bytes32"),
      challengeId: ref("Bytes32"),
      epochId: ref("Uint64String"),
      minter: ref("Address"),
      mintNonce: ref("DecimalString"),
      challengeInput: ref("Bytes32"),
      mintFee: ref("DecimalString"),
      validAfter: ref("Uint64String"),
      expiresAt: ref("Uint64String"),
      signerVersion: ref("Uint64String"),
    },
    [
      "protocolVersion",
      "configDigest",
      "challengeId",
      "epochId",
      "minter",
      "mintNonce",
      "challengeInput",
      "mintFee",
      "validAfter",
      "expiresAt",
      "signerVersion",
    ],
  ),
  WorkCertificate: closedObject(
    {
      protocolVersion: { const: 1 },
      challengeHash: ref("Bytes32"),
      workNonce: ref("Uint64String"),
      randomxHash: ref("Bytes32"),
      issuedAt: ref("Uint64String"),
      expiresAt: ref("Uint64String"),
      signerVersion: ref("Uint64String"),
    },
    [
      "protocolVersion",
      "challengeHash",
      "workNonce",
      "randomxHash",
      "issuedAt",
      "expiresAt",
      "signerVersion",
    ],
  ),
  WorkConfig: closedObject(
    {
      protocolVersion: { const: 1 },
      algorithmId: ref("Bytes32"),
      parameterDigest: ref("Bytes32"),
      epochSeconds: ref("Uint64String"),
      keyLeadSeconds: ref("Uint64String"),
      maxChallengeTtl: ref("Uint64String"),
      maxCertificateTtl: ref("Uint64String"),
      target: ref("DecimalString"),
      effectiveEpoch: ref("Uint64String"),
      configDigest: ref("Bytes32"),
    },
    [
      "protocolVersion",
      "algorithmId",
      "parameterDigest",
      "epochSeconds",
      "keyLeadSeconds",
      "maxChallengeTtl",
      "maxCertificateTtl",
      "target",
      "effectiveEpoch",
      "configDigest",
    ],
  ),
  Epoch: closedObject(
    {
      epochId: ref("Uint64String"),
      configDigest: ref("Bytes32"),
      epochKey: ref("Bytes32"),
      validFrom: ref("Uint64String"),
      validUntil: ref("Uint64String"),
      anchorBlockNumber: ref("Uint64String"),
      anchorBlockHash: ref("Bytes32"),
    },
    [
      "epochId",
      "configDigest",
      "epochKey",
      "validFrom",
      "validUntil",
      "anchorBlockNumber",
      "anchorBlockHash",
    ],
  ),
  DeploymentAddresses: closedObject(
    addressProperties,
    Object.keys(addressProperties),
  ),
  WalletHandle: {
    oneOf: [
      closedObject(
        {
          kind: { const: "transaction" },
          chainId: ref("DecimalString"),
          hash: ref("Bytes32"),
          sender: ref("Address"),
          transactionNonce: ref("DecimalString"),
        },
        ["kind", "chainId", "hash", "sender"],
      ),
      closedObject(
        {
          kind: { const: "provider-operation" },
          provider: { type: "string", minLength: 1 },
          requestId: { type: "string", minLength: 1 },
          operationId: { type: "string", format: "uuid" },
          chainId: ref("DecimalString"),
        },
        ["kind", "provider", "requestId", "operationId", "chainId"],
      ),
      closedObject(
        {
          kind: { const: "user-operation" },
          entryPoint: ref("Address"),
          userOpHash: ref("Bytes32"),
          sender: ref("Address"),
          accountNonce: ref("DecimalString"),
          chainId: ref("DecimalString"),
        },
        [
          "kind",
          "entryPoint",
          "userOpHash",
          "sender",
          "accountNonce",
          "chainId",
        ],
      ),
    ],
  },
  EnvironmentId: { type: "string", pattern: "^[0-9]+:0x[0-9a-f]{40}$" },
  Arcal: closedObject(
    {
      environmentId: ref("EnvironmentId"),
      id: ref("ArcalIdString"),
      originalMinter: ref("Address"),
      owner: ref("Address"),
      contentStatus: { enum: ["PENDING_CONTENT", "REGISTERED"] },
      formState: { enum: ["UNBANKED", "BANKED"] },
      startDigit: ref("DecimalString"),
      endDigit: ref("DecimalString"),
      contentHash: nullableRef("Bytes32"),
      datasetRoot: ref("Bytes32"),
      packedDigitsUrl: { type: ["string", "null"], format: "uri" },
      workReceiptHash: ref("Bytes32"),
      workVerification: { enum: ["verified", "unverified"] },
      queuePosition: nullableRef("DecimalString"),
      lastUpdatedBlock: ref("DecimalString"),
    },
    [
      "environmentId",
      "id",
      "originalMinter",
      "owner",
      "contentStatus",
      "formState",
      "startDigit",
      "endDigit",
      "contentHash",
      "datasetRoot",
      "packedDigitsUrl",
      "workReceiptHash",
      "workVerification",
      "queuePosition",
      "lastUpdatedBlock",
    ],
  ),
  WalletActivity: closedObject(
    {
      environmentId: ref("EnvironmentId"),
      wallet: ref("Address"),
      kind: {
        enum: [
          "MINT",
          "NFT_TRANSFER_IN",
          "NFT_TRANSFER_OUT",
          "LIQUIFY",
          "REFORM",
        ],
      },
      transactionHash: ref("Bytes32"),
      blockNumber: ref("DecimalString"),
      logIndex: { type: "integer", minimum: 0 },
      arcalId: ref("ArcalIdString"),
      counterparty: nullableRef("Address"),
      nativeDelta: { type: "string", pattern: "^-?(?:0|[1-9][0-9]*)$" },
      arclDelta: { type: "string", pattern: "^-?(?:0|[1-9][0-9]*)$" },
      nftDelta: { enum: [-1, 0, 1] },
    },
    [
      "environmentId",
      "wallet",
      "kind",
      "transactionHash",
      "blockNumber",
      "logIndex",
      "arcalId",
      "counterparty",
      "nativeDelta",
      "arclDelta",
      "nftDelta",
    ],
  ),
  AuthNonceRequest: closedObject(
    { wallet: ref("Address"), chainId: ref("DecimalString") },
    ["wallet", "chainId"],
  ),
  AuthNonceData: closedObject(
    {
      nonce: ref("Bytes32"),
      message: { type: "string" },
      expiresAt: ref("Rfc3339"),
    },
    ["nonce", "message", "expiresAt"],
  ),
  AuthSessionRequest: closedObject(
    {
      message: { type: "string", minLength: 1, maxLength: 4096 },
      signature: ref("WalletAuthSignature"),
    },
    ["message", "signature"],
  ),
  AuthSessionData: closedObject(
    {
      sessionToken: { type: "string", minLength: 1 },
      expiresAt: ref("Rfc3339"),
    },
    ["sessionToken", "expiresAt"],
  ),
  ChallengeRequest: closedObject(
    {
      wallet: ref("Address"),
      mintNonce: ref("DecimalString"),
      protocolVersion: { const: 1 },
    },
    ["wallet", "mintNonce", "protocolVersion"],
  ),
  ChallengeData: closedObject(
    {
      challenge: ref("Challenge"),
      issuerSignature: ref("Signature"),
      epoch: ref("Epoch"),
    },
    ["challenge", "issuerSignature", "epoch"],
  ),
  WorkVerifyRequest: closedObject(
    {
      challenge: ref("Challenge"),
      issuerSignature: ref("Signature"),
      workNonce: ref("Uint64String"),
      clientRandomxHash: nullableRef("Bytes32"),
    },
    ["challenge", "issuerSignature", "workNonce", "clientRandomxHash"],
  ),
  WorkAcceptedData: closedObject(
    { jobId: { type: "string", format: "uuid" }, status: { const: "QUEUED" } },
    ["jobId", "status"],
  ),
  WorkJobData: {
    ...closedObject(
      {
        jobId: { type: "string", format: "uuid" },
        status: {
          enum: [
            "QUEUED",
            "VERIFYING",
            "CERTIFICATE_READY",
            "REJECTED",
            "EXPIRED",
          ],
        },
        certificate: nullableRef("WorkCertificate"),
        verifierSignature: nullableRef("Signature"),
        error: nullableRef("ApiError"),
      },
      ["jobId", "status", "certificate", "verifierSignature", "error"],
    ),
    allOf: [
      {
        if: { properties: { status: { const: "CERTIFICATE_READY" } } },
        then: {
          properties: {
            certificate: ref("WorkCertificate"),
            verifierSignature: ref("Signature"),
          },
        },
      },
    ],
  },
  OperationData: closedObject(
    {
      operationId: { type: "string", format: "uuid" },
      state: {
        enum: [
          "CREATED",
          "PREFLIGHT",
          "NEEDS_USER_AUTH",
          "CHALLENGE_READY",
          "DATASET_READY",
          "COMPUTING",
          "SOLUTION_FOUND",
          "VERIFYING",
          "CERTIFICATE_READY",
          "WALLET_SUBMITTING",
          "TX_PENDING",
          "MINT_CONFIRMED",
          "SUBMISSION_UNKNOWN",
          "RECOVERING",
          "REVERTED",
          "REPLACED",
          "UNKNOWN",
          "CANCELLED",
          "EXPIRED",
          "FAILED",
          "FAILED_RETRYABLE",
        ],
      },
      walletHandle: nullableRef("WalletHandle"),
      stopRequested: { type: "boolean" },
      updatedAt: ref("Rfc3339"),
    },
    ["operationId", "state", "walletHandle", "stopRequested", "updatedAt"],
  ),
  AssociateTransactionRequest: closedObject(
    { walletHandle: ref("WalletHandle"), txHash: nullableRef("Bytes32") },
    ["walletHandle", "txHash"],
  ),
  MintData: closedObject(
    {
      txHash: ref("Bytes32"),
      status: { enum: ["PENDING", "FINAL", "REVERTED", "RECOVERY_REQUIRED"] },
      issuedId: nullableRef("ArcalIdString"),
      receiptHash: nullableRef("Bytes32"),
      workVerification: { enum: ["verified", "unverified", "unknown"] },
    },
    ["txHash", "status", "issuedId", "receiptHash", "workVerification"],
  ),
  ArcalListData: closedObject(
    {
      items: { type: "array", items: ref("Arcal"), maxItems: 100 },
      nextCursor: { type: ["string", "null"] },
    },
    ["items", "nextCursor"],
  ),
  WalletActivityListData: closedObject(
    {
      items: { type: "array", items: ref("WalletActivity"), maxItems: 100 },
      nextCursor: { type: ["string", "null"] },
    },
    ["items", "nextCursor"],
  ),
  VaultData: closedObject(
    {
      head: ref("DecimalString"),
      tail: ref("DecimalString"),
      bankedCount: ref("DecimalString"),
      nextId: nullableRef("ArcalIdString"),
      conversionOpen: { type: "boolean" },
    },
    ["head", "tail", "bankedCount", "nextId", "conversionOpen"],
  ),
  VaultItem: closedObject(
    { position: ref("DecimalString"), id: ref("ArcalIdString") },
    ["position", "id"],
  ),
  VaultItemsData: closedObject(
    {
      items: { type: "array", items: ref("VaultItem"), maxItems: 100 },
      nextCursor: { type: ["string", "null"] },
    },
    ["items", "nextCursor"],
  ),
  PiProofData: closedObject(
    {
      datasetId: ref("DatasetId"),
      id: ref("ArcalIdString"),
      packedDigits: ref("PackedPiDigits"),
      proof: {
        type: "array",
        items: ref("Bytes32"),
        minItems: 20,
        maxItems: 20,
      },
      contentHash: ref("Bytes32"),
      root: ref("Bytes32"),
    },
    ["datasetId", "id", "packedDigits", "proof", "contentHash", "root"],
  ),
  StatsData: closedObject(
    {
      minted: ref("DecimalString"),
      reserveMintedCount: ref("DecimalString"),
      mintPaused: { type: "boolean" },
      reserveArcl: ref("DecimalString"),
      externalArcl: ref("DecimalString"),
      bankedCount: ref("DecimalString"),
      mintRevenueNative: ref("DecimalString"),
    },
    [
      "minted",
      "reserveMintedCount",
      "mintPaused",
      "reserveArcl",
      "externalArcl",
      "bankedCount",
      "mintRevenueNative",
    ],
  ),
  HealthData: closedObject(
    {
      version: { type: "string" },
      dependencies: {
        type: "object",
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          properties: {
            healthy: { type: "boolean" },
            stale: { type: "boolean" },
          },
          required: ["healthy", "stale"],
        },
      },
    },
    ["version", "dependencies"],
  ),
  ConfigData: closedObject(
    {
      environmentId: ref("EnvironmentId"),
      chainId: ref("DecimalString"),
      deployment: ref("DeploymentAddresses"),
      piRoot: nullableRef("Bytes32"),
      workConfig: nullableRef("WorkConfig"),
      epoch: nullableRef("Epoch"),
      capabilities: {
        type: "object",
        additionalProperties: { type: "boolean" },
      },
    },
    [
      "environmentId",
      "chainId",
      "deployment",
      "piRoot",
      "workConfig",
      "epoch",
      "capabilities",
    ],
  ),
  AuthNonceEnvelope: successEnvelope(ref("AuthNonceData")),
  AuthSessionEnvelope: successEnvelope(ref("AuthSessionData")),
  ConfigEnvelope: successEnvelope(ref("ConfigData")),
  ChallengeEnvelope: successEnvelope(ref("ChallengeData")),
  WorkAcceptedEnvelope: successEnvelope(ref("WorkAcceptedData")),
  WorkJobEnvelope: successEnvelope(ref("WorkJobData")),
  OperationEnvelope: successEnvelope(ref("OperationData")),
  MintEnvelope: successEnvelope(ref("MintData")),
  ArcalEnvelope: successEnvelope(ref("Arcal")),
  ArcalListEnvelope: successEnvelope(ref("ArcalListData")),
  WalletActivityListEnvelope: successEnvelope(ref("WalletActivityListData")),
  VaultEnvelope: successEnvelope(ref("VaultData")),
  VaultItemsEnvelope: successEnvelope(ref("VaultItemsData")),
  PiProofEnvelope: successEnvelope(ref("PiProofData")),
  StatsEnvelope: successEnvelope(ref("StatsData")),
  HealthEnvelope: successEnvelope(ref("HealthData")),
  CliEnvelope: {
    ...closedObject(
      {
        ok: { type: "boolean" },
        schemaVersion: { const: "1" },
        command: { enum: CLI_COMMANDS },
        state: { type: "string", minLength: 1 },
        operationId: { type: ["string", "null"], format: "uuid" },
        chainId: nullableRef("DecimalString"),
        wallet: nullableRef("Address"),
        txHash: nullableRef("Bytes32"),
        data: { type: "object", additionalProperties: true },
        error: nullableRef("ApiError"),
        asOf: ref("Rfc3339"),
      },
      [
        "ok",
        "schemaVersion",
        "command",
        "state",
        "operationId",
        "chainId",
        "wallet",
        "txHash",
        "data",
        "error",
        "asOf",
      ],
    ),
    allOf: [
      {
        if: { properties: { ok: { const: true } } },
        then: { properties: { error: { type: "null" } } },
        else: { properties: { error: ref("ApiError") } },
      },
    ],
  },
} as const;

export type ApiSchemaName = keyof typeof API_SCHEMAS;
