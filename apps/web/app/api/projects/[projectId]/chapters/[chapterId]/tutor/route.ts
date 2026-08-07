import {
  AiTutorStreamEventSchema,
  AskChapterTutorRequestSchema,
  Bytes32Schema,
  type AiTutorStreamEvent,
} from "@mindmark/shared";
import { z } from "zod";
import { requireWalletSession } from "@/lib/server/auth";
import { ApiError, jsonError } from "@/lib/server/http";
import {
  askChapterTutorForOwner,
  streamChapterTutorForOwner,
} from "@/lib/server/chapter-ai-tutor";

const ChapterIdSchema = z.coerce.number().int().min(0).max(15);

const tutorRateBuckets = new Map<string, { startedAt: number; count: number }>();
const TUTOR_RATE_WINDOW_MS = 60_000;
const TUTOR_RATE_LIMIT = 12;
const sseEncoder = new TextEncoder();

function assertTutorRateLimit(address: `0x${string}`): void {
  const now = Date.now();
  const existing = tutorRateBuckets.get(address);
  if (!existing || now - existing.startedAt >= TUTOR_RATE_WINDOW_MS) {
    tutorRateBuckets.set(address, { startedAt: now, count: 1 });
    return;
  }
  if (existing.count >= TUTOR_RATE_LIMIT) {
    throw new ApiError(429, "ai_tutor_rate_limited", "AI 导师请求过于频繁，请稍后再试");
  }
  existing.count += 1;
}

function encodedSseEvent(event: AiTutorStreamEvent): Uint8Array {
  return sseEncoder.encode(`data: ${JSON.stringify(AiTutorStreamEventSchema.parse(event))}\n\n`);
}

function tutorSseStream(source: AsyncIterable<AiTutorStreamEvent>): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(encodedSseEvent(next.value));
      } catch (error) {
        const response = jsonError(error);
        const body = await response.json() as { error?: { code?: string; message?: string } };
        controller.enqueue(encodedSseEvent({
          type: "error",
          code: body.error?.code ?? "internal_error",
          message: body.error?.message ?? "The request could not be completed",
        }));
        controller.close();
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string; chapterId: string }> },
) {
  try {
    const session = await requireWalletSession();
    assertTutorRateLimit(session.address);
    const params = await context.params;
    const body = AskChapterTutorRequestSchema.parse(await request.json());
    const projectId = Bytes32Schema.parse(params.projectId);
    const chapterId = ChapterIdSchema.parse(params.chapterId);
    if (request.headers.get("accept")?.includes("text/event-stream")) {
      const events = streamChapterTutorForOwner(
        projectId,
        chapterId,
        session.address,
        body,
        { signal: request.signal },
      );
      return new Response(tutorSseStream(events), {
        headers: {
          "Cache-Control": "private, no-cache, no-transform",
          "Content-Type": "text/event-stream; charset=utf-8",
          "X-Accel-Buffering": "no",
        },
      });
    }
    const response = await askChapterTutorForOwner(
      projectId,
      chapterId,
      session.address,
      body,
      { signal: request.signal },
    );
    return Response.json(response, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
