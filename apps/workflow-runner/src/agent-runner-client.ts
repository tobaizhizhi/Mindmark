import { z } from "zod";

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

async function responseError(response: Response): Promise<AgentRunnerError> {
  try {
    const parsed = ErrorResponseSchema.parse(await response.json());
    return new AgentRunnerError(
      parsed.error.message,
      parsed.error.code,
      parsed.error.status,
      parsed.error.retryable,
    );
  } catch {
    return new AgentRunnerError(
      `Agent Runner request failed with status ${response.status}`,
      response.status === 401 ? "unauthorized" : "runner_unavailable",
      response.status,
      response.status === 429 || response.status >= 500,
    );
  }
}

export class AgentRunnerClient {
  constructor(private readonly configuration: {
    baseUrl: string;
    internalToken: string;
  }) {}

  async post<Schema extends z.ZodType>(input: {
    path: string;
    body: unknown;
    schema: Schema;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<z.output<Schema>> {
    const timeoutSignal = AbortSignal.timeout(input.timeoutMs + 5_000);
    const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      response = await fetch(
        `${this.configuration.baseUrl.replace(/\/$/u, "")}${input.path}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.configuration.internalToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(input.body),
          signal,
        },
      );
    } catch (error) {
      if (input.signal?.aborted) throw input.signal.reason ?? error;
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      throw new AgentRunnerError(
        timedOut ? "Agent Runner request timed out" : "Agent Runner request failed",
        timedOut ? "timed_out" : "runner_unavailable",
        null,
        true,
      );
    }
    if (!response.ok) throw await responseError(response);
    try {
      return input.schema.parse(await response.json());
    } catch {
      throw new AgentRunnerError(
        "Agent Runner returned an invalid response",
        "invalid_response",
        response.status,
        false,
      );
    }
  }
}
