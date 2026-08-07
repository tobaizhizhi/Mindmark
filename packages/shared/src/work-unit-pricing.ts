import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { z } from "zod";
import type { CardBlueprintSlotType } from "./card-blueprint.js";
import { MAX_PROJECT_WORK_UNITS } from "./project-v2.js";
import { Bytes32Schema } from "./schemas.js";

export const WORK_UNIT_PRICING_POLICY_VERSION = "work-unit-pricing-v1";

export const WorkUnitRewardTierSchema = z.enum(["S", "M", "L", "XL"]);
export type WorkUnitRewardTier = z.infer<typeof WorkUnitRewardTierSchema>;

export type WorkUnitPricingInput = {
  workUnitId: number;
  sourceCharacterCount: number;
  slots: Array<{
    type: CardBlueprintSlotType;
    difficulty: number;
  }>;
};

export type WorkUnitRewardQuote = {
  workUnitId: number;
  workloadScore: number;
  rewardTier: WorkUnitRewardTier;
  rewardAmountWei: bigint;
  pricingPolicyVersion: typeof WORK_UNIT_PRICING_POLICY_VERSION;
};

const TYPE_POINTS: Record<CardBlueprintSlotType, number> = {
  concept: 1,
  comparison: 2,
  process: 2,
  application: 3,
  misconception: 3,
};

const TIER_BASIS_POINTS: Record<WorkUnitRewardTier, bigint> = {
  S: 8_000n,
  M: 12_000n,
  L: 18_000n,
  XL: 25_000n,
};

const tierForScore = (score: number): WorkUnitRewardTier => {
  if (score <= 12) return "S";
  if (score <= 24) return "M";
  if (score <= 40) return "L";
  return "XL";
};

export function quoteWorkUnitRewards(
  rawInputs: WorkUnitPricingInput[],
  baseRewardWei: bigint,
): WorkUnitRewardQuote[] {
  if (baseRewardWei <= 0n) throw new RangeError("baseRewardWei must be positive");
  if (rawInputs.length < 1 || rawInputs.length > MAX_PROJECT_WORK_UNITS) {
    throw new RangeError(`Pricing requires 1 to ${MAX_PROJECT_WORK_UNITS} Work Units`);
  }
  const inputs = [...rawInputs].sort((left, right) => left.workUnitId - right.workUnitId);
  if (inputs.some((input, index) => input.workUnitId !== index)) {
    throw new Error("Work Unit pricing inputs must have contiguous IDs");
  }
  return inputs.map((input) => {
    if (!Number.isInteger(input.sourceCharacterCount) || input.sourceCharacterCount < 1) {
      throw new RangeError("Work Unit sourceCharacterCount must be positive");
    }
    if (input.slots.length < 1 || input.slots.length > 8) {
      throw new RangeError("Work Unit pricing requires 1 to 8 Blueprint Slots");
    }
    const evidencePoints = Math.min(8, Math.max(1, Math.ceil(input.sourceCharacterCount / 2_000)));
    const slotPoints = input.slots.reduce((total, slot) => {
      if (!Number.isInteger(slot.difficulty) || slot.difficulty < 1 || slot.difficulty > 5) {
        throw new RangeError("Blueprint Slot difficulty must be between 1 and 5");
      }
      return total + TYPE_POINTS[slot.type] + Math.ceil(slot.difficulty / 2);
    }, 0);
    const workloadScore = evidencePoints + slotPoints;
    const rewardTier = tierForScore(workloadScore);
    const rewardAmountWei = (baseRewardWei * TIER_BASIS_POINTS[rewardTier] + 9_999n) / 10_000n;
    if (rewardAmountWei <= 0n) throw new RangeError("Quoted Work Unit reward rounded to zero");
    return {
      workUnitId: input.workUnitId,
      workloadScore,
      rewardTier,
      rewardAmountWei,
      pricingPolicyVersion: WORK_UNIT_PRICING_POLICY_VERSION,
    };
  });
}

export function hashWorkUnitPricingV1(projectId: Hex, rewardAmountsWei: bigint[]): Hex {
  if (rewardAmountsWei.length < 1 || rewardAmountsWei.length > MAX_PROJECT_WORK_UNITS) {
    throw new RangeError(`Pricing commitment requires 1 to ${MAX_PROJECT_WORK_UNITS} rewards`);
  }
  const uint128Max = (1n << 128n) - 1n;
  if (rewardAmountsWei.some((amount) => amount <= 0n || amount > uint128Max)) {
    throw new RangeError("Pricing commitment rewards must fit positive uint128 values");
  }
  return Bytes32Schema.parse(keccak256(encodeAbiParameters(
    [{ type: "string" }, { type: "bytes32" }, { type: "uint128[]" }],
    [
      "MINDMARK_WORK_UNIT_PRICING_V1",
      Bytes32Schema.parse(projectId),
      rewardAmountsWei,
    ],
  )));
}
