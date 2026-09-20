import { ArcalsApiError } from "@arcals/sdk";
import { describe, expect, it } from "vitest";

import { apiErrorFor, classifyFailure } from "../src/errors.js";

describe("CLI failure classification", () => {
  it("maps known causes to specific stable codes", () => {
    const cases: [string, string][] = [
      [
        "WORKER_PLATFORM_UNSUPPORTED: no build for linux-arm64",
        "WORKER_PLATFORM_UNSUPPORTED",
      ],
      ["WORKER_DOWNLOAD_FAILED: HTTP 502", "WORKER_DOWNLOAD_FAILED"],
      ["WALLET_UNDEPLOYED: no code", "WALLET_UNDEPLOYED"],
      [
        "Request exceeds defined limit.\nDetails: rate limit exceeded",
        "RPC_RATE_LIMITED",
      ],
      ["HTTP request failed. Status: 429", "RPC_RATE_LIMITED"],
      ["database is locked", "LOCAL_LEDGER_BUSY"],
      ["something unexpected", "DEPENDENCY_UNAVAILABLE"],
    ];
    for (const [message, code] of cases) {
      expect(classifyFailure(new Error(message)).code, message).toBe(code);
    }
  });

  it("reports a stale read model as indexer lag", () => {
    const error = new ArcalsApiError(
      503,
      {
        code: "DEPENDENCY_UNAVAILABLE",
        message: "read model is stale",
        retryable: true,
        retryAfterMs: null,
        action: "RETRY_SAME_OPERATION",
        operationId: null,
        details: null,
      },
      {
        environmentId: "5042:0x1",
        asOf: "2026-09-17T00:00:00.000Z",
        indexedBlock: "1",
        indexedBlockHash: null,
        chainTip: "20",
        stale: true,
      },
    );
    const failure = classifyFailure(error);
    expect(failure.code).toBe("INDEXER_LAGGING");
    expect(apiErrorFor(failure)).toMatchObject({
      retryable: true,
      action: "RETRY_SAME_OPERATION",
    });
  });

  it("marks an unsupported worker platform as not retryable", () => {
    expect(
      apiErrorFor(
        classifyFailure(new Error("WORKER_PLATFORM_UNSUPPORTED: darwin-x64")),
      ),
    ).toMatchObject({ retryable: false, action: "CONTACT_SUPPORT" });
  });
});
