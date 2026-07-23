import type { Hex } from "viem";

export type JourneyDeletionPhase = "checking" | "cancelling" | "deleting";

const immediatelyCancellableStatuses = new Set([
  "CREATED",
  "GENERATING",
  "FINALIZING",
  "FAILED_RETRYABLE",
]);

export async function runJourneyDeletion(input: {
  status: string;
  cancelOnMonad: () => Promise<Hex>;
  deleteFromServer: (cancellationTxHash?: Hex) => Promise<unknown>;
  isCancellationRequired: (error: unknown) => boolean;
  onPhase: (phase: JourneyDeletionPhase) => void;
}): Promise<void> {
  if (immediatelyCancellableStatuses.has(input.status)) {
    input.onPhase("cancelling");
    const cancellationTxHash = await input.cancelOnMonad();
    input.onPhase("deleting");
    await input.deleteFromServer(cancellationTxHash);
    return;
  }

  input.onPhase("checking");
  try {
    await input.deleteFromServer();
  } catch (error) {
    if (!input.isCancellationRequired(error)) throw error;
    input.onPhase("cancelling");
    const cancellationTxHash = await input.cancelOnMonad();
    input.onPhase("deleting");
    await input.deleteFromServer(cancellationTxHash);
  }
}
