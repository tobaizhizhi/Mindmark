import { z } from "zod";

const ToolCallResultSchema = z.object({
  id: z.string().nullable(),
  name: z.string().min(1),
  arguments: z.unknown(),
});

const TelemetrySchema = z.object({
  duration_ms: z.number().int().nonnegative(),
  model: z.string().min(1),
  outcome: z.enum(["success", "error"]),
  provider_status: z.number().int().nullable(),
  prompt_tokens: z.number().int().nonnegative().nullable(),
  completion_tokens: z.number().int().nonnegative().nullable(),
  total_tokens: z.number().int().nonnegative().nullable(),
});

const ToolCallResponseSchema = z.object({
  result: ToolCallResultSchema,
  telemetry: TelemetrySchema,
});

const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    status: z.number().int().nullable(),
    retryable: z.boolean(),
  }),
});

const StreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("arguments_delta"), delta: z.string() }),
  z.object({ type: z.literal("result"), result: ToolCallResultSchema }),
  z.object({ type: z.literal("error"), error: ErrorResponseSchema.shape.error }),
]);

const EmbeddingResponseSchema = z.object({
  embeddings: z.array(z.array(z.number().finite()).min(1)).min(1),
  model: z.string().min(1),
});

export type AiGatewayErrorCode =
  | "aborted"
  | "gateway_unavailable"
  | "invalid_response"
  | "model_failed"
  | "not_configured"
  | "rate_limited"
  | "timed_out"
  | "unauthorized";

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

export type AiToolCallResult = z.infer<typeof ToolCallResultSchema>;

export type AiToolCallStreamEvent =
  | { type: "arguments_delta"; delta: string }
  | { type: "result"; result: AiToolCallResult };

export type AiGatewayProfile = "generation" | "design" | "evaluation" | "tutor";

export type AiGatewayClientConfiguration = {
  baseUrl: string;
  internalToken: string;
  profile: AiGatewayProfile;
};

export type CallToolInput = {
  messages: AiChatMessage[];
  tools: AiToolDefinition[];
  signal?: AbortSignal;
  timeoutMs: number;
  temperature?: number;
  maxCompletionTokens: number;
  toolChoice?: "required" | { type: "function"; function: { name: string } };
  onTelemetry?: (event: AiGatewayTelemetry) => void;
};

function telemetryFromWire(value: z.infer<typeof TelemetrySchema>): AiGatewayTelemetry {
  return {
    durationMs: value.duration_ms,
    model: value.model,
    outcome: value.outcome,
    providerStatus: value.provider_status,
    promptTokens: value.prompt_tokens,
    completionTokens: value.completion_tokens,
    totalTokens: value.total_tokens,
  };
}

function requestSignal(input: CallToolInput): AbortSignal {
  const timeout = AbortSignal.timeout(input.timeoutMs + 5_000);
  return input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
}

function requestBody(profile: AiGatewayProfile, input: CallToolInput): string {
  return JSON.stringify({
    profile,
    messages: input.messages,
    tools: input.tools,
    timeout_ms: input.timeoutMs,
    temperature: input.temperature ?? 0.2,
    max_completion_tokens: input.maxCompletionTokens,
    tool_choice: input.toolChoice ?? "required",
  });
}

function transportError(error: unknown, callerAborted: boolean): AiGatewayError {
  if (error instanceof AiGatewayError) return error;
  if (callerAborted) {
    return new AiGatewayError("aborted", "AI Gateway request aborted", {
      status: null,
      retryable: false,
    });
  }
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return new AiGatewayError("timed_out", "AI Gateway request timed out", {
      status: null,
      retryable: true,
    });
  }
  return new AiGatewayError("gateway_unavailable", "AI Gateway request failed", {
    status: null,
    retryable: true,
  });
}

