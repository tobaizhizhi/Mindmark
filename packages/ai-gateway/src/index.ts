import { z } from "zod";

const ToolCallResponseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      tool_calls: z.array(z.object({
        id: z.string().min(1).optional(),
        function: z.object({
          name: z.string().min(1),
          arguments: z.string(),
        }),
      })).min(1),
    }),
  })).min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional(),
  }).optional(),
});

const ToolCallStreamChunkSchema = z.object({
  choices: z.array(z.object({
    delta: z.object({
      tool_calls: z.array(z.object({
        index: z.number().int().nonnegative(),
        id: z.string().nullable().optional(),
        function: z.object({
          name: z.string().nullable().optional(),
          arguments: z.string().nullable().optional(),
        }).optional(),
      })).optional(),
    }).optional(),
  }).passthrough()).optional(),
  usage: ToolCallResponseSchema.shape.usage.nullable(),
}).passthrough();

export type AiGatewayErrorCode =
  | "aborted"
  | "invalid_response"
  | "model_failed"
  | "rate_limited"
  | "timed_out";

export class AiGatewayError extends Error {
  constructor(
    public readonly code: AiGatewayErrorCode,
    message: string,
    public readonly options: { status: number | null; retryable: boolean },
  ) {
    super(message);
    this.name = "AiGatewayError";
  }

  get status(): number | null {
    return this.options.status;
  }

  get retryable(): boolean {
    return this.options.retryable;
  }
}

export type AiToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type AiChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> }
  | { role: "tool"; tool_call_id: string; content: string };

export type AiGatewayTelemetry = {
  durationMs: number;
  model: string;
  outcome: "success" | "error";
  providerStatus: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
};

export type AiToolCallResult = {
  id: string | null;
  name: string;
  arguments: unknown;
};

export type AiToolCallStreamEvent =
  | { type: "arguments_delta"; delta: string }
  | { type: "result"; result: AiToolCallResult };

export type OpenAICompatibleGatewayConfiguration = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Some OpenAI-compatible providers (including DeepSeek) use max_tokens. */
  maxTokensParameter?: "max_completion_tokens" | "max_tokens";
  /** Provider-specific options that cannot override Mindmark's tool contract. */
  providerOptions?: Record<string, unknown>;
};

export type CallToolInput = {
  messages: AiChatMessage[];
  tools: AiToolDefinition[];
  signal?: AbortSignal;
  timeoutMs: number;
  temperature?: number;
  maxCompletionTokens: number;
  toolChoice?: "required" | { type: "function"; function: { name: string } };
  retryDelaysMs?: readonly number[];
  onTelemetry?: (event: AiGatewayTelemetry) => void;
};

function gatewayErrorForStatus(status: number): AiGatewayError {
  if (status === 429) {
    return new AiGatewayError("rate_limited", "AI model request failed with status 429", {
      status,
      retryable: true,
    });
  }
  return new AiGatewayError("model_failed", `AI model request failed with status ${status}`, {
    status,
    retryable: status >= 500,
  });
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new AiGatewayError("aborted", "AI model request aborted", {
        status: null,
        retryable: false,
      }));
      return;
    }
    const timeout = setTimeout(resolve, delayMs);
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(signal.reason ?? new AiGatewayError("aborted", "AI model request aborted", {
        status: null,
        retryable: false,
      }));
    }, { once: true });
  });
}

function transportError(error: unknown, timedOut: boolean, callerAborted: boolean): AiGatewayError {
  if (error instanceof AiGatewayError) return error;
  if (timedOut) {
    return new AiGatewayError("timed_out", "AI model request timed out", {
      status: null,
      retryable: true,
    });
  }
  if (callerAborted) {
    return new AiGatewayError("aborted", "AI model request aborted", {
      status: null,
      retryable: false,
    });
  }
  return new AiGatewayError("model_failed", "AI model request failed", {
    status: null,
    retryable: true,
  });
}

function completionTokenParameter(
  configuration: OpenAICompatibleGatewayConfiguration,
  maxCompletionTokens: number,
): Record<string, number> {
  return configuration.maxTokensParameter === "max_tokens"
    ? { max_tokens: maxCompletionTokens }
    : { max_completion_tokens: maxCompletionTokens };
}

export class OpenAICompatibleGateway {
  constructor(private readonly configuration: OpenAICompatibleGatewayConfiguration) {}

  async callTool(input: CallToolInput): Promise<AiToolCallResult> {
    const startedAt = Date.now();
    let providerStatus: number | null = null;
    let usage: z.infer<typeof ToolCallResponseSchema>["usage"];
    try {
      const result = await this.callToolWithRetry(input, (status) => { providerStatus = status; }, (value) => { usage = value; });
      input.onTelemetry?.({
        durationMs: Date.now() - startedAt,
        model: this.configuration.model,
        outcome: "success",
        providerStatus,
        promptTokens: usage?.prompt_tokens ?? null,
        completionTokens: usage?.completion_tokens ?? null,
        totalTokens: usage?.total_tokens ?? null,
      });
      return result;
    } catch (error) {
      input.onTelemetry?.({
        durationMs: Date.now() - startedAt,
        model: this.configuration.model,
        outcome: "error",
        providerStatus: error instanceof AiGatewayError ? error.status : providerStatus,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
      });
      throw error;
    }
  }

