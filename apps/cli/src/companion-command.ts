import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { availableParallelism, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMPANION_DEFAULT_ORIGINS,
  COMPANION_DEFAULT_PORT,
  createCompanionServer,
} from "./companion.js";
import type { ParsedArguments } from "./commands.js";
import { RealRandomXMiner } from "./randomx-miner.js";
import { loadAgentManifest, verifyWorkerIntegrity } from "./trust.js";

/**
 * `arcals companion start | status | stop`: runs the local Compute Companion
 * that the Arcals website uses for browser-wallet Mint.
 */

interface CompanionRecord {
  readonly pid: number;
  readonly port: number;
  readonly startedAt: string;
}

interface CompanionEnvelope {
  readonly ok: boolean;
  readonly schemaVersion: "1";
  readonly command: string;
  readonly state: string;
  readonly data: Record<string, unknown>;
  readonly error: { readonly code: string; readonly message: string } | null;
}

function arcalsHome(): string {
  return process.env.ARCALS_HOME ?? join(homedir(), ".arcals");
}

function recordPath(): string {
  return join(arcalsHome(), "companion.json");
}

function logPath(): string {
  return join(arcalsHome(), "companion.log");
}

/** The production manifest shipped at the root of the Agent repository. */
function defaultManifestPath(): string {
  return fileURLToPath(
    new URL("../../../manifests/arc-mainnet.json", import.meta.url),
  );
}

function port(parsed: ParsedArguments, fallback: number): number {
  const value = parsed.values["--port"];
  if (value === undefined) return fallback;
  const parsedPort = Number(value);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    throw new RangeError("--port must be a TCP port");
  }
  return parsedPort;
}

function threads(parsed: ParsedArguments): number {
  const value = parsed.values["--threads"];
  if (value === undefined)
    return Math.max(1, Math.min(4, availableParallelism()));
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 256) {
    throw new RangeError("--threads must be between 1 and 256");
  }
  return count;
}

function origins(parsed: ParsedArguments): readonly string[] {
  const extra = parsed.values["--origin"];
  if (extra === undefined) return COMPANION_DEFAULT_ORIGINS;
  const added = extra
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  for (const origin of added) {
    if (!/^https?:\/\/[a-z0-9.-]+(?::[0-9]+)?$/iu.test(origin)) {
      throw new RangeError(`--origin ${origin} is not an origin`);
    }
  }
  return [...COMPANION_DEFAULT_ORIGINS, ...added];
}

async function readRecord(): Promise<CompanionRecord | null> {
  try {
    return JSON.parse(await readFile(recordPath(), "utf8")) as CompanionRecord;
  } catch {
    return null;
  }
}

async function health(
  targetPort: number,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(
      `http://127.0.0.1:${targetPort.toString()}/health`,
      { signal: AbortSignal.timeout(2_000) },
    );
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function envelope(
  command: string,
  state: string,
  data: Record<string, unknown>,
  error: CompanionEnvelope["error"] = null,
): CompanionEnvelope {
  return {
    ok: error === null,
    schemaVersion: "1",
    command,
    state,
    data,
    error,
  };
}

async function start(parsed: ParsedArguments): Promise<CompanionEnvelope> {
  const listenPort = port(parsed, COMPANION_DEFAULT_PORT);
  const running = await health(listenPort);
  if (running !== null) {
    return envelope("companion.start", "ALREADY_RUNNING", {
      url: `http://127.0.0.1:${listenPort.toString()}`,
      health: running,
    });
  }
  if (parsed.flags.has("--detach")) return detach(parsed, listenPort);

  const manifest = await loadAgentManifest(
    parsed.values["--manifest"] ?? defaultManifestPath(),
  );
  // Downloads the release worker for this platform if needed and refuses any
  // binary whose hash is not the one the manifest names.
  await verifyWorkerIntegrity(manifest);
  const miner = new RealRandomXMiner(manifest.worker.binaryPath);
  const threadCount = threads(parsed);
  const { server, jobs } = createCompanionServer({
    manifest,
    miner,
    threads: threadCount,
    origins: origins(parsed),
    log: (line) =>
      process.stderr.write(`${new Date().toISOString()} ${line}\n`),
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", () => resolve());
  });
  await mkdir(arcalsHome(), { recursive: true, mode: 0o700 });
  await writeFile(
    recordPath(),
    JSON.stringify({
      pid: process.pid,
      port: listenPort,
      startedAt: new Date().toISOString(),
    } satisfies CompanionRecord),
    { mode: 0o600 },
  );
  const url = `http://127.0.0.1:${listenPort.toString()}`;
  process.stderr.write(
    `Arcals Compute Companion listening on ${url} (${threadCount.toString()} threads). Keep this running while you mint; press Ctrl+C to stop.\n`,
  );
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      jobs.cancelAll();
      server.close(() => resolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await miner.close();
  await rm(recordPath(), { force: true });
  return envelope("companion.start", "STOPPED", { url });
}

/** Starts the Companion in the background and waits until it answers. */
async function detach(
  parsed: ParsedArguments,
  listenPort: number,
): Promise<CompanionEnvelope> {
  await mkdir(arcalsHome(), { recursive: true, mode: 0o700 });
  const log = openSync(logPath(), "a", 0o600);
  const args = process.argv
    .slice(1)
    .filter((argument) => argument !== "--detach");
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  child.unref();
  // The first start may download the worker, so allow for that.
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const running = await health(listenPort);
    if (running !== null) {
      return envelope("companion.start", "RUNNING", {
        url: `http://127.0.0.1:${listenPort.toString()}`,
        pid: child.pid ?? null,
        log: logPath(),
        health: running,
      });
    }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return envelope(
    "companion.start",
    "FAILED",
    { log: logPath() },
    {
      code: "COMPANION_START_FAILED",
      message: `The Companion did not start; see ${logPath()}`,
    },
  );
}

async function status(parsed: ParsedArguments): Promise<CompanionEnvelope> {
  const record = await readRecord();
  const targetPort = port(parsed, record?.port ?? COMPANION_DEFAULT_PORT);
  const running = await health(targetPort);
  if (running === null) {
    return envelope("companion.status", "STOPPED", { port: targetPort });
  }
  return envelope("companion.status", "RUNNING", {
    url: `http://127.0.0.1:${targetPort.toString()}`,
    pid: record?.pid ?? null,
    health: running,
  });
}

async function stop(): Promise<CompanionEnvelope> {
  const record = await readRecord();
  if (record === null) {
    return envelope("companion.stop", "STOPPED", {});
  }
  try {
    process.kill(record.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && (await health(record.port)) !== null) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await rm(recordPath(), { force: true });
  return envelope("companion.stop", "STOPPED", { pid: record.pid });
}

export async function runCompanionCommand(
  parsed: ParsedArguments,
): Promise<CompanionEnvelope> {
  const verb = parsed.positionals[1];
  try {
    if (verb === "start") return await start(parsed);
    if (verb === "status") return await status(parsed);
    if (verb === "stop") return await stop();
    throw new Error("usage: arcals companion start | status | stop");
  } catch (error) {
    return envelope(
      `companion.${verb ?? "unknown"}`,
      "FAILED",
      {},
      {
        code: "COMPANION_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
    );
  }
}
