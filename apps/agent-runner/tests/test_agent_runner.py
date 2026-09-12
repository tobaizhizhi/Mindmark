from __future__ import annotations

import json
from typing import Any
import unittest

from mindmark_agent_runner.config import RunnerSettings
from mindmark_agent_runner.gateway_client import AiGatewayClient
from mindmark_agent_runner.models import validate_next_tool_request


class FakeResponse:
    status = 200

    def __init__(self, payload: object) -> None:
        self.body = json.dumps(payload).encode()

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def read(self) -> bytes:
        return self.body


class AgentRunnerTests(unittest.TestCase):
    def test_translates_agent_transcript_to_gateway_messages(self) -> None:
        settings = RunnerSettings(
            internal_token="runner-secret",
            ai_gateway_url="https://gateway.example",
            ai_gateway_token="gateway-secret",
        )

        def open_url(incoming: Any, **_: object) -> FakeResponse:
            self.assertEqual(incoming.headers["Authorization"], "Bearer gateway-secret")
            payload = json.loads(incoming.data)
            self.assertEqual(
                [message["role"] for message in payload["messages"]],
                ["system", "user", "assistant", "tool"],
            )
            self.assertEqual(payload["profile"], "design")
            return FakeResponse(
                {
                    "result": {
                        "id": "call-2",
                        "name": "submit",
                        "arguments": {"ok": True},
                    },
                    "telemetry": {
                        "duration_ms": 1,
                        "model": "test-model",
                        "outcome": "success",
                        "provider_status": 200,
                        "prompt_tokens": 1,
                        "completion_tokens": 1,
                        "total_tokens": 2,
                    },
                }
            )

        body = validate_next_tool_request(
            {
                "profile": "design",
                "system": "Use tools.",
                "task": "Submit a result.",
                "tools": [
                    {
                        "name": "submit",
                        "description": "Submit",
                        "parameters": {"type": "object"},
                    }
                ],
                "transcript": [
                    {
                        "call": {"id": "call-1", "name": "read", "arguments": {}},
                        "result": {"context": "bounded"},
                    }
                ],
            }
        )
        result = AiGatewayClient(settings, open_url, lambda _: None).next_tool(body)
        self.assertEqual(
            result,
            {"id": "call-2", "name": "submit", "arguments": {"ok": True}},
        )


if __name__ == "__main__":
    unittest.main()
