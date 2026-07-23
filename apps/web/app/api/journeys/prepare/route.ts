import { PrepareJourneyRequestSchema } from "@mindmark/shared";
import { requireWalletSession } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { prepareJourneyForOwner } from "@/lib/server/journeys";

export async function POST(request: Request) {
  try {
    const session = await requireWalletSession();
    const body = PrepareJourneyRequestSchema.parse(await request.json());
    return Response.json(await prepareJourneyForOwner(body, session.address));
  } catch (error) {
    return jsonError(error);
  }
}

