// Runs the self-contained browser Worker script under Node worker_threads,
// presenting the Web Worker globals it relies on.
import { readFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

globalThis.WorkerGlobalScope = function WorkerGlobalScope() {};
globalThis.self = globalThis;
globalThis.location = { href: "blob:arcals-test" };
globalThis.postMessage = (message) => parentPort.postMessage(message);
// Evaluate the script the way a Blob module Worker would: one module, no URL.
const source = readFileSync(workerData.scriptPath, "utf8");
await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);
parentPort.on("message", (data) => globalThis.onmessage?.({ data }));
