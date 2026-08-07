import { afterEach, describe, expect, it, vi } from "vitest";
import { AiGatewayError, OpenAICompatibleGateway } from "../src/index.js";

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
});
