import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { ArcalsWorkApiClient } from "../src/index.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
});

describe("Arcals API client resilience", () => {
  it("retries a transient 503 and returns the successful response", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL("../../test-fixtures/api/config-local.json", import.meta.url),
        "utf8",
      ),
    ) as { value: unknown };
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      if (requests <= 2) {
        response.statusCode = 503;
        response.end("unavailable");
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(fixture.value));
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as AddressInfo).port;
    const client = new ArcalsWorkApiClient(
      `http://127.0.0.1:${port.toString()}`,
      null,
      1,
    );
    const config = await client.getConfig();
    expect(config).toBeDefined();
    expect(requests).toBe(3);
  });

  it("gives up after bounded attempts on a persistent outage", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.statusCode = 503;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: false }));
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as AddressInfo).port;
    const client = new ArcalsWorkApiClient(
      `http://127.0.0.1:${port.toString()}`,
      null,
      1,
    );
    await expect(client.getConfig()).rejects.toThrow();
    expect(requests).toBe(4);
  });
});
