import { readFile, readdir } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { decodeEventLog } from "viem";

import {
  arcalMirrorAbi,
  arcalsCoreAbi,
  arcalsVaultAbi,
  mintControllerAbi,
  revenueTreasuryAbi,
} from "../src/index.js";

const fixtureDirectory = new URL(
  "../../test-fixtures/events/",
  import.meta.url,
);
const abiByContract = {
  core: arcalsCoreAbi,
  controller: mintControllerAbi,
  mirror: arcalMirrorAbi,
  vault: arcalsVaultAbi,
  treasury: revenueTreasuryAbi,
} as const;

function normalize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/u.test(value)) {
    return value.toLowerCase();
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalize(item)]),
    );
  }
  return value;
}

describe("generated event fixtures", () => {
  it("decodes every event through its generated ABI", async () => {
    const names = (await readdir(fixtureDirectory)).filter((name) =>
      name.endsWith(".json"),
    );
    expect(names).toHaveLength(13);
    for (const name of names) {
      const fixture = JSON.parse(
        await readFile(new URL(name, fixtureDirectory), "utf8"),
      ) as {
        contract: keyof typeof abiByContract;
        eventName: string;
        topics: [`0x${string}`, ...`0x${string}`[]];
        data: `0x${string}`;
        args: Record<string, unknown>;
      };
      const decoded = decodeEventLog({
        abi: abiByContract[fixture.contract],
        eventName: fixture.eventName as never,
        topics: fixture.topics,
        data: fixture.data,
        strict: true,
      } as never) as unknown as { eventName: string; args: unknown };
      expect(decoded.eventName).toBe(fixture.eventName);
      expect(normalize(decoded.args)).toEqual(fixture.args);
    }
  });
});