async function responseError(response: Response): Promise<AiGatewayError> {
  try {
    const parsed = ErrorResponseSchema.parse(await response.json());
    return new AiGatewayError(parsed.error.code as AiGatewayErrorCode, parsed.error.message, {
      status: parsed.error.status,
      retryable: parsed.error.retryable,
    });
  } catch {
    return new AiGatewayError(
      response.status === 401 ? "unauthorized" : "gateway_unavailable",
      `AI Gateway request failed with status ${response.status}`,
      { status: response.status, retryable: response.status === 429 || response.status >= 500 },
    );
  }
}

export class HttpAiGatewayClient {
  constructor(private readonly configuration: AiGatewayClientConfiguration) {}

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

  async callTool(input: CallToolInput): Promise<AiToolCallResult> {
    try {
      const response = await fetch(this.endpoint("/v1/tool-calls"), {
        method: "POST",
        headers: this.headers(),
        body: requestBody(this.configuration.profile, input),
        signal: requestSignal(input),
      });
      if (!response.ok) throw await responseError(response);
      const parsed = ToolCallResponseSchema.parse(await response.json());
      input.onTelemetry?.(telemetryFromWire(parsed.telemetry));
      return parsed.result;
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        throw new AiGatewayError("invalid_response", "AI Gateway returned an invalid response", {
          status: null,
          retryable: false,
        });
      }
      throw transportError(error, input.signal?.aborted ?? false);
    }
  }

  async *streamTool(input: CallToolInput): AsyncGenerator<AiToolCallStreamEvent> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      const response = await fetch(this.endpoint("/v1/tool-calls/stream"), {
        method: "POST",
        headers: this.headers("text/event-stream"),
        body: requestBody(this.configuration.profile, input),
        signal: requestSignal(input),
      });
      if (!response.ok) throw await responseError(response);
      if (!response.body) {
        throw new AiGatewayError("invalid_response", "AI Gateway returned an empty stream", {
          status: response.status,
          retryable: false,
        });
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let dataLines: string[] = [];
      let completed = false;

      const processLine = (line: string): z.infer<typeof StreamEventSchema> | null => {
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /u, ""));
          return null;
        }
        if (line !== "" || dataLines.length === 0) return null;
        const event = StreamEventSchema.parse(JSON.parse(dataLines.join("\n")));
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
            throw new AiGatewayError(event.error.code as AiGatewayErrorCode, event.error.message, {
              status: event.error.status,
              retryable: event.error.retryable,
            });
          }
          if (event.type === "result") completed = true;
          yield event;
        }
        if (chunk.done) break;
      }
      if (buffer.trim() || dataLines.length > 0 || !completed) {
        throw new AiGatewayError("invalid_response", "AI Gateway returned an incomplete stream", {
          status: response.status,
          retryable: false,
        });
      }
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        throw new AiGatewayError("invalid_response", "AI Gateway returned invalid stream data", {
          status: null,
          retryable: false,
        });
      }
      throw transportError(error, input.signal?.aborted ?? false);
    } finally {
      await reader?.cancel().catch(() => undefined);
    }
  }
}

export function isRetryableAiGatewayError(error: unknown): boolean {
  return error instanceof AiGatewayError && error.retryable;
}

export async function requestEmbeddings(
  configuration: Omit<AiGatewayClientConfiguration, "profile">,
  texts: string[],
  timeoutMs: number,
): Promise<{ embeddings: number[][]; model: string }> {
  let response: Response;
  try {
    response = await fetch(`${configuration.baseUrl.replace(/\/$/u, "")}/v1/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${configuration.internalToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ texts, timeout_ms: timeoutMs }),
      signal: AbortSignal.timeout(timeoutMs + 5_000),
    });
  } catch (error) {
    throw transportError(error, false);
  }
  if (!response.ok) throw await responseError(response);
  try {
    return EmbeddingResponseSchema.parse(await response.json());
  } catch {
    throw new AiGatewayError("invalid_response", "AI Gateway returned invalid embeddings", {
      status: response.status,
      retryable: false,
    });
  }
}
