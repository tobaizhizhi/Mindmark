import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AiGatewayError,
  FailoverOpenAICompatibleGateway,
  OpenAICompatibleGateway,
} from "../src/index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const input = {
  messages: [{ role: "user" as const, content: "Answer through the tool." }],
  tools: [{
    name: "answer",
    description: "Answer",
    parameters: { type: "object", properties: { value: { type: "string" } } },
  }],
  timeoutMs: 5_000,
  maxCompletionTokens: 256,
};

describe("OpenAI-compatible AI Gateway", () => {
  it("streams fragmented tool arguments and returns the parsed tool result", async () => {
    const frames = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-stream", function: { name: "answer", arguments: "{\"value\":\"" } }] } }], usage: null },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: null, function: { name: "", arguments: "流式" } }] } }], usage: null },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "完成\"}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } },
    ];
    const payload = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
    const encoded = new TextEncoder().encode(payload);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, 17));
        controller.enqueue(encoded.slice(17, 91));
        controller.enqueue(encoded.slice(91));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })));
    const telemetry = vi.fn();
    const gateway = new OpenAICompatibleGateway({ apiKey: "secret-key", model: "test-model" });
    const events = [];

    for await (const event of gateway.streamTool({ ...input, onTelemetry: telemetry })) events.push(event);

    expect(events).toEqual([
      { type: "arguments_delta", delta: "{\"value\":\"" },
      { type: "arguments_delta", delta: "流式" },
      { type: "arguments_delta", delta: "完成\"}" },
      {
        type: "result",
        result: { id: "call-stream", name: "answer", arguments: { value: "流式完成" } },
      },
    ]);
    expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "success",
      providerStatus: 200,
      totalTokens: 12,
    }));
  });

  it("returns parsed tool arguments and sanitized telemetry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{
        id: "call-1",
        function: { name: "answer", arguments: '{"value":"ok"}' },
      }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const telemetry = vi.fn();
    const gateway = new OpenAICompatibleGateway({ apiKey: "secret-key", model: "test-model" });

    await expect(gateway.callTool({ ...input, onTelemetry: telemetry })).resolves.toEqual({
      id: "call-1",
      name: "answer",
      arguments: { value: "ok" },
    });
    expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
      model: "test-model",
      providerStatus: 200,
      totalTokens: 13,
      outcome: "success",
    }));
    expect(JSON.stringify(telemetry.mock.calls)).not.toContain("secret-key");
  });

  it("classifies rate limits as retryable without exposing response bodies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("provider secret detail", { status: 429 })));
    const gateway = new OpenAICompatibleGateway({ apiKey: "secret-key", model: "test-model" });

    await expect(gateway.callTool(input)).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
      retryable: true,
      message: "AI model request failed with status 429",
    });
  });

  it("classifies malformed tool calls with a stable non-retryable error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    const gateway = new OpenAICompatibleGateway({ apiKey: "secret-key", model: "test-model" });

    await expect(gateway.callTool(input)).rejects.toEqual(expect.objectContaining<Partial<AiGatewayError>>({
      code: "invalid_response",
      retryable: false,
    }));
  });

  it("uses the DeepSeek fallback after a retryable primary failure", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(new Response("primary unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{
          id: "call-deepseek",
          function: { name: "answer", arguments: '{"value":"fallback"}' },
        }] } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new FailoverOpenAICompatibleGateway({
      primary: {
        apiKey: "primary-key",
        model: "primary-model",
        baseUrl: "https://primary.example/v1",
      },
      fallback: {
        apiKey: "deepseek-key",
        model: "deepseek-chat",
        baseUrl: "https://api.deepseek.com/v1",
        maxTokensParameter: "max_tokens",
        providerOptions: { thinking: { type: "disabled" } },
      },
    });

    await expect(gateway.callTool(input)).resolves.toEqual({
      id: "call-deepseek",
      name: "answer",
      arguments: { value: "fallback" },
    });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://primary.example/v1/chat/completions",
      "https://api.deepseek.com/v1/chat/completions",
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      model: "deepseek-chat",
      max_tokens: 256,
      thinking: { type: "disabled" },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).not.toHaveProperty("max_completion_tokens");
  });

  it("switches streaming to DeepSeek before the primary emits an answer", async () => {
    const frame = {
      choices: [{ delta: { tool_calls: [{
        index: 0,
        id: "call-deepseek-stream",
        function: { name: "answer", arguments: '{"value":"fallback"}' },
      }] } }],
    };
    const payload = new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`);
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(new Response("primary unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(payload);
          controller.close();
        },
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new FailoverOpenAICompatibleGateway({
      primary: { apiKey: "primary-key", model: "primary-model" },
      fallback: { apiKey: "deepseek-key", model: "deepseek-chat" },
    });
    const events = [];

    for await (const event of gateway.streamTool(input)) events.push(event);

    expect(events.at(-1)).toEqual({
      type: "result",
      result: { id: "call-deepseek-stream", name: "answer", arguments: { value: "fallback" } },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not fail over after an invalid primary tool response", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ choices: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new FailoverOpenAICompatibleGateway({
      primary: { apiKey: "primary-key", model: "primary-model" },
      fallback: { apiKey: "deepseek-key", model: "deepseek-chat" },
    });

    await expect(gateway.callTool(input)).rejects.toMatchObject({
      code: "invalid_response",
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
