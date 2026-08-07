import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleToolModel } from "../src/model.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAI-compatible tool model", () => {
  it("caps completion tokens so compatible gateways do not reason indefinitely", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        message: {
          tool_calls: [{
            id: "call-1",
            function: { name: "submit", arguments: "{}" },
          }],
        },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const model = new OpenAICompatibleToolModel({
      apiKey: "test-key",
      model: "test-model",
      baseUrl: "https://models.example/v1/",
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
      model: "test-model",
      max_completion_tokens: 4096,
      tool_choice: "required",
    });
  });

  it("honors a smaller per-call budget for deterministic workflow steps", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        message: {
          tool_calls: [{
            id: "call-1",
            function: { name: "read", arguments: "{}" },
          }],
        },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const model = new OpenAICompatibleToolModel({ apiKey: "test-key", model: "test-model" });

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
