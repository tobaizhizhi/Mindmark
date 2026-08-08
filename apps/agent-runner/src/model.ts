import {
  FailoverOpenAICompatibleGateway,
  isRetryableAiGatewayError,
  type AiChatMessage,
  type OpenAICompatibleGatewayConfiguration,
} from "@mindmark/ai-gateway";
import type {
  AgentToolCall,
  AgentTranscriptEntry,
  ToolCallingModel,
} from "./runtime-types.js";

const DEFAULT_MAX_COMPLETION_TOKENS = 4096;

function transcriptMessages(transcript: AgentTranscriptEntry[]): AiChatMessage[] {
  return transcript.flatMap((entry) => [
    {
      role: "assistant" as const,
      content: null,
      tool_calls: [
        {
          id: entry.call.id,
          type: "function" as const,
          function: {
            name: entry.call.name,
            arguments: JSON.stringify(entry.call.arguments),
          },
        },
      ],
    },
    {
      role: "tool" as const,
      tool_call_id: entry.call.id,
      content: JSON.stringify(entry.result),
    },
  ]);
}

function modelErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown AI model failure";
}

async function nextToolWithAbort(
  model: ToolCallingModel,
  input: Parameters<ToolCallingModel["nextTool"]>[0],
): Promise<Awaited<ReturnType<ToolCallingModel["nextTool"]>>> {
  const abortPromise = new Promise<never>((_, reject) => {
    const rejectWithReason = () => reject(input.signal.reason ?? new Error("AI model request aborted"));
    if (input.signal.aborted) rejectWithReason();
    else input.signal.addEventListener("abort", rejectWithReason, { once: true });
  });
  return Promise.race([model.nextTool(input), abortPromise]);
}

function waitForModelRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("AI model request aborted"));
      return;
    }
    const timeout = setTimeout(resolve, delayMs);
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(signal.reason ?? new Error("AI model request aborted"));
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
      const transient = isRetryableAiGatewayError(error)
        || /status (?:429|5\d\d)\b|fetch failed|econnreset|etimedout/iu.test(modelErrorMessage(error));
      if (!transient || input.signal.aborted || attempt === retryDelaysMs.length) throw error;
      await waitForModelRetry(retryDelaysMs[attempt]!, input.signal);
    }
  }
  throw new Error("AI model request retry loop exhausted");
}

export class OpenAICompatibleToolModel implements ToolCallingModel {
  private readonly gateway: FailoverOpenAICompatibleGateway;

  constructor(
    private readonly configuration: {
      apiKey: string;
      model: string;
      baseUrl?: string;
      maxTokensParameter?: "max_completion_tokens" | "max_tokens";
      providerOptions?: Record<string, unknown>;
      fallback?: OpenAICompatibleGatewayConfiguration;
      temperature?: number;
      maxCompletionTokens?: number;
    },
  ) {
    this.gateway = new FailoverOpenAICompatibleGateway({
      primary: {
        apiKey: configuration.apiKey,
        model: configuration.model,
        ...(configuration.baseUrl ? { baseUrl: configuration.baseUrl } : {}),
        ...(configuration.maxTokensParameter
          ? { maxTokensParameter: configuration.maxTokensParameter }
          : {}),
        ...(configuration.providerOptions ? { providerOptions: configuration.providerOptions } : {}),
      },
      ...(configuration.fallback ? { fallback: configuration.fallback } : {}),
    });
  }

  async nextTool(input: Parameters<ToolCallingModel["nextTool"]>[0]): Promise<AgentToolCall> {
    const call = await this.gateway.callTool({
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.task },
        ...transcriptMessages(input.transcript),
      ],
      tools: input.tools,
      signal: input.signal,
      timeoutMs: 600_000,
      temperature: this.configuration.temperature ?? 0.2,
      maxCompletionTokens:
        input.maxCompletionTokens
        ?? this.configuration.maxCompletionTokens
        ?? DEFAULT_MAX_COMPLETION_TOKENS,
      toolChoice: "required",
    });
    if (!call.id) throw new Error("AI model returned a tool call without an id");
    return {
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    };
  }
}
