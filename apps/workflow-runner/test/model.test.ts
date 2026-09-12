import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteAgentToolModel } from "../src/model.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("remote Agent Runner tool model", () => {
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
});
