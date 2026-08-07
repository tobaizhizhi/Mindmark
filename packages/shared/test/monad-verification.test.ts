import { describe, expect, it } from "vitest";
import { mossNetworkSupport } from "../src/monad-verification.js";

describe("Moss network policy", () => {
  it("distinguishes official Mainnet from Mindmark experimental Testnet", () => {
    expect(mossNetworkSupport(143)).toBe("OFFICIAL_MAINNET");
    expect(mossNetworkSupport(10143)).toBe("EXPERIMENTAL_TESTNET");
  });

  it("rejects chains outside the reviewed Monad deployment policy", () => {
    expect(() => mossNetworkSupport(1)).toThrow("not approved for chain 1");
  });
});
