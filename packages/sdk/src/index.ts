import { mintControllerAbi } from "@arcals/contract-bindings";
import {
  MINT_FEE_NATIVE,
  assertApiSchema,
  assertCanonicalEcdsaSignature,
  assertHexAddress,
  certificateFromJson,
  challengeFromJson,
} from "@arcals/protocol";
import type {
  ApiEnvelope,
  ApiError,
  ApiMeta,
  ApiSchemaName,
  ArcalDto,
  Bytes32,
  Challenge,
  ChallengeJson,
  ConfigDto,
  HexAddress,
  MintDto,
  OperationDto,
  PiProofDto,
  StatsDto,
  VaultDto,
  WalletHandle,
  WorkCertificate,
  WorkCertificateJson,
} from "@arcals/protocol";
import { decodeFunctionData, encodeFunctionData } from "viem";
import type { Hex } from "viem";
import type { ContractCall } from "./wallet.js";

export * from "./wallet.js";
export * from "./contract-calls.js";

function baseCall(
  chainId: bigint,
  to: HexAddress,
  data: Hex,
  valueNative = 0n,
): ContractCall {
  if (chainId < 0n) throw new RangeError("chainId must be unsigned");
  assertHexAddress(to, "contract address");
  return { chainId, to, data, valueNative };
}

export function buildMintCall(
  chainId: bigint,
  controller: HexAddress,
  challenge: Challenge,
  issuerSignature: Hex,
  certificate: WorkCertificate,
  verifierSignature: Hex,
): ContractCall {
  assertCanonicalEcdsaSignature(issuerSignature);
  assertCanonicalEcdsaSignature(verifierSignature);
  if (challenge.mintFee !== MINT_FEE_NATIVE) {
    throw new RangeError(
      "Challenge mintFee does not equal the fixed protocol fee",
    );
  }
  const data = encodeFunctionData({
    abi: mintControllerAbi,
    functionName: "mint",
    args: [challenge, issuerSignature, certificate, verifierSignature],
  });
  return baseCall(chainId, controller, data, MINT_FEE_NATIVE);
}

/**
 * Wrap the canonical typed Mint arguments in one bytes parameter for wallet
 * providers that cannot serialize nested ABI tuples. The payload is exactly
 * the original mint calldata after its four-byte selector.
 */
export function buildEncodedMintCall(call: ContractCall): ContractCall {
  const decoded = decodeFunctionData({
    abi: mintControllerAbi,
    data: call.data,
  });
  if (decoded.functionName !== "mint") {
    throw new TypeError("buildEncodedMintCall requires a canonical mint call");
  }
  const payload = `0x${call.data.slice(10)}` as Hex;
  return baseCall(
    call.chainId,
    call.to,
    encodeFunctionData({
      abi: mintControllerAbi,
      functionName: "mintEncoded",
      args: [payload],
    }),
    call.valueNative,
  );
}

interface ChallengeHttpData {
  readonly challenge: ChallengeJson;
  readonly issuerSignature: Hex;
  readonly epoch: Record<string, string>;
}

interface WorkAcceptedHttpData {
  readonly jobId: string;
  readonly status: "QUEUED";
}

export interface WorkJobHttpData {
  readonly jobId: string;
  readonly status:
    "QUEUED" | "VERIFYING" | "CERTIFICATE_READY" | "REJECTED" | "EXPIRED";
  readonly certificate: WorkCertificateJson | null;
  readonly verifierSignature: Hex | null;
  readonly error: ApiError | null;
}

export class ArcalsApiError extends Error {
  constructor(
    readonly status: number,
    readonly apiError: ApiError,
    readonly meta: ApiMeta,
  ) {
    super(apiError.message);
    this.name = "ArcalsApiError";
  }
}

async function checkedJson<T>(
  response: Response,
  schema: ApiSchemaName,
): Promise<ApiEnvelope<T>> {
  const value: unknown = await response.json();
  if (!response.ok) {
    assertApiSchema("ErrorEnvelope", value);
    const envelope = value as ApiEnvelope<never>;
    if (envelope.error === null) {
      throw new Error(`Arcals API returned HTTP ${String(response.status)}`);
    }
    throw new ArcalsApiError(response.status, envelope.error, envelope.meta);
  }
  assertApiSchema(schema, value);
  return value as ApiEnvelope<T>;
}

export class ArcalsWorkApiClient {
  constructor(
    private readonly baseUrl: string,
    private authorization: string | null = null,
    private readonly retryBaseMs = 500,
  ) {}

