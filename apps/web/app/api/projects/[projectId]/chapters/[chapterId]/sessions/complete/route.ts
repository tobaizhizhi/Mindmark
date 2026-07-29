import { CompleteProjectSessionRequestSchema } from "@mindmark/shared";
import { requireWalletSession } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { completeChapterSessionForOwner } from "@/lib/server/project-study";

export async function POST(request: Request) {
  try {
    const session = await requireWalletSession();
    const { sessionId } = CompleteProjectSessionRequestSchema.parse(await request.json());
    return Response.json(await completeChapterSessionForOwner(session.address, sessionId));
  } catch (error) {
    return jsonError(error);
  }
}