  async *streamTool(input: CallToolInput): AsyncGenerator<AiToolCallStreamEvent> {
    const startedAt = Date.now();
    let providerStatus: number | null = null;
    let usage: z.infer<typeof ToolCallResponseSchema>["usage"];
    let outcome: AiGatewayTelemetry["outcome"] = "error";
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      const timeoutSignal = AbortSignal.timeout(input.timeoutMs);
      const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
      const baseUrl = (this.configuration.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/u, "");
      let response: Response;
      try {
        response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.configuration.apiKey}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify({
            ...this.configuration.providerOptions,
            model: this.configuration.model,
            temperature: input.temperature ?? 0.2,
            ...completionTokenParameter(this.configuration, input.maxCompletionTokens),
            parallel_tool_calls: false,
            stream: true,
            stream_options: { include_usage: true },
            tool_choice: input.toolChoice ?? "required",
            messages: input.messages,
            tools: input.tools.map((tool) => ({ type: "function", function: tool })),
          }),
          signal,
        });
      } catch (error) {
        throw transportError(error, timeoutSignal.aborted, input.signal?.aborted ?? false);
      }
      providerStatus = response.status;
      if (!response.ok) throw gatewayErrorForStatus(response.status);
      if (!response.body) {
        throw new AiGatewayError("invalid_response", "AI model returned an empty stream", {
          status: response.status,
          retryable: false,
        });
      }

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let dataLines: string[] = [];
      let callId: string | null = null;
      let callName: string | null = null;
      let argumentText = "";

      const processFrame = (frame: string): { delta: string | null; done: boolean } => {
        if (frame === "[DONE]") return { delta: null, done: true };
        const parsed = ToolCallStreamChunkSchema.parse(JSON.parse(frame));
        if (parsed.usage) usage = parsed.usage;
        let delta: string | null = null;
        for (const choice of parsed.choices ?? []) {
          for (const toolCall of choice.delta?.tool_calls ?? []) {
            if (toolCall.index !== 0) continue;
            if (toolCall.id) callId = toolCall.id;
            if (toolCall.function?.name) callName = toolCall.function.name;
            if (toolCall.function?.arguments) {
              delta = `${delta ?? ""}${toolCall.function.arguments}`;
            }
          }
        }
        return { delta, done: false };
      };

      const processLine = (line: string): { delta: string | null; done: boolean } | null => {
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /u, ""));
          return null;
        }
        if (line !== "") return null;
        if (dataLines.length === 0) return null;
        const frame = dataLines.join("\n");
        dataLines = [];
        return processFrame(frame);
      };

      const processChunk = (chunk: string): Array<{ delta: string | null; done: boolean }> => {
        buffer += chunk;
        const events: Array<{ delta: string | null; done: boolean }> = [];
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).replace(/\r$/u, "");
          buffer = buffer.slice(newlineIndex + 1);
          const event = processLine(line);
          if (event) events.push(event);
          newlineIndex = buffer.indexOf("\n");
        }
        return events;
      };

      let sawDone = false;
      while (true) {
        const chunk = await reader.read();
        const text = decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
        for (const event of processChunk(text)) {
          if (event.done) {
            sawDone = true;
            continue;
          }
          if (event.delta) {
            argumentText += event.delta;
            yield { type: "arguments_delta", delta: event.delta };
          }
        }
        if (chunk.done) break;
      }
      for (const event of processChunk(decoder.decode())) {
        if (event.done) sawDone = true;
        if (event.delta) {
          argumentText += event.delta;
          yield { type: "arguments_delta", delta: event.delta };
        }
      }
      if (buffer.trim() || dataLines.length > 0 || (!sawDone && argumentText.length === 0)) {
        throw new AiGatewayError("invalid_response", "AI model returned an incomplete stream", {
          status: response.status,
          retryable: false,
        });
      }
      if (!callName || !argumentText) {
        throw new AiGatewayError("invalid_response", "AI model returned no tool call", {
          status: response.status,
          retryable: false,
        });
      }
      let argumentsValue: unknown;
      try {
        argumentsValue = JSON.parse(argumentText) as unknown;
      } catch {
        throw new AiGatewayError("invalid_response", "AI model returned invalid tool arguments", {
          status: response.status,
          retryable: false,
        });
      }
      const result = { id: callId, name: callName, arguments: argumentsValue };
      outcome = "success";
      yield { type: "result", result };
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        throw new AiGatewayError("invalid_response", "AI model returned invalid stream data", {
          status: providerStatus,
          retryable: false,
        });
      }
      throw error instanceof AiGatewayError
        ? error
        : transportError(error, false, input.signal?.aborted ?? false);
    } finally {
      await reader?.cancel().catch(() => undefined);
      input.onTelemetry?.({
        durationMs: Date.now() - startedAt,
        model: this.configuration.model,
        outcome,
        providerStatus,
        promptTokens: usage?.prompt_tokens ?? null,
        completionTokens: usage?.completion_tokens ?? null,
        totalTokens: usage?.total_tokens ?? null,
      });
    }
  }

  private async callToolWithRetry(
    input: CallToolInput,
    setStatus: (status: number) => void,
    setUsage: (usage: z.infer<typeof ToolCallResponseSchema>["usage"]) => void,
  ): Promise<AiToolCallResult> {
    const retryDelays = input.retryDelaysMs ?? [];
    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      try {
        return await this.callToolOnce(input, setStatus, setUsage);
      } catch (error) {
        const gatewayError = error instanceof AiGatewayError
          ? error
          : transportError(error, false, input.signal?.aborted ?? false);
        if (!gatewayError.retryable || input.signal?.aborted || attempt === retryDelays.length) throw gatewayError;
        await waitForRetry(retryDelays[attempt]!, input.signal ?? new AbortController().signal);
      }
    }
    throw new AiGatewayError("model_failed", "AI model retry loop exhausted", {
      status: null,
      retryable: false,
    });
  }

  private async callToolOnce(
    input: CallToolInput,
    setStatus: (status: number) => void,
    setUsage: (usage: z.infer<typeof ToolCallResponseSchema>["usage"]) => void,
  ): Promise<AiToolCallResult> {
    const timeoutSignal = AbortSignal.timeout(input.timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
    const baseUrl = (this.configuration.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/u, "");
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.configuration.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...this.configuration.providerOptions,
          model: this.configuration.model,
          temperature: input.temperature ?? 0.2,
          ...completionTokenParameter(this.configuration, input.maxCompletionTokens),
          parallel_tool_calls: false,
          tool_choice: input.toolChoice ?? "required",
          messages: input.messages,
          tools: input.tools.map((tool) => ({ type: "function", function: tool })),
        }),
        signal,
      });
    } catch (error) {
      throw transportError(error, timeoutSignal.aborted, input.signal?.aborted ?? false);
    }
    setStatus(response.status);
    if (!response.ok) throw gatewayErrorForStatus(response.status);
    try {
      const parsed = ToolCallResponseSchema.parse(await response.json());
      setUsage(parsed.usage);
      const call = parsed.choices[0]!.message.tool_calls[0]!;
      return {
        id: call.id ?? null,
        name: call.function.name,
        arguments: JSON.parse(call.function.arguments) as unknown,
      };
    } catch {
      throw new AiGatewayError("invalid_response", "AI model returned invalid tool response", {
        status: response.status,
        retryable: false,
      });
    }
  }
}

