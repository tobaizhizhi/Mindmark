import { z } from "zod";
import type {
  AgentToolCall,
  AgentTranscriptEntry,
  ToolCallingModel,
} from "./runtime-types.js";

const ToolCallResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          tool_calls: z
            .array(
              z.object({
                id: z.string().min(1),
                function: z.object({
                  name: z.string().min(1),
                  arguments: z.string(),
                }),
              }),
            )
            .min(1),
        }),
      }),
    )
    .min(1),
});

function transcriptMessages(transcript: AgentTranscriptEntry[]) {
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
      const transient = /status (?:429|5\d\d)\b|fetch failed|econnreset|etimedout/iu.test(
        modelErrorMessage(error),
      );
      if (!transient || input.signal.aborted || attempt === retryDelaysMs.length) throw error;
      await waitForModelRetry(retryDelaysMs[attempt]!, input.signal);
    }
  }
  throw new Error("AI model request retry loop exhausted");
}

export class OpenAICompatibleToolModel implements ToolCallingModel {
  constructor(
    private readonly configuration: {
      apiKey: string;
      model: string;
      baseUrl?: string;
      temperature?: number;
    },
  ) {}

  async nextTool(input: Parameters<ToolCallingModel["nextTool"]>[0]): Promise<AgentToolCall> {
    const baseUrl = (this.configuration.baseUrl ?? "https://api.openai.com/v1").replace(
      /\/$/u,
      "",
    );
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.configuration.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.configuration.model,
        temperature: this.configuration.temperature ?? 0.2,
        parallel_tool_calls: false,
        tool_choice: "required",
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.task },
          ...transcriptMessages(input.transcript),
        ],
        tools: input.tools.map((tool) => ({
          type: "function",
          function: tool,
        })),
      }),
      signal: input.signal,
    });
    if (!response.ok) {
      throw new Error(`AI model request failed with status ${response.status}`);
    }

    const parsed = ToolCallResponseSchema.parse(await response.json());
    const toolCall = parsed.choices[0]!.message.tool_calls[0]!;
    let argumentsValue: unknown;
    try {
      argumentsValue = JSON.parse(toolCall.function.arguments) as unknown;
    } catch {
      throw new Error("AI model returned invalid tool arguments JSON");
    }
    return {
      id: toolCall.id,
      name: toolCall.function.name,
      arguments: argumentsValue,
    };
  }
}
