import {
  Bytes32Schema,
  SubmitKnowledgeCardFeedbackRequestSchema,
} from "@mindmark/shared";
import { z } from "zod";
import { requireWalletSession } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import {
  listKnowledgeCardFeedbackForOwner,
  submitKnowledgeCardFeedbackForOwner,
} from "@/lib/server/project-feedback";

const ChapterIdSchema = z.coerce.number().int().min(0).max(15);

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const session = await requireWalletSession();
    const { projectId } = await context.params;
    const query = new URL(request.url).searchParams;
    return Response.json(await listKnowledgeCardFeedbackForOwner(
      Bytes32Schema.parse(projectId),
      session.address,
      {
        ...(query.has("chapterId") ? { chapterId: ChapterIdSchema.parse(query.get("chapterId")) } : {}),
        ...(query.has("cardId") ? { cardId: Bytes32Schema.parse(query.get("cardId")) } : {}),
      },
    ));
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const session = await requireWalletSession();
    const { projectId } = await context.params;
    return Response.json(await submitKnowledgeCardFeedbackForOwner(
      Bytes32Schema.parse(projectId),
      session.address,
      SubmitKnowledgeCardFeedbackRequestSchema.parse(await request.json()),
    ), { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
