import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  deleteJourneyForOwner,
  type JourneyCancellationGateway,
  type JourneyDeletionStore,
} from "@/lib/server/deletion";
import type { StoredJourney } from "@/lib/server/journeys";

const journeyId = `0x${"71".repeat(32)}` as Hex;
const owner = `0x${"ab".repeat(20)}` as `0x${string}`;
const cancellationTxHash = `0x${"99".repeat(32)}` as Hex;

function journey(status: string, createTxHash: Hex | null = cancellationTxHash): StoredJourney {
  return {
    journey_id: journeyId,
    learner_address: owner,
    source_hash: `0x${"01".repeat(32)}`,
    goal_hash: `0x${"02".repeat(32)}`,
    chunk_manifest_root: `0x${"03".repeat(32)}`,
    chunk_count: 3,
    status,
    create_tx_hash: createTxHash,
  };
}

class RecordingDeletionStore implements JourneyDeletionStore {
  deleted = false;

  constructor(private readonly row: StoredJourney | null) {}

  async findOwned() {
    return this.row;
  }

  async deleteOwned() {
    this.deleted = true;
    return true;
  }
}

class RecordingCancellationGateway implements JourneyCancellationGateway {
  calls: Array<{ journeyId: Hex; owner: `0x${string}`; txHash?: Hex }> = [];

  async ensureStopped(id: Hex, learner: `0x${string}`, txHash?: Hex) {
    this.calls.push({ journeyId: id, owner: learner, ...(txHash ? { txHash } : {}) });
  }
}

describe("delete Journey service", () => {
  it("deletes a READY project without attempting an impossible chain cancellation", async () => {
    const store = new RecordingDeletionStore(journey("READY"));
    const gateway = new RecordingCancellationGateway();

    const response = await deleteJourneyForOwner(journeyId, owner, undefined, store, gateway);

    expect(response).toEqual({ deleted: true, journeyId, chainRecordRetained: true });
    expect(store.deleted).toBe(true);
    expect(gateway.calls).toHaveLength(0);
  });

  it("requires an active project to be stopped on Monad before database deletion", async () => {
    const store = new RecordingDeletionStore(journey("GENERATING"));
    const gateway = new RecordingCancellationGateway();

    await deleteJourneyForOwner(journeyId, owner, cancellationTxHash, store, gateway);

    expect(gateway.calls).toEqual([{ journeyId, owner, txHash: cancellationTxHash }]);
    expect(store.deleted).toBe(true);
  });

  it("does not delete when Monad cancellation verification fails", async () => {
    const store = new RecordingDeletionStore(journey("FAILED_RETRYABLE"));
    const gateway: JourneyCancellationGateway = {
      async ensureStopped() {
        throw new Error("cancellation not confirmed");
      },
    };

    await expect(
      deleteJourneyForOwner(journeyId, owner, cancellationTxHash, store, gateway),
    ).rejects.toThrow("cancellation not confirmed");
    expect(store.deleted).toBe(false);
  });
});
