// ---------------------------------------------------------------------------
// Arcals browser RandomX Worker, protocol version 1.
//
// This file is appended to the Emscripten glue (which defines
// createArcalsRandomX) to form one self-contained module Worker script with
// no imports, so a page can verify its SHA-256 and start it from a Blob.
// The page supplies the SHA-256-verified WebAssembly bytes; nothing is
// fetched here. Cancel by terminating the Worker.
//
// In:
//   { type: "START", protocolVersion: 1, jobId, wasmBytes, algorithmId,
//     parameterDigest, target, epochKey, challengeInput, expiresAt,
//     startNonce?, stride? }
//   target is a decimal uint256; expiresAt is Unix seconds. startNonce
//   (decimal, default "0") and stride (default 1) let N Workers split the
//   nonce space: Worker i takes startNonce i and stride N.
// Out (every message carries type, protocolVersion and jobId):
//   { type: "READY", prepareMs }                      cache keyed, searching
//   { type: "PROGRESS", hashesTried, elapsedMs, hashRate }   about every 500 ms
//   { type: "SOLUTION", workNonce, randomxHash, hashesTried, elapsedMs }
//   { type: "ERROR", code, message }
//     code: INVALID_START | PARAMETERS_MISMATCH | CHALLENGE_EXPIRED | ENGINE_FAILED
// ---------------------------------------------------------------------------

const ARCALS_WORKER_PROTOCOL_VERSION = 1;
const ARCALS_ALGORITHM_ID =
  "0x8ca1fa54766ca6df7bcbbb2a8da08bee94dd5ed9f0055f5e90331a9028af77a9";
const ARCALS_PARAMETER_DIGEST =
  "0x207c0c80715507e7133d2b79d6067d774c24a06c3f2cf46a63f1dfdf74fab8f1";
const ARCALS_UINT64_MAX = (1n << 64n) - 1n;

class ArcalsWorkerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function arcalsPost(type, jobId, fields) {
  self.postMessage({
    type,
    protocolVersion: ARCALS_WORKER_PROTOCOL_VERSION,
    jobId,
    ...fields,
  });
}

function arcalsBytes(hex, length, label) {
  if (
    typeof hex !== "string" ||
    !new RegExp(`^0x[0-9a-fA-F]{${length * 2}}$`).test(hex)
  ) {
    throw new ArcalsWorkerError(
      "INVALID_START",
      `${label} must be ${length} bytes of hex`,
    );
  }
  const out = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    out[index] = Number.parseInt(hex.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return out;
}

function arcalsTarget(value) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new ArcalsWorkerError(
      "INVALID_START",
      "target must be a decimal uint256",
    );
  }
  let target = BigInt(value);
  if (target === 0n || target >= 1n << 256n) {
    throw new ArcalsWorkerError(
      "INVALID_START",
      "target must be a non-zero uint256",
    );
  }
  const out = new Uint8Array(32);
  for (let index = 31; index >= 0; index -= 1) {
    out[index] = Number(target & 0xffn);
    target >>= 8n;
  }
  return out;
}

