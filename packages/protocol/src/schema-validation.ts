import { createRequire } from "node:module";

import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";

import { UINT64_MAX, UINT256_MAX } from "./constants.js";
import { assertCanonicalEcdsaSignature } from "./encoding.js";
import { API_SCHEMAS } from "./schemas.js";
import type { ApiSchemaName } from "./schemas.js";

const decimalPattern = /^(0|[1-9][0-9]*)$/u;
const packedPiPattern = /^0x[0-9a-fA-F]{360}$/u;
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020") as typeof Ajv2020Class;
const addFormats =
  require("ajv-formats") as typeof import("ajv-formats").default;

function decimalWithin(value: string, maximum: bigint): boolean {
  return decimalPattern.test(value) && BigInt(value) <= maximum;
}

function validBcd(value: string): boolean {
  if (!packedPiPattern.test(value)) return false;
  return [...value.slice(2)].every((nibble) => nibble >= "0" && nibble <= "9");
}

export function createApiValidator(): Ajv2020Class {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: true,
  });
  addFormats(ajv);
  ajv.addFormat("decimal-uint64", {
    type: "string",
    validate: (value: string) => decimalWithin(value, UINT64_MAX),
  });
  ajv.addFormat("decimal-uint256", {
    type: "string",
    validate: (value: string) => decimalWithin(value, UINT256_MAX),
  });
  ajv.addFormat("ecdsa-signature", {
    type: "string",
    validate: (value: string) => {
      try {
        assertCanonicalEcdsaSignature(value as `0x${string}`);
        return true;
      } catch {
        return false;
      }
    },
  });
  ajv.addFormat("pi-bcd-360", {
    type: "string",
    validate: validBcd,
  });
  return ajv;
}

export function compileApiSchema(name: ApiSchemaName): ValidateFunction {
  const ajv = createApiValidator();
  const definitions = JSON.parse(
    JSON.stringify(API_SCHEMAS).replaceAll("#/components/schemas/", "#/$defs/"),
  ) as Record<string, unknown>;
  return ajv.compile({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $ref: `#/$defs/${name}`,
    $defs: definitions,
  });
}

// Compiling a schema costs milliseconds; the API validates every request, so
// compile each schema once per process. Ajv validators are reusable, and
// `errors` is read synchronously right after the call that set it.
const compiledValidators = new Map<ApiSchemaName, ValidateFunction>();

export function assertApiSchema(name: ApiSchemaName, value: unknown): void {
  let validate = compiledValidators.get(name);
  if (validate === undefined) {
    validate = compileApiSchema(name);
    compiledValidators.set(name, validate);
  }
  if (!validate(value)) {
    throw new TypeError(
      `${name} schema validation failed: ${JSON.stringify(validate.errors)}`,
    );
  }
}
