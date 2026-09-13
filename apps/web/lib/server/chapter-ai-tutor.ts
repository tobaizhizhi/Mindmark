import {
  AskChapterTutorRequestSchema,
  AskChapterTutorResponseSchema,
  type AskChapterTutorRequest,
  type AskChapterTutorResponse,
  type ChapterReadingResponse,
} from "@mindmark/shared";
import { z } from "zod";
import type { Hex } from "viem";
import { ApiError } from "./http";
import { getChapterReadingForOwner } from "./project-reading";

const MODEL_TIMEOUT_MS = 45_000;

const AiTutorEnvironmentSchema = z.object({
  AGENT_RUNNER_URL: z.string().url(),
  AGENT_RUNNER_INTERNAL_TOKEN: z.string().min(16),
});

const RunnerErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    status: z.number().int().nullable(),
    retryable: z.boolean(),
  }),
});

const RunnerTutorResponseSchema = z.object({
  response: AskChapterTutorResponseSchema,
  prompt_version: z.literal("chapter-tutor-langgraph-v1"),
});

const RunnerTutorStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("answer_delta"), delta: z.string().min(1) }),
  z.object({
    type: z.literal("result"),
    response: AskChapterTutorResponseSchema,
    prompt_version: z.literal("chapter-tutor-langgraph-v1"),
  }),
  z.object({ type: z.literal("error"), error: RunnerErrorSchema.shape.error }),
]);

export type ChapterTutorModelInput = {
  question: string;
  currentPage: number | null;
  selectedText: string | null;
  history: AskChapterTutorRequest["history"];
  reading: ChapterReadingResponse;
  signal?: AbortSignal;
};

export type ChapterTutorModelStreamEvent =
  | { type: "answer_delta"; delta: string }
  | { type: "result"; response: AskChapterTutorResponse };

export interface ChapterTutorModel {
  answer(input: ChapterTutorModelInput): Promise<AskChapterTutorResponse>;
  streamAnswer?(input: ChapterTutorModelInput): AsyncIterable<ChapterTutorModelStreamEvent>;
}

type AskChapterTutorDependencies = {
  model?: ChapterTutorModel;
  loadReading?: (
    projectId: Hex,
    chapterId: number,
    owner: `0x${string}`,
  ) => Promise<ChapterReadingResponse>;
  signal?: AbortSignal;
};

class TutorAgentError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "TutorAgentError";
  }
}

function groundedQuote(source: string, proposed: string): string {
  const trimmed = proposed.trim();
  if (trimmed && source.includes(trimmed)) return trimmed.slice(0, 500);
  return source.trim().slice(0, 500);
}

function normalizeTutorResponse(
  response: AskChapterTutorResponse,
  reading: ChapterReadingResponse,
): AskChapterTutorResponse {
  const blocks = new Map(reading.blocks.map((block) => [block.blockId, block]));
  const seen = new Set<string>();
  const citations = response.citations.flatMap((citation) => {
    const block = blocks.get(citation.blockId);
    if (!block || seen.has(block.blockId)) return [];
    seen.add(block.blockId);
    return [{
      blockId: block.blockId,
      pageNumber: block.pageNumber,
      quote: groundedQuote(block.text, citation.quote),
    }];
  }).slice(0, 6);
  const normalizedResponse = AskChapterTutorResponseSchema.safeParse({
    answer: response.answer,
    citations,
    suggestedQuestions: [...new Set(response.suggestedQuestions)].slice(0, 3),
  });
  if (!normalizedResponse.success) {
    throw new ApiError(502, "ai_tutor_invalid_response", "AI 导师返回了无法解析的回答");
  }
  return normalizedResponse.data;
}

