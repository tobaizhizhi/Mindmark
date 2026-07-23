import { describe, expect, it } from "vitest";
import { summarizeMeasurements, type TransactionMeasurement } from "../src/benchmark.js";

describe("Step 11 concurrency report", () => {
  it("reports the median and range without deriving TPS", () => {
    const measurements: TransactionMeasurement[] = [100, 300, 200].map((latency, index) => ({
      runId: `run-${index}`,
      mode: "three-wallets",
      sender: `0x${"11".repeat(20)}`,
      nonce: index,
      submittedAt: "2026-07-22T00:00:00.000Z",
      receiptAt: new Date(Date.parse("2026-07-22T00:00:00.000Z") + latency).toISOString(),
      blockNumber: "10",
      gasUsed: "80000",
      status: "success",
    }));
    expect(summarizeMeasurements(measurements, "three-wallets")).toEqual({
      mode: "three-wallets",
      successfulTransactions: 3,
      medianConfirmationMs: 200,
      minConfirmationMs: 100,
      maxConfirmationMs: 300,
    });
    expect(summarizeMeasurements(measurements, "single-wallet").medianConfirmationMs).toBeNull();
  });
});