export function isRetryableAiGatewayError(error: unknown): boolean {
  return error instanceof AiGatewayError && error.retryable;
}

export type FailoverOpenAICompatibleGatewayConfiguration = {
  primary: OpenAICompatibleGatewayConfiguration;
  fallback?: OpenAICompatibleGatewayConfiguration;
};

/**
 * Tries a secondary OpenAI-compatible provider only for transient failures.
 * Invalid tool/schema responses are deliberately not failed over: accepting a
 * malformed response from another model would hide a prompt or contract bug.
 * Streaming only fails over before the primary has emitted any user-visible
 * arguments, so a partial answer is never silently duplicated.
 */
export class FailoverOpenAICompatibleGateway {
  private readonly primary: OpenAICompatibleGateway;
  private readonly fallback: OpenAICompatibleGateway | undefined;

  constructor(configuration: FailoverOpenAICompatibleGatewayConfiguration) {
    this.primary = new OpenAICompatibleGateway(configuration.primary);
    this.fallback = configuration.fallback
      ? new OpenAICompatibleGateway(configuration.fallback)
      : undefined;
  }

  async callTool(input: CallToolInput): Promise<AiToolCallResult> {
    try {
      return await this.primary.callTool(input);
    } catch (error) {
      if (!this.fallback || !isRetryableAiGatewayError(error)) throw error;
      return this.fallback.callTool(input);
    }
  }

  async *streamTool(input: CallToolInput): AsyncGenerator<AiToolCallStreamEvent> {
    let emitted = false;
    try {
      for await (const event of this.primary.streamTool(input)) {
        emitted = true;
        yield event;
      }
    } catch (error) {
      if (!this.fallback || emitted || !isRetryableAiGatewayError(error)) throw error;
      yield* this.fallback.streamTool(input);
    }
  }
}