function tutorModelError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof TutorAgentError) {
    if (error.code === "timed_out" || error.code === "aborted") {
      return new ApiError(504, "ai_tutor_timed_out", "AI 导师响应超时，请重试");
    }
    if (error.code === "rate_limited") {
      return new ApiError(429, "ai_tutor_rate_limited", "AI 导师请求过于频繁，请稍后再试");
    }
    if (error.code === "invalid_response") {
      return new ApiError(502, "ai_tutor_invalid_response", "AI 导师返回了无法解析的回答");
    }
    return new ApiError(502, "ai_tutor_model_failed", error.status
      ? `AI 导师暂时不可用（模型状态 ${error.status}）`
      : "AI 导师暂时无法连接模型服务");
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return new ApiError(502, "ai_tutor_invalid_response", "AI 导师返回了无法解析的回答");
  }
  return new ApiError(502, "ai_tutor_model_failed", "AI 导师暂时无法连接模型服务");
}

async function runnerResponseError(response: Response): Promise<TutorAgentError> {
  try {
    const parsed = RunnerErrorSchema.parse(await response.json());
    return new TutorAgentError(
      parsed.error.message,
      parsed.error.code,
      parsed.error.status,
      parsed.error.retryable,
    );
  } catch {
    return new TutorAgentError(
      `Agent Runner request failed with status ${response.status}`,
      response.status === 401 ? "unauthorized" : "runner_unavailable",
      response.status,
      response.status === 429 || response.status >= 500,
    );
  }
}

function runnerRequestBody(input: ChapterTutorModelInput): string {
  return JSON.stringify({
    question: input.question,
    currentPage: input.currentPage,
    selectedText: input.selectedText,
    history: input.history,
    reading: {
      title: input.reading.title,
      blocks: input.reading.blocks.map((block) => ({
        blockId: block.blockId,
        position: block.position,
        kind: block.kind,
        text: block.text,
        pageNumber: block.pageNumber,
      })),
    },
    timeout_ms: MODEL_TIMEOUT_MS,
    max_completion_tokens: 1_600,
  });
}

export class AgentRunnerChapterTutorModel implements ChapterTutorModel {
  constructor(private readonly configuration: {
    baseUrl: string;
    internalToken: string;
  }) {}

  private endpoint(path: string): string {
    return `${this.configuration.baseUrl.replace(/\/$/u, "")}${path}`;
  }

  private headers(accept?: string): Record<string, string> {
    return {
      Authorization: `Bearer ${this.configuration.internalToken}`,
      "Content-Type": "application/json",
      ...(accept ? { Accept: accept } : {}),
    };
  }

  private signal(input: ChapterTutorModelInput): AbortSignal {
    const timeout = AbortSignal.timeout(MODEL_TIMEOUT_MS + 5_000);
    return input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  }

  async answer(input: ChapterTutorModelInput): Promise<AskChapterTutorResponse> {
    try {
      const response = await fetch(this.endpoint("/v1/chapter-tutor/answers"), {
        method: "POST",
        headers: this.headers(),
        body: runnerRequestBody(input),
        signal: this.signal(input),
      });
      if (!response.ok) throw await runnerResponseError(response);
      return RunnerTutorResponseSchema.parse(await response.json()).response;
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw tutorModelError(new TutorAgentError("Agent Runner timed out", "timed_out", null, true));
      }
      throw tutorModelError(error);
    }
  }

  async *streamAnswer(input: ChapterTutorModelInput): AsyncGenerator<ChapterTutorModelStreamEvent> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      const response = await fetch(this.endpoint("/v1/chapter-tutor/answers/stream"), {
        method: "POST",
        headers: this.headers("text/event-stream"),
        body: runnerRequestBody(input),
        signal: this.signal(input),
      });
      if (!response.ok) throw await runnerResponseError(response);
      if (!response.body) {
        throw new TutorAgentError("Agent Runner returned an empty stream", "invalid_response", 200, false);
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let dataLines: string[] = [];
      let completed = false;
      const processLine = (line: string) => {
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /u, ""));
          return null;
        }
        if (line !== "" || dataLines.length === 0) return null;
        const event = RunnerTutorStreamEventSchema.parse(JSON.parse(dataLines.join("\n")));
        dataLines = [];
        return event;
      };
      while (true) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
        const lines = buffer.split("\n");
        buffer = chunk.done ? "" : (lines.pop() ?? "");
        for (const rawLine of lines) {
          const event = processLine(rawLine.replace(/\r$/u, ""));
          if (!event) continue;
          if (event.type === "error") {
            throw new TutorAgentError(
              event.error.message,
              event.error.code,
              event.error.status,
              event.error.retryable,
            );
          }
          if (event.type === "answer_delta") {
            yield event;
            continue;
          }
          completed = true;
          yield { type: "result", response: event.response };
        }
        if (chunk.done) break;
      }
      if (buffer.trim() || dataLines.length > 0 || !completed) {
        throw new TutorAgentError("Agent Runner returned an incomplete stream", "invalid_response", 200, false);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw tutorModelError(new TutorAgentError("Agent Runner timed out", "timed_out", null, true));
      }
      throw tutorModelError(error);
    } finally {
      await reader?.cancel().catch(() => undefined);
    }
  }
}

