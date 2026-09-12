import { z } from "zod";
import type { AgentToolCall, ToolCallingModel } from "./runtime-types.js";

const DEFAULT_MAX_COMPLETION_TOKENS = 4096;

const AgentToolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.unknown(),
});

const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    status: z.number().int().nullable(),
    retryable: z.boolean(),
  }),
});

export class AgentRunnerError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number | null,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AgentRunnerError";
  }
}

function modelErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Agent Runner failure";
}

async function nextToolWithAbort(
  model: ToolCallingModel,
  input: Parameters<ToolCallingModel["nextTool"]>[0],
): Promise<Awaited<ReturnType<ToolCallingModel["nextTool"]>>> {
  const abortPromise = new Promise<never>((_, reject) => {
    const rejectWithReason = () => reject(input.signal.reason ?? new Error("Agent Runner request aborted"));
    if (input.signal.aborted) rejectWithReason();
    else input.signal.addEventListener("abort", rejectWithReason, { once: true });
  });
  return Promise.race([model.nextTool(input), abortPromise]);
}

function waitForModelRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("Agent Runner request aborted"));
      return;
    }
    const timeout = setTimeout(resolve, delayMs);
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(signal.reason ?? new Error("Agent Runner request aborted"));
    }, { once: true });
  });
}

export async function nextToolWithTransientRetry(
  model: ToolCallingModel,
  input: Parameters<ToolCallingModel["nextTool"]>[0],
  retryDelaysMs: readonly number[] = [5_000, 15_000],
): Promise<Awaited<ReturnType<ToolCallingModel["nextTool"]>>> {
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return await nextToolWithAbort(model, input);
    } catch (error) {
      const transient = (error instanceof AgentRunnerError && error.retryable)
        || /status (?:429|5\d\d)\b|fetch failed|econnreset|etimedout/iu.test(modelErrorMessage(error));
      if (!transient || input.signal.aborted || attempt === retryDelaysMs.length) throw error;
      await waitForModelRetry(retryDelaysMs[attempt]!, input.signal);
    }
  }
  throw new Error("Agent Runner retry loop exhausted");
}

export class RemoteAgentToolModel implements ToolCallingModel {
  constructor(
    private readonly configuration: {
      baseUrl: string;
      internalToken: string;
      profile: "generation" | "design" | "evaluation";
      timeoutMs?: number;
      maxCompletionTokens?: number;
    },
  ) {}

  async nextTool(input: Parameters<ToolCallingModel["nextTool"]>[0]): Promise<AgentToolCall> {
    const timeoutMs = this.configuration.timeoutMs ?? 120_000;
    const timeoutSignal = AbortSignal.timeout(timeoutMs + 5_000);
    const signal = AbortSignal.any([input.signal, timeoutSignal]);
    let response: Response;
    try {
      response = await fetch(`${this.configuration.baseUrl.replace(/\/$/u, "")}/v1/next-tool`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.configuration.internalToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          profile: this.configuration.profile,
          system: input.system,
          task: input.task,
          tools: input.tools,
          transcript: input.transcript,
          timeout_ms: timeoutMs,
          max_completion_tokens:
            input.maxCompletionTokens
            ?? this.configuration.maxCompletionTokens
            ?? DEFAULT_MAX_COMPLETION_TOKENS,
        }),
        signal,
      });
    } catch (error) {
      if (input.signal.aborted) throw input.signal.reason ?? error;
      throw new AgentRunnerError(
        error instanceof DOMException && error.name === "TimeoutError"
          ? "Agent Runner request timed out"
          : "Agent Runner request failed",
        error instanceof DOMException && error.name === "TimeoutError" ? "timed_out" : "runner_unavailable",
        null,
        true,
      );
    }
    if (!response.ok) {
      try {
        const parsed = ErrorResponseSchema.parse(await response.json());
        throw new AgentRunnerError(
          parsed.error.message,
          parsed.error.code,
          parsed.error.status,
          parsed.error.retryable,
        );
      } catch (error) {
        if (error instanceof AgentRunnerError) throw error;
        throw new AgentRunnerError(
          `Agent Runner request failed with status ${response.status}`,
          "runner_unavailable",
          response.status,
          response.status === 429 || response.status >= 500,
        );
      }
    }
    try {
      return AgentToolCallSchema.parse(await response.json());
    } catch {
      throw new AgentRunnerError(
        "Agent Runner returned an invalid tool call",
        "invalid_response",
        response.status,
        false,
      );
    }
  }
}
