import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolCallingModel } from "../src/runtime-types.js";
import {
  AgentRunnerError,
  nextToolWithTransientRetry,
  RemoteAgentToolModel,
} from "../src/model.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("remote Agent Runner tool model", () => {
  it("uses a typed domain endpoint without sending prompts from TypeScript", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      call: { id: "outline-1", name: "read_source_outline", arguments: {} },
      prompt_version: "outline-planning-langgraph-v1",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const model = new RemoteAgentToolModel({
      internalToken: "test-internal-token",
      profile: "design",
      baseUrl: "https://agents.example/",
    });

    await model.nextDomainTool?.({
      agent: "outline-planning",
      context: { projectId: `0x${"1".repeat(64)}` },
      transcript: [],
      signal: new AbortController().signal,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://agents.example/v1/outline-planning/next-tool");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.context).toEqual({ projectId: `0x${"1".repeat(64)}` });
    expect(body).not.toHaveProperty("system");
    expect(body).not.toHaveProperty("tools");
  });

  it("caps completion tokens so remote agents do not reason indefinitely", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: "call-1",
      name: "submit",
      arguments: {},
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const model = new RemoteAgentToolModel({
      internalToken: "test-internal-token",
      profile: "generation",
      baseUrl: "https://agents.example/",
    });

    await model.nextTool({
      system: "Use one tool.",
      task: "Submit the result.",
      tools: [{
        name: "submit",
        description: "Submit the result.",
        parameters: { type: "object", additionalProperties: false },
      }],
      transcript: [],
      signal: new AbortController().signal,
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      profile: "generation",
      max_completion_tokens: 4096,
    });
  });

  it("honors a smaller per-call budget for deterministic workflow steps", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: "call-1",
      name: "read",
      arguments: {},
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const model = new RemoteAgentToolModel({
      baseUrl: "https://agents.example",
      internalToken: "test-internal-token",
      profile: "design",
    });

    await model.nextTool({
      system: "Read first.",
      task: "Read the context.",
      tools: [{
        name: "read",
        description: "Read context.",
        parameters: { type: "object", additionalProperties: false },
      }],
      transcript: [],
      signal: new AbortController().signal,
      maxCompletionTokens: 256,
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      max_completion_tokens: 256,
    });
  });

  it("does not repeat retries already exhausted by Agent Runner", async () => {
    let calls = 0;
    const model: ToolCallingModel = {
      async nextTool() {
        calls += 1;
        throw new AgentRunnerError(
          "AI model request failed with status 503",
          "model_failed",
          503,
          false,
        );
      },
    };

    await expect(nextToolWithTransientRetry(model, {
      system: "Use one tool.",
      task: "Submit the result.",
      tools: [],
      transcript: [],
      signal: new AbortController().signal,
    }, [0, 0])).rejects.toMatchObject({ retryable: false });
    expect(calls).toBe(1);
  });
});