function modelFromEnvironment(): ChapterTutorModel {
  const parsed = AiTutorEnvironmentSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new ApiError(503, "ai_tutor_not_configured", "AI 导师尚未配置模型服务");
  }
  return new AgentRunnerChapterTutorModel({
    baseUrl: parsed.data.AGENT_RUNNER_URL,
    internalToken: parsed.data.AGENT_RUNNER_INTERNAL_TOKEN,
  });
}

async function prepareChapterTutor(
  projectId: Hex,
  chapterId: number,
  owner: `0x${string}`,
  rawRequest: AskChapterTutorRequest,
  dependencies: AskChapterTutorDependencies,
): Promise<{ input: ChapterTutorModelInput; reading: ChapterReadingResponse }> {
  const request = AskChapterTutorRequestSchema.parse(rawRequest);
  const loadReading = dependencies.loadReading ?? getChapterReadingForOwner;
  const reading = await loadReading(projectId, chapterId, owner);
  if (!reading.blocks.some((block) => block.text.trim())) {
    throw new ApiError(404, "tutor_context_not_available", "当前章节没有可供 AI 阅读的正文");
  }
  return {
    reading,
    input: {
      question: request.question,
      currentPage: request.currentPage ?? null,
      selectedText: request.selectedText ?? null,
      history: request.history,
      reading,
      ...(dependencies.signal ? { signal: dependencies.signal } : {}),
    },
  };
}

export async function askChapterTutorForOwner(
  projectId: Hex,
  chapterId: number,
  owner: `0x${string}`,
  rawRequest: AskChapterTutorRequest,
  dependencies: AskChapterTutorDependencies = {},
): Promise<AskChapterTutorResponse> {
  const prepared = await prepareChapterTutor(projectId, chapterId, owner, rawRequest, dependencies);
  const response = await (dependencies.model ?? modelFromEnvironment()).answer(prepared.input);
  return normalizeTutorResponse(response, prepared.reading);
}

export async function* streamChapterTutorForOwner(
  projectId: Hex,
  chapterId: number,
  owner: `0x${string}`,
  rawRequest: AskChapterTutorRequest,
  dependencies: AskChapterTutorDependencies = {},
): AsyncGenerator<ChapterTutorModelStreamEvent> {
  const prepared = await prepareChapterTutor(projectId, chapterId, owner, rawRequest, dependencies);
  const model = dependencies.model ?? modelFromEnvironment();
  if (!model.streamAnswer) {
    const response = normalizeTutorResponse(await model.answer(prepared.input), prepared.reading);
    yield { type: "answer_delta", delta: response.answer };
    yield { type: "result", response };
    return;
  }
  for await (const event of model.streamAnswer(prepared.input)) {
    if (event.type === "answer_delta") {
      yield event;
      continue;
    }
    yield { type: "result", response: normalizeTutorResponse(event.response, prepared.reading) };
  }
}
