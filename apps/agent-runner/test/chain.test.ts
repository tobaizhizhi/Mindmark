import { describe, expect, it } from "vitest";
import { splitInclusiveBlockRange } from "../src/chain.js";

describe("Monad event replay ranges", () => {
  it("covers the inclusive range without querying more than 100 blocks at once", () => {
    const ranges = splitInclusiveBlockRange(1_000n, 1_250n, 100n);

    expect(ranges).toEqual([
      { fromBlock: 1_000n, toBlock: 1_099n },
      { fromBlock: 1_100n, toBlock: 1_199n },
      { fromBlock: 1_200n, toBlock: 1_250n },
    ]);
    expect(
      ranges.every((range) => range.toBlock - range.fromBlock + 1n <= 100n),
    ).toBe(true);
  });

  it("returns no ranges when the deployment block is ahead of the current block", () => {
    expect(splitInclusiveBlockRange(101n, 100n, 100n)).toEqual([]);
  });
});
