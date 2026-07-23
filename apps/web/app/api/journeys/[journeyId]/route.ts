import { Bytes32Schema } from "@mindmark/shared";
import { z } from "zod";
import { requireWalletSession } from "@/lib/server/auth";
import { deleteJourneyForOwner } from "@/lib/server/deletion";
import { jsonError } from "@/lib/server/http";
import { getJourneyDetailForOwner } from "@/lib/server/learning";

const DeleteJourneyRequestSchema = z
  .object({ cancellationTxHash: Bytes32Schema.optional() })
  .strict();

export async function GET(
  _request: Request,
  context: { params: Promise<{ journeyId: string }> },
) {
  try {
    const session = await requireWalletSession();
    const { journeyId: rawJourneyId } = await context.params;
    return Response.json(
      await getJourneyDetailForOwner(Bytes32Schema.parse(rawJourneyId), session.address),
    );
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ journeyId: string }> },
) {
  try {
    const session = await requireWalletSession();
    const { journeyId: rawJourneyId } = await context.params;
    const body = DeleteJourneyRequestSchema.parse(await request.json().catch(() => ({})));
    return Response.json(
      await deleteJourneyForOwner(
        Bytes32Schema.parse(rawJourneyId),
        session.address,
        body.cancellationTxHash,
      ),
    );
  } catch (error) {
    return jsonError(error);
  }
}
