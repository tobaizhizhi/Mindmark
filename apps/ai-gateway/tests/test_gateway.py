from __future__ import annotations

from io import BytesIO
import json
from typing import Any
import unittest
from urllib.error import HTTPError

from mindmark_ai_gateway.config import GatewaySettings
from mindmark_ai_gateway.models import validate_tool_request
from mindmark_ai_gateway.provider import GatewayError, ModelGateway


class FakeResponse:
    def __init__(self, status: int, payload: object) -> None:
        self.status = status
        self.body = json.dumps(payload).encode()

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def read(self) -> bytes:
        return self.body


def settings(**overrides: object) -> GatewaySettings:
    values: dict[str, object] = {
        "internal_token": "internal-secret",
        "ai_api_key": "provider-secret",
        "ai_model": "primary-model",
        "ai_base_url": "https://primary.example/v1",
        "tutor_model": None,
        "design_model": None,
        "evaluation_api_key": None,
        "evaluation_model": None,
        "evaluation_base_url": None,
        "embedding_api_key": None,
        "embedding_model": None,
        "embedding_base_url": None,
        "fallback_api_key": None,
        "fallback_model": "deepseek-chat",
        "fallback_base_url": "https://api.deepseek.com/v1",
    }
    values.update(overrides)
    return GatewaySettings(**values)  # type: ignore[arg-type]


def tool_request():
    return validate_tool_request(
        {
            "profile": "generation",
            "messages": [{"role": "user", "content": "Answer with the tool."}],
            "tools": [
                {
                    "name": "answer",
                    "description": "Return the answer",
                    "parameters": {"type": "object"},
                }
            ],
            "max_completion_tokens": 256,
        }
    )


class GatewayTests(unittest.TestCase):
    def test_returns_structured_tool_call_without_leaking_key(self) -> None:
        def open_url(incoming: Any, **_: object) -> FakeResponse:
            self.assertEqual(incoming.headers["Authorization"], "Bearer provider-secret")
            payload = json.loads(incoming.data)
            self.assertEqual(payload["max_completion_tokens"], 256)
            return FakeResponse(
                200,
                {
                    "choices": [
                        {
                            "message": {
                                "tool_calls": [
                                    {
                                        "id": "call-1",
                                        "function": {
                                            "name": "answer",
                                            "arguments": '{"value":"ok"}',
                                        },
                                    }
                                ]
                            }
                        }
                    ],
                    "usage": {
                        "prompt_tokens": 10,
                        "completion_tokens": 3,
                        "total_tokens": 13,
                    },
                },
            )

        response = ModelGateway(settings(), open_url).call_tool(tool_request())
        self.assertEqual(response["result"]["arguments"], {"value": "ok"})
        self.assertEqual(response["telemetry"]["total_tokens"], 13)
        self.assertNotIn("provider-secret", json.dumps(response))

    def test_fails_over_only_for_retryable_errors(self) -> None:
        calls: list[str] = []

        def open_url(incoming: Any, **_: object) -> FakeResponse:
            calls.append(incoming.full_url)
            if incoming.host == "primary.example":
                raise HTTPError(
                    incoming.full_url,
                    503,
                    "unavailable",
                    {},
                    BytesIO(b"private upstream detail"),
                )
            payload = json.loads(incoming.data)
            self.assertEqual(payload["max_tokens"], 256)
            return FakeResponse(
                200,
                {
                    "choices": [
                        {
                            "message": {
                                "tool_calls": [
                                    {
                                        "id": "fallback-call",
                                        "function": {
                                            "name": "answer",
                                            "arguments": '{"value":"fallback"}',
                                        },
                                    }
                                ]
                            }
                        }
                    ]
                },
            )

        gateway = ModelGateway(settings(fallback_api_key="fallback-secret"), open_url)
        response = gateway.call_tool(tool_request())
        self.assertEqual(response["result"]["arguments"], {"value": "fallback"})
        self.assertEqual(
            calls,
            [
                "https://primary.example/v1/chat/completions",
                "https://api.deepseek.com/v1/chat/completions",
            ],
        )

    def test_invalid_response_does_not_fail_over(self) -> None:
        calls = 0

        def open_url(_: Any, **__: object) -> FakeResponse:
            nonlocal calls
            calls += 1
            return FakeResponse(200, {"choices": []})

        gateway = ModelGateway(settings(fallback_api_key="fallback-secret"), open_url)
        with self.assertRaises(GatewayError) as raised:
            gateway.call_tool(tool_request())
        self.assertEqual(raised.exception.code, "invalid_response")
        self.assertFalse(raised.exception.retryable)
        self.assertEqual(calls, 1)


if __name__ == "__main__":
    unittest.main()