  /**
   * Retries transport failures and 429/502/503/504 with exponential backoff.
   * Safe for every call here: reads are side-effect free and every write
   * carries an idempotency key the server replays.
   */
  private async send(url: string, init: RequestInit): Promise<Response> {
    const attempts = 4;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const response = await fetch(url, init);
        if (
          attempt < attempts &&
          [429, 502, 503, 504].includes(response.status)
        ) {
          await response.body?.cancel();
        } else {
          return response;
        }
      } catch (error) {
        if (attempt >= attempts) throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, this.retryBaseMs * 2 ** (attempt - 1)),
      );
    }
  }

  setBearerToken(token: string): void {
    this.authorization = `Bearer ${token}`;
  }

  async createAuthNonce(input: {
    readonly wallet: HexAddress;
    readonly chainId: bigint;
    readonly idempotencyKey: string;
  }): Promise<{
    readonly nonce: Bytes32;
    readonly message: string;
    readonly expiresAt: string;
  }> {
    const response = await this.send(`${this.baseUrl}/v1/auth/nonce`, {
      method: "POST",
      headers: this.headers(input.idempotencyKey, false),
      body: JSON.stringify({
        wallet: input.wallet,
        chainId: input.chainId.toString(),
      }),
    });
    const envelope = await checkedJson<{
      nonce: Bytes32;
      message: string;
      expiresAt: string;
    }>(response, "AuthNonceEnvelope");
    if (envelope.data === null)
      throw new Error("Auth nonce response has no data");
    return envelope.data;
  }

  async createAuthSession(input: {
    readonly message: string;
    readonly signature: Hex;
    readonly idempotencyKey: string;
  }): Promise<{ readonly sessionToken: string; readonly expiresAt: string }> {
    const response = await this.send(`${this.baseUrl}/v1/auth/session`, {
      method: "POST",
      headers: this.headers(input.idempotencyKey, false),
      body: JSON.stringify({
        message: input.message,
        signature: input.signature,
      }),
    });
    const envelope = await checkedJson<{
      sessionToken: string;
      expiresAt: string;
    }>(response, "AuthSessionEnvelope");
    if (envelope.data === null)
      throw new Error("Auth session response has no data");
    this.setBearerToken(envelope.data.sessionToken);
    return envelope.data;
  }

  async issueChallenge(input: {
    readonly wallet: HexAddress;
    readonly mintNonce: bigint;
    readonly idempotencyKey: string;
  }): Promise<{
    readonly challenge: Challenge;
    readonly issuerSignature: Hex;
  }> {
    const response = await this.send(`${this.baseUrl}/v1/challenges`, {
      method: "POST",
      headers: this.headers(input.idempotencyKey),
      body: JSON.stringify({
        wallet: input.wallet,
        mintNonce: input.mintNonce.toString(),
        protocolVersion: 1,
      }),
    });
    const envelope = await checkedJson<ChallengeHttpData>(
      response,
      "ChallengeEnvelope",
    );
    if (envelope.data === null)
      throw new Error("Challenge response has no data");
    return {
      challenge: challengeFromJson(envelope.data.challenge),
      issuerSignature: envelope.data.issuerSignature,
    };
  }

  async submitWork(input: {
    readonly challenge: Challenge;
    readonly issuerSignature: Hex;
    readonly workNonce: bigint;
    readonly idempotencyKey: string;
  }): Promise<string> {
    const response = await this.send(`${this.baseUrl}/v1/work/verify`, {
      method: "POST",
      headers: this.headers(input.idempotencyKey),
      body: JSON.stringify({
        challenge: {
          protocolVersion: input.challenge.protocolVersion,
          configDigest: input.challenge.configDigest,
          challengeId: input.challenge.challengeId,
          epochId: input.challenge.epochId.toString(),
          minter: input.challenge.minter,
          mintNonce: input.challenge.mintNonce.toString(),
          challengeInput: input.challenge.challengeInput,
          mintFee: input.challenge.mintFee.toString(),
          validAfter: input.challenge.validAfter.toString(),
          expiresAt: input.challenge.expiresAt.toString(),
          signerVersion: input.challenge.signerVersion.toString(),
        },
        issuerSignature: input.issuerSignature,
        workNonce: input.workNonce.toString(),
        clientRandomxHash: null,
      }),
    });
    const envelope = await checkedJson<WorkAcceptedHttpData>(
      response,
      "WorkAcceptedEnvelope",
    );
    if (envelope.data === null) throw new Error("Work response has no data");
    return envelope.data.jobId;
  }

  async getWorkJob(jobId: string): Promise<{
    readonly certificate: WorkCertificate;
    readonly verifierSignature: Hex;
  }> {
    const state = await this.getWorkJobState(jobId);
    if (
      state.status !== "CERTIFICATE_READY" ||
      state.certificate === null ||
      state.verifierSignature === null
    ) {
      throw new Error(`Work job is not certificate-ready: ${state.status}`);
    }
    return {
      certificate: certificateFromJson(state.certificate),
      verifierSignature: state.verifierSignature,
    };
  }

  async getWorkJobState(jobId: string): Promise<WorkJobHttpData> {
    const response = await this.send(`${this.baseUrl}/v1/work/jobs/${jobId}`, {
      headers: this.headers(),
    });
    const envelope = await checkedJson<WorkJobHttpData>(
      response,
      "WorkJobEnvelope",
    );
    if (envelope.data === null) throw new Error("Work job has no data");
    return envelope.data;
  }

  async getOperation(operationId: string): Promise<OperationDto> {
    return this.getData(
      `/v1/operations/${encodeURIComponent(operationId)}`,
      "OperationEnvelope",
      true,
    );
  }

  async getConfig(): Promise<ConfigDto> {
    return this.getData("/v1/config", "ConfigEnvelope");
  }

  async getMint(transactionHash: Bytes32): Promise<MintDto> {
    return this.getData(
      `/v1/mints/${encodeURIComponent(transactionHash)}`,
      "MintEnvelope",
    );
  }

  async associateTransaction(input: {
    readonly operationId: string;
    readonly walletHandle: WalletHandle;
    readonly txHash: Bytes32 | null;
    readonly idempotencyKey: string;
  }): Promise<OperationDto> {
    const response = await this.send(
      `${this.baseUrl}/v1/operations/${encodeURIComponent(input.operationId)}/transaction`,
      {
        method: "POST",
        headers: this.headers(input.idempotencyKey),
        body: JSON.stringify({
          walletHandle: input.walletHandle,
          txHash: input.txHash,
        }),
      },
    );
    const envelope = await checkedJson<OperationDto>(
      response,
      "OperationEnvelope",
    );
    if (envelope.data === null)
      throw new Error("Operation response has no data");
    return envelope.data;
  }

  async getArcal(id: bigint): Promise<ArcalDto> {
    return this.getData(`/v1/arcals/${id.toString()}`, "ArcalEnvelope");
  }

  async getPiProof(id: bigint): Promise<PiProofDto> {
    return this.getData(`/v1/pi/${id.toString()}/proof`, "PiProofEnvelope");
  }

  async getStats(): Promise<StatsDto> {
    return this.getData("/v1/stats", "StatsEnvelope");
  }

  async getVault(): Promise<VaultDto> {
    return this.getData("/v1/vault", "VaultEnvelope");
  }

  private headers(
    idempotencyKey?: string,
    authenticated = true,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (idempotencyKey !== undefined)
      headers["idempotency-key"] = idempotencyKey;
    if (authenticated) {
      if (this.authorization === null)
        throw new Error("Arcals API session is not configured");
      headers.authorization = this.authorization;
    }
    return headers;
  }

  private async getData<T>(
    path: string,
    schema: ApiSchemaName,
    authenticated = false,
  ): Promise<T> {
    const response = await this.send(`${this.baseUrl}${path}`, {
      headers: this.headers(undefined, authenticated),
    });
    const envelope = await checkedJson<T>(response, schema);
    if (envelope.data === null)
      throw new Error(`${schema} response has no data`);
    return envelope.data;
  }
}

export function environmentId(chainId: bigint, core: HexAddress): string {
  if (chainId < 0n) throw new RangeError("chainId must be unsigned");
  assertHexAddress(core, "core");
  return `${chainId.toString()}:${core.toLowerCase()}`;
}

export function isReadModelFresh(meta: ApiMeta, maximumLag: bigint): boolean {
  if (
    maximumLag < 0n ||
    meta.stale ||
    meta.indexedBlock === null ||
    meta.chainTip === null
  ) {
    return false;
  }
  const indexedBlock = BigInt(meta.indexedBlock);
  const chainTip = BigInt(meta.chainTip);
  return chainTip >= indexedBlock && chainTip - indexedBlock <= maximumLag;
}
