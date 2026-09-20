import { describe, expect, it } from "vitest";

import {
  ERROR_ACTIONS,
  PROTOCOL_ERRORS,
  isProtocolErrorCode,
} from "../src/index.js";

describe("stable error catalog", () => {
  it("contains every v1 interface error code with a program action", () => {
    expect(Object.keys(PROTOCOL_ERRORS)).toHaveLength(36);
    for (const [code, definition] of Object.entries(PROTOCOL_ERRORS)) {
      expect(isProtocolErrorCode(code)).toBe(true);
      expect(ERROR_ACTIONS).toContain(definition.action);
      expect(definition.httpStatus).toBeGreaterThanOrEqual(200);
      expect(definition.httpStatus).toBeLessThan(600);
    }
  });

  it("does not treat unknown server text as a stable code", () => {
    expect(isProtocolErrorCode("something went wrong")).toBe(false);
  });
});
