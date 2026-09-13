import { z } from "zod";
import { AgentRunnerClient, AgentRunnerError } from "./agent-runner-client.js";
import type {
  AgentToolCall,
  DomainAgentName,
  DomainAgentTurnInput,
  ToolCallingModel,
} from "./runtime-types.js";

const DEFAULT_MAX_COMPLETION_TOKENS = 4096;

const AgentToolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.unknown(),
});

const domainAgentDefinitions: Record<
  DomainAgentName,
  { path: string; promptVersion: string }
> = {
  "outline-planning": {
    path: "/v1/outline-planning/next-tool",
    promptVersion: "outline-planning-langgraph-v1",
  },
  "chapter-design": {
    path: "/v1/chapter-design/next-tool",
    promptVersion: "chapter-design-langgraph-v1",
  },
  "blueprint-worker": {
    path: "/v1/blueprint-worker/next-tool",
    promptVersion: "blueprint-worker-langgraph-v1",
  },
};

export { AgentRunnerError } from "./agent-runner-client.js";

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
      const transient = error instanceof AgentRunnerError
        ? error.retryable
        : /status (?:429|5\d\d)\b|fetch failed|econnreset|etimedout/iu.test(modelErrorMessage(error));
      if (!transient || input.signal.aborted || attempt === retryDelaysMs.length) throw error;
      await waitForModelRetry(retryDelaysMs[attempt]!, input.signal);
    }
  }
  throw new Error("Agent Runner retry loop exhausted");
}

export async function nextDomainTool(
  model: ToolCallingModel,
  input: DomainAgentTurnInput,
): Promise<AgentToolCall> {
  const invocation = model.nextDomainTool
    ? model.nextDomainTool(input)
    : model.nextTool({
        system: "The Agent Runner owns this domain prompt.",
        task: JSON.stringify(input.context),
        tools: [],
        transcript: input.transcript,
        signal: input.signal,
        ...(input.maxCompletionTokens === undefined
          ? {}
          : { maxCompletionTokens: input.maxCompletionTokens }),
      });
  return nextToolWithAbort(
    { nextTool: async () => invocation },
    {
      system: "Agent Runner domain invocation",
      task: input.agent,
      tools: [],
      transcript: input.transcript,
      signal: input.signal,
    },
  );
}

export class RemoteAgentToolModel implements ToolCallingModel {
  private readonly client: AgentRunnerClient;

  constructor(
    private readonly configuration: {
      baseUrl: string;
      internalToken: string;
      profile: "generation" | "design" | "evaluation";
      timeoutMs?: number;
      maxCompletionTokens?: number;
    },
  ) {
    this.client = new AgentRunnerClient(configuration);
  }

  async nextTool(input: Parameters<ToolCallingModel["nextTool"]>[0]): Promise<AgentToolCall> {
    const timeoutMs = this.configuration.timeoutMs ?? 120_000;
    return this.client.post({
      path: "/v1/next-tool",
      body: {
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
      },
      schema: AgentToolCallSchema,
      timeoutMs,
      signal: input.signal,
    });
  }

  async nextDomainTool(input: DomainAgentTurnInput): Promise<AgentToolCall> {
    const timeoutMs = input.timeoutMs ?? this.configuration.timeoutMs ?? 120_000;
    const definition = domainAgentDefinitions[input.agent];
    const response = await this.client.post({
      path: definition.path,
      body: {
        context: input.context,
        transcript: input.transcript,
        timeout_ms: timeoutMs,
        max_completion_tokens:
          input.maxCompletionTokens
          ?? this.configuration.maxCompletionTokens
          ?? DEFAULT_MAX_COMPLETION_TOKENS,
      },
      schema: z.object({
        call: AgentToolCallSchema,
        prompt_version: z.literal(definition.promptVersion),
      }),
      timeoutMs,
      signal: input.signal,
    });
    return response.call;
  }
}
