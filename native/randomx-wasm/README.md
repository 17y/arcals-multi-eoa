# Arcals browser RandomX engine

RandomX compiled to WebAssembly, so a web page can do Arcals work on the
visitor's own machine with nothing to install. It is built from the same
pinned RandomX source and Arcals patch as the native worker, and its hashes
are bit-identical to the native worker and to the Arcals verifier.

## Why a separate build

A browser cannot generate native code or use AES instructions, so this build
uses RandomX's light mode (a 256 MiB cache instead of the 2 GiB dataset), the
bytecode interpreter and software AES. RandomX defines identical results for
every mode, so these choices only change speed.

One thing does not carry over on its own: RandomX's `CFROUND` instruction
switches the floating-point rounding mode, and WebAssembly only rounds to
nearest-even (`fesetround` is silently ignored). Without handling it, nearly
every hash would be wrong. `src/wasm_rounding.h` computes each addition,
subtraction, multiplication, division and square root to nearest, determines
exactly which side of that result the true value lies on (TwoSum for
addition, 128-bit integer comparison for the rest), and steps one unit in the
last place when the active mode requires it, including IEEE overflow,
underflow and signed-zero rules. `patches/0001-wasm-directed-rounding.patch`
routes RandomX's portable floating-point operations through it when compiling
with Emscripten; native builds are unchanged.

## Build

Requires Emscripten 4.0.15 (`emcc` on `PATH`) and the RandomX submodule.

```sh
bash native/randomx-wasm/scripts/build.sh
```

`dist/` then holds the two shipped files and their checksums:

- `randomx-browser-worker.mjs`: one self-contained module Worker (the
  Emscripten glue plus `js/browser-worker.js`), with no imports, so a page
  can verify its SHA-256 and start it from a Blob URL.
- `randomx-browser.wasm`: the WebAssembly the page hands to that Worker.
- `SHA256SUMS`.

`build/test/arcals-randomx.mjs` is an ES module build used only by the Node
tests.

## Verification

| Check                                                                                                                                  | Command                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Software rounding vs the CPU's own modes, 30 million operations including NaN, infinities, subnormals, overflow and exact cancellation | `g++ -O2 -std=c++17 -frounding-math native/randomx-wasm/test/rounding_test.cpp && ./a.out` |
| Official test vector and native parity                                                                                                 | `node tools/benchmark/wasm-parity.mjs`                                                     |
| Large differential against the native worker                                                                                           | `node tools/benchmark/wasm-differential.mjs 20000 14`                                      |
| Shipped Worker at the production Target: N Workers, nonce split, error codes                                                           | `node tools/benchmark/wasm-worker-test.mjs 4 4`                                            |
| Real Chromium with real Web Workers                                                                                                    | `CHROMIUM_PATH=… PLAYWRIGHT_CORE=… node tools/benchmark/wasm-browser-test.mjs 4 8`         |

The native-parity checks need the native worker built first
(`bash native/randomx-worker/scripts/build.sh`).

## Worker contract (protocol version 1)

The page verifies both files against the SHA-256 published in
`GET /v1/public/config` (`features.browserWalletMint.worker`), starts the
script as a module Worker, and sends one message:

```js
worker.postMessage({
  type: "START",
  protocolVersion: 1,
  jobId,
  wasmBytes, // the verified ArrayBuffer
  algorithmId, // must equal the build's; otherwise PARAMETERS_MISMATCH
  parameterDigest,
  target, // decimal uint256 from the work config
  epochKey,
  challengeInput,
  expiresAt, // Unix seconds from the Challenge
  startNonce, // optional, decimal string, default "0"
  stride, // optional, default 1
});
```

Every reply carries `type`, `protocolVersion` and `jobId`:

| `type`     | Fields                                                 | Meaning                                                                      |
| ---------- | ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `READY`    | `prepareMs`                                            | cache keyed, search running                                                  |
| `PROGRESS` | `hashesTried`, `elapsedMs`, `hashRate`                 | about every 500 ms, this Worker only                                         |
| `SOLUTION` | `workNonce`, `randomxHash`, `hashesTried`, `elapsedMs` | submit `workNonce` to `/v1/work/verify`                                      |
| `ERROR`    | `code`, `message`                                      | `INVALID_START`, `PARAMETERS_MISMATCH`, `CHALLENGE_EXPIRED`, `ENGINE_FAILED` |

- One Worker runs one job. Cancel by calling `terminate()`; start a new
  Worker for the next job.
- Run several Workers to use several cores: Worker `i` of `N` gets
  `startNonce: String(i)` and `stride: N`, exactly like the native worker.
  Terminate them all on the first `SOLUTION`.
- Each Worker holds its own 256 MiB cache and needs no `SharedArrayBuffer`,
  so the page does not need cross-origin isolation. A sensible count is
  `min(navigator.hardwareConcurrency - 1, 4)`, lower on small-memory devices.
- The Worker fetches nothing; `wasmBytes` is the only code it runs besides
  itself.

Measured in headless Chromium 149 on a 16-core desktop, at the Epoch 3 Target
(320 expected hashes): 2 workers 5.2 H/s, 4 workers 10.2 H/s, 8 workers
18.6 H/s, about 2.5 H/s per worker.
