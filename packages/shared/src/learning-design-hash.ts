import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { Bytes32Schema } from "./schemas.js";

export function hashFrozenProjectDesignV3(input: {
  projectId: Hex;
  outlineVersion: number;
  designs: Array<{ chapterId: number; inventoryHash: Hex; blueprintHash: Hex }>;
}): Hex {
  if (!Number.isInteger(input.outlineVersion) || input.outlineVersion < 1) {
    throw new RangeError("outlineVersion must be positive");
  }
  const designs = [...input.designs].sort((left, right) => left.chapterId - right.chapterId);
  if (designs.length === 0 || designs.some((design, index) =>
    !Number.isInteger(design.chapterId) || design.chapterId !== index,
  )) {
    throw new Error("frozen Project design must contain contiguous Chapter designs");
  }
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "bytes32" },
        { type: "uint32" },
        { type: "bytes32[]" },
        { type: "bytes32[]" },
      ],
      [
        "MINDMARK_FROZEN_PROJECT_DESIGN_V3",
        Bytes32Schema.parse(input.projectId),
        input.outlineVersion,
        designs.map((design) => Bytes32Schema.parse(design.inventoryHash)),
        designs.map((design) => Bytes32Schema.parse(design.blueprintHash)),
      ],
    ),
  );
}
