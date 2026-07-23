import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { runJourneyDeletion } from "@/lib/client/deletion";

const txHash = `0x${"aa".repeat(32)}` as Hex;

describe("client Journey deletion orchestration", () => {
  it("opens the wallet before any server preflight for an active Journey", async () => {
    const calls: string[] = [];
    const phases: string[] = [];

    await runJourneyDeletion({
      status: "FAILED_RETRYABLE",
      cancelOnMonad: async () => {
        calls.push("wallet");
        return txHash;
      },
      deleteFromServer: async (cancellationTxHash) => {
        calls.push(`server:${cancellationTxHash ?? "none"}`);
      },
      isCancellationRequired: () => false,
      onPhase: (phase) => phases.push(phase),
    });

    expect(calls).toEqual(["wallet", `server:${txHash}`]);
    expect(phases).toEqual(["cancelling", "deleting"]);
  });

  it("deletes a completed Journey without opening the wallet", async () => {
    const calls: string[] = [];

    await runJourneyDeletion({
      status: "READY",
      cancelOnMonad: async () => {
        calls.push("wallet");
        return txHash;
      },
      deleteFromServer: async () => {
        calls.push("server");
      },
      isCancellationRequired: () => false,
      onPhase: () => undefined,
    });

    expect(calls).toEqual(["server"]);
  });
});
