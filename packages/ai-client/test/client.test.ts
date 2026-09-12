import { afterEach, describe, expect, it, vi } from "vitest";
import { AiGatewayError, HttpAiGatewayClient, requestEmbeddings } from "../src/index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const configuration = {
  baseUrl: "https://gateway.example/",
  internalToken: "internal-secret",
  profile: "tutor" as const,
};

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

describe("AI Gateway HTTP client", () => {
  it("sends only the internal credential and parses a tool call", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      result: { id: "call-1", name: "answer", arguments: { value: "ok" } },
      telemetry: {
        duration_ms: 12,
        model: "private-model",
        outcome: "success",
        provider_status: 200,
        prompt_tokens: 10,
        completion_tokens: 3,
        total_tokens: 13,
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const telemetry = vi.fn();

    await expect(new HttpAiGatewayClient(configuration).callTool({ ...input, onTelemetry: telemetry }))
      .resolves.toEqual({ id: "call-1", name: "answer", arguments: { value: "ok" } });

    expect(fetchMock).toHaveBeenCalledWith("https://gateway.example/v1/tool-calls", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer internal-secret" }),
    }));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      profile: "tutor",
      max_completion_tokens: 256,
    });
    expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({ totalTokens: 13 }));
  });

  it("preserves stable gateway errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: "rate_limited",
        message: "AI model request failed with status 429",
        status: 429,
        retryable: true,
      },
    }), { status: 429, headers: { "Content-Type": "application/json" } })));

    await expect(new HttpAiGatewayClient(configuration).callTool(input)).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
      retryable: true,
    });
  });

  it("streams fragmented SSE tool arguments", async () => {
    const payload = [
      'data: {"type":"arguments_delta","delta":"{\\"value\\":\\""}\n\n',
      'data: {"type":"arguments_delta","delta":"完成\\"}"}\n\n',
      'data: {"type":"result","result":{"id":"call-2","name":"answer","arguments":{"value":"完成"}}}\n\n',
    ].join("");
    const encoded = new TextEncoder().encode(payload);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, 35));
        controller.enqueue(encoded.slice(35));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })));
    const events = [];

    for await (const event of new HttpAiGatewayClient(configuration).streamTool(input)) events.push(event);

    expect(events.at(-1)).toEqual({
      type: "result",
      result: { id: "call-2", name: "answer", arguments: { value: "完成" } },
    });
  });

  it("rejects malformed gateway responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ result: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    await expect(new HttpAiGatewayClient(configuration).callTool(input)).rejects.toBeInstanceOf(AiGatewayError);
  });

  it("requests embeddings through the private service", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      embeddings: [[0.1, 0.2]],
      model: "embedding-model",
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await expect(requestEmbeddings(configuration, ["card"], 5_000)).resolves.toEqual({
      embeddings: [[0.1, 0.2]],
      model: "embedding-model",
    });
  });
});
