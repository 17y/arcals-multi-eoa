import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface WorkerMessage {
  readonly type: string;
  readonly jobId: string;
  readonly data?: Record<string, unknown>;
  readonly error?: { readonly code: string; readonly message: string };
}

interface Waiter {
  readonly types: ReadonlySet<string>;
  readonly resolve: (message: WorkerMessage) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
}

export class WorkerProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkerProtocolError";
  }
}

export class RandomXWorkerClient {
  private readonly child;
  private readonly queues = new Map<string, WorkerMessage[]>();
  private readonly waiters = new Map<string, Waiter[]>();
  private stderr = "";
  private closed = false;

  constructor(readonly binaryPath: string) {
    this.child = spawn(binaryPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line) as WorkerMessage;
        if (
          typeof message.type !== "string" ||
          typeof message.jobId !== "string"
        ) {
          throw new TypeError("worker response lacks type or jobId");
        }
        this.deliver(message);
      } catch (error) {
        this.rejectAll(
          error instanceof Error ? error : new Error("invalid worker JSONL"),
        );
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-4096);
    });
    this.child.once("error", (error) => this.rejectAll(error));
    this.child.once("exit", (code, signal) => {
      this.closed = true;
      if (code !== 0) {
        this.rejectAll(
          new Error(
            `RandomX worker exited code=${String(code)} signal=${String(signal)} diagnostic=${this.stderr}`,
          ),
        );
      }
    });
  }

  send(command: Record<string, unknown>): void {
    if (this.closed || this.child.stdin.destroyed) {
      throw new Error("RandomX worker is closed");
    }
    const serialized = JSON.stringify(command);
    if (
      serialized.includes("\n") ||
      Buffer.byteLength(serialized) > 64 * 1024
    ) {
      throw new RangeError("worker command is not a bounded JSONL record");
    }
    this.child.stdin.write(`${serialized}\n`);
  }

  async request(
    command: Record<string, unknown> & { readonly jobId: string },
    expectedTypes: readonly string[],
    timeoutMs = 30_000,
  ): Promise<WorkerMessage> {
    this.send(command);
    return this.waitFor(command.jobId, expectedTypes, timeoutMs);
  }

  async waitFor(
    jobId: string,
    expectedTypes: readonly string[],
    timeoutMs = 30_000,
  ): Promise<WorkerMessage> {
    const types = new Set([...expectedTypes, "error"]);
    const queued = this.queues.get(jobId);
    const queuedIndex =
      queued?.findIndex((message) => types.has(message.type)) ?? -1;
    if (queued !== undefined && queuedIndex >= 0) {
      const [message] = queued.splice(queuedIndex, 1);
      if (message === undefined)
        throw new Error("worker queue invariant failed");
      return this.unwrap(message);
    }
    return new Promise<WorkerMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const list = this.waiters.get(jobId) ?? [];
        this.waiters.set(
          jobId,
          list.filter((candidate) => candidate !== waiter),
        );
        reject(new Error(`timed out waiting for RandomX worker job ${jobId}`));
      }, timeoutMs);
      const waiter: Waiter = {
        types,
        timeout,
        resolve: (message) => {
          try {
            resolve(this.unwrap(message));
          } catch (error) {
            reject(error instanceof Error ? error : new Error("worker error"));
          }
        },
        reject,
      };
      const list = this.waiters.get(jobId) ?? [];
      list.push(waiter);
      this.waiters.set(jobId, list);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.child.stdin.end();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.child.kill("SIGKILL");
        reject(
          new Error(
            `RandomX worker did not exit after stdin closed diagnostic=${this.stderr}`,
          ),
        );
      }, 5000);
      this.child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  private deliver(message: WorkerMessage): void {
    const waiters = this.waiters.get(message.jobId) ?? [];
    const index = waiters.findIndex((waiter) => waiter.types.has(message.type));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      if (waiter === undefined)
        throw new Error("worker waiter invariant failed");
      clearTimeout(waiter.timeout);
      waiter.resolve(message);
      return;
    }
    const queue = this.queues.get(message.jobId) ?? [];
    queue.push(message);
    this.queues.set(message.jobId, queue);
  }

  private unwrap(message: WorkerMessage): WorkerMessage {
    if (message.type === "error") {
      throw new WorkerProtocolError(
        message.error?.code ?? "WORKER_ERROR",
        message.error?.message ?? "RandomX worker returned an error",
      );
    }
    return message;
  }

  private rejectAll(error: Error): void {
    for (const list of this.waiters.values()) {
      for (const waiter of list) {
        clearTimeout(waiter.timeout);
        waiter.reject(error);
      }
    }
    this.waiters.clear();
  }
}

/**
 * Where a local build puts the worker. MSVC is a multi-config generator, so on
 * Windows the executable lands in a configuration subdirectory with an .exe
 * suffix; single-config generators write it straight into the build directory.
 */
export function localWorkerBinaryPath(repositoryRoot: string): string {
  const base = `${repositoryRoot.replace(/\/?$/u, "/")}native/randomx-worker/build/`;
  return process.platform === "win32"
    ? `${base}Release/arcals-randomx-worker.exe`
    : `${base}arcals-randomx-worker`;
}
