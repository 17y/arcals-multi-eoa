import { describe, expect, it } from "vitest";
import { toFunctionSelector } from "viem";

import {
  arcalMirrorAbi,
  arcalsCoreAbi,
  arcalsVaultAbi,
  mintControllerAbi,
} from "../src/index.js";

function names(
  abi: readonly { readonly type: string; readonly name?: string }[],
  type: string,
) {
  return abi.filter((item) => item.type === type).map((item) => item.name);
}

describe("generated contract ABI", () => {
  it("contains the frozen issue, content, and conversion entry points", () => {
    expect(names(arcalsCoreAbi, "function")).toContain("issue");
    expect(names(arcalMirrorAbi, "function")).toContain("registerContent");
    expect(names(arcalsVaultAbi, "function")).toEqual(
      expect.arrayContaining([
        "liquify",
        "reform",
        "activateConversions",
        "circulatingSupply",
      ]),
    );
    expect(names(mintControllerAbi, "function")).toContain("mint");
    expect(names(mintControllerAbi, "function")).toContain("mintEncoded");
    expect(names(arcalMirrorAbi, "event")).toEqual(
      expect.arrayContaining(["MetadataUpdate", "BatchMetadataUpdate"]),
    );
  });

  it("does not expose burn, reserve withdrawal, or arbitrary execution", () => {
    for (const abi of [
      arcalsCoreAbi,
      arcalMirrorAbi,
      arcalsVaultAbi,
      mintControllerAbi,
    ]) {
      const functions = names(abi, "function");
      expect(functions).not.toEqual(
        expect.arrayContaining([
          "burn",
          "recoverToken",
          "withdrawReserve",
          "execute",
        ]),
      );
    }
  });

  it("freezes selectors for the three main user actions", () => {
    expect(
      toFunctionSelector(
        "mint((uint32,bytes32,bytes32,uint64,address,uint256,bytes32,uint256,uint64,uint64,uint64),bytes,(uint32,bytes32,uint64,bytes32,uint64,uint64,uint64),bytes)",
      ),
    ).toBe("0x88e832cc");
    expect(toFunctionSelector("liquify(uint256,address,uint64)")).toBe(
      "0x07dff18d",
    );
    expect(toFunctionSelector("reform(address,uint256,uint64)")).toBe(
      "0x7e831ac5",
    );
  });
});
