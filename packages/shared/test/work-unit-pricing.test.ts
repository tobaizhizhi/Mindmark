import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import {
  WORK_UNIT_PRICING_POLICY_VERSION,
  hashWorkUnitPricingV1,
  quoteWorkUnitRewards,
} from "../src/index.js";

const projectId = `0x${"12".repeat(32)}` as Hex;
const baseReward = 1_000_000_000_000_000n;

describe("Work Unit pricing", () => {
  it("quotes deterministic tiers from frozen evidence and Blueprint Slots", () => {
    const quotes = quoteWorkUnitRewards([
      {
        workUnitId: 1,
        sourceCharacterCount: 4_000,
        slots: Array.from({ length: 8 }, () => ({ type: "application" as const, difficulty: 5 })),
      },
      {
        workUnitId: 0,
        sourceCharacterCount: 800,
        slots: [{ type: "concept", difficulty: 1 }],
      },
    ], baseReward);

    expect(quotes).toEqual([
      {
        workUnitId: 0,
        workloadScore: 3,
        rewardTier: "S",
        rewardAmountWei: 800_000_000_000_000n,
        pricingPolicyVersion: WORK_UNIT_PRICING_POLICY_VERSION,
      },
      {
        workUnitId: 1,
        workloadScore: 50,
        rewardTier: "XL",
        rewardAmountWei: 2_500_000_000_000_000n,
        pricingPolicyVersion: WORK_UNIT_PRICING_POLICY_VERSION,
      },
    ]);
    expect(hashWorkUnitPricingV1(projectId, [
      800_000_000_000_000n,
      1_800_000_000_000_000n,
    ]))
      .toBe("0x88e79c46cc0af369c6241b07f2b55e209dd5f7f708397dcbaebc54fa20c8ddf8");
  });

  it("covers every pricing tier with bounded deterministic multipliers", () => {
    const quotes = quoteWorkUnitRewards([
      { workUnitId: 0, sourceCharacterCount: 1, slots: [{ type: "concept", difficulty: 1 }] },
      {
        workUnitId: 1,
        sourceCharacterCount: 1,
        slots: Array.from({ length: 6 }, () => ({ type: "concept" as const, difficulty: 1 })),
      },
      {
        workUnitId: 2,
        sourceCharacterCount: 1,
        slots: Array.from({ length: 8 }, () => ({ type: "concept" as const, difficulty: 5 })),
      },
      {
        workUnitId: 3,
        sourceCharacterCount: 4_000,
        slots: Array.from({ length: 8 }, () => ({ type: "application" as const, difficulty: 5 })),
      },
    ], baseReward);

    expect(quotes.map((quote) => [quote.rewardTier, quote.rewardAmountWei])).toEqual([
      ["S", 800_000_000_000_000n],
      ["M", 1_200_000_000_000_000n],
      ["L", 1_800_000_000_000_000n],
      ["XL", 2_500_000_000_000_000n],
    ]);
  });

  it("rejects missing IDs and self-reported out-of-range difficulty", () => {
    expect(() => quoteWorkUnitRewards([
      { workUnitId: 1, sourceCharacterCount: 1, slots: [{ type: "concept", difficulty: 1 }] },
    ], baseReward)).toThrow(/contiguous IDs/u);
    expect(() => quoteWorkUnitRewards([
      { workUnitId: 0, sourceCharacterCount: 1, slots: [{ type: "concept", difficulty: 6 }] },
    ], baseReward)).toThrow(/difficulty/u);
  });
});
