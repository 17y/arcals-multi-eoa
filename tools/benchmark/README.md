# Arcals RandomX tools

`@arcals/randomx-tools` is the TypeScript orchestration layer for the pinned
[native RandomX worker](../../native/randomx-worker/README.md). It provides:

- a JSONL worker client with bounded requests and cancellation;
- exact integer Target derivation;
- the worker integration vector suite (`src/integration.ts`);
- a local benchmark and a two-Epoch context check.

It never accepts a shell expression and never downloads a binary selected by
an API response.

The benchmark (`src/benchmark.ts`) measures only the machine it runs on. A
local result is not a protocol Target.