function arcalsHex(view) {
  return `0x${Array.from(view, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function arcalsRun(message) {
  const jobId = message.jobId;
  if (message.protocolVersion !== ARCALS_WORKER_PROTOCOL_VERSION) {
    throw new ArcalsWorkerError("INVALID_START", "unsupported protocolVersion");
  }
  if (
    String(message.algorithmId).toLowerCase() !== ARCALS_ALGORITHM_ID ||
    String(message.parameterDigest).toLowerCase() !== ARCALS_PARAMETER_DIGEST
  ) {
    throw new ArcalsWorkerError(
      "PARAMETERS_MISMATCH",
      "work parameters do not match this RandomX build",
    );
  }
  const epochKey = arcalsBytes(message.epochKey, 32, "epochKey");
  const challengeInput = arcalsBytes(
    message.challengeInput,
    32,
    "challengeInput",
  );
  const target = arcalsTarget(message.target);
  const expiresAt = Number(message.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    throw new ArcalsWorkerError(
      "INVALID_START",
      "expiresAt must be Unix seconds",
    );
  }
  const startNonce = BigInt(message.startNonce ?? "0");
  const stride = message.stride ?? 1;
  if (
    startNonce < 0n ||
    startNonce > ARCALS_UINT64_MAX ||
    !Number.isInteger(stride) ||
    stride < 1 ||
    stride > 1024
  ) {
    throw new ArcalsWorkerError(
      "INVALID_START",
      "startNonce or stride is out of range",
    );
  }
  if (!(
    message.wasmBytes instanceof ArrayBuffer ||
    ArrayBuffer.isView(message.wasmBytes)
  )) {
    throw new ArcalsWorkerError(
      "INVALID_START",
      "wasmBytes must be an ArrayBuffer",
    );
  }
  const secondsLeft = () => expiresAt - Date.now() / 1000;
  if (secondsLeft() <= 1) {
    throw new ArcalsWorkerError(
      "CHALLENGE_EXPIRED",
      "the challenge has expired",
    );
  }

  const started = performance.now();
  let rx;
  try {
    rx = await createArcalsRandomX({
      wasmBinary: new Uint8Array(
        ArrayBuffer.isView(message.wasmBytes)
          ? message.wasmBytes.buffer.slice(
              message.wasmBytes.byteOffset,
              message.wasmBytes.byteOffset + message.wasmBytes.byteLength,
            )
          : message.wasmBytes,
      ),
    });
  } catch (error) {
    throw new ArcalsWorkerError(
      "ENGINE_FAILED",
      `WebAssembly failed to load: ${String(error)}`,
    );
  }
  const copyIn = (data) => {
    const pointer = rx._malloc(data.length);
    rx.HEAPU8.set(data, pointer);
    return pointer;
  };
  const key = copyIn(epochKey);
  const status = rx._arx_prepare(key);
  rx._free(key);
  if (status !== 0) {
    throw new ArcalsWorkerError(
      "ENGINE_FAILED",
      `RandomX cache preparation failed (${status})`,
    );
  }
  arcalsPost("READY", jobId, {
    prepareMs: Math.round(performance.now() - started),
  });

  const challenge = copyIn(challengeInput);
  const bound = copyIn(target);
  const result = rx._malloc(44);
  const searchStarted = performance.now();
  let lastProgress = searchStarted;
  let tried = 0;
  let nonce = startNonce;
  const step = BigInt(stride);
  // Runs until a solution or expiry; the page cancels by terminating us.
  for (;;) {
    if (secondsLeft() <= 1) {
      throw new ArcalsWorkerError(
        "CHALLENGE_EXPIRED",
        "the challenge expired before a solution was found",
      );
    }
    const found = rx._arx_search(
      challenge,
      bound,
      Number(nonce & 0xffffffffn),
      Number(nonce >> 32n),
      stride,
      1,
      result,
    );
    if (found < 0)
      throw new ArcalsWorkerError(
        "ENGINE_FAILED",
        `RandomX search failed (${found})`,
      );
    tried += 1;
    const now = performance.now();
    if (found === 1) {
      const view = rx.HEAPU8.subarray(result, result + 40);
      let workNonce = 0n;
      for (let index = 7; index >= 0; index -= 1) {
        workNonce = (workNonce << 8n) | BigInt(view[index]);
      }
      arcalsPost("SOLUTION", jobId, {
        workNonce: workNonce.toString(),
        randomxHash: arcalsHex(view.subarray(8, 40)),
        hashesTried: String(tried),
        elapsedMs: String(Math.round(now - searchStarted)),
      });
      return;
    }
    if (nonce > ARCALS_UINT64_MAX - step) {
      throw new ArcalsWorkerError("ENGINE_FAILED", "nonce space exhausted");
    }
    nonce += step;
    if (now - lastProgress >= 500) {
      lastProgress = now;
      const seconds = (now - searchStarted) / 1000;
      arcalsPost("PROGRESS", jobId, {
        hashesTried: String(tried),
        elapsedMs: String(Math.round(now - searchStarted)),
        hashRate: (tried / seconds).toFixed(2),
      });
    }
  }
}

let arcalsStarted = false;
self.onmessage = (event) => {
  const message = event.data ?? {};
  if (message.type !== "START") return;
  const jobId = typeof message.jobId === "string" ? message.jobId : null;
  if (arcalsStarted) {
    arcalsPost("ERROR", jobId, {
      code: "INVALID_START",
      message: "this Worker already ran a job; start a new Worker",
    });
    return;
  }
  arcalsStarted = true;
  arcalsRun(message).catch((error) => {
    arcalsPost("ERROR", jobId, {
      code: error instanceof ArcalsWorkerError ? error.code : "ENGINE_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
  });
};
