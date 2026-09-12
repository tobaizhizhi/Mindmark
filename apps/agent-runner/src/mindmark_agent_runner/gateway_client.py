from __future__ import annotations

import json
import socket
import time
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .config import RunnerSettings
from .models import EmbeddingRequest, NextToolRequest


OpenUrl = Callable[..., Any]


class AgentRuntimeError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        status: int | None,
        retryable: bool,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.retryable = retryable


class AiGatewayClient:
    def __init__(
        self,
        settings: RunnerSettings,
        open_url: OpenUrl = urlopen,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.settings = settings
        self.open_url = open_url
        self.sleep = sleep

    def _post(self, path: str, payload: dict[str, Any], timeout_ms: int) -> dict[str, Any]:
        incoming = Request(
            f"{self.settings.ai_gateway_url}{path}",
            data=json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode(),
            headers={
                "Authorization": f"Bearer {self.settings.ai_gateway_token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with self.open_url(incoming, timeout=(timeout_ms / 1_000) + 5) as response:
                return json.loads(response.read())
        except HTTPError as error:
            try:
                detail = json.loads(error.read())["error"]
                raise AgentRuntimeError(
                    str(detail["code"]),
                    str(detail["message"]),
                    status=detail.get("status"),
                    retryable=bool(detail.get("retryable")),
                ) from error
            except (KeyError, TypeError, ValueError, json.JSONDecodeError):
                raise AgentRuntimeError(
                    "gateway_unavailable",
                    f"AI Gateway request failed with status {error.code}",
                    status=error.code,
                    retryable=error.code == 429 or error.code >= 500,
                ) from error
        except (URLError, TimeoutError, socket.timeout) as error:
            code = "timed_out" if isinstance(error, (TimeoutError, socket.timeout)) else "gateway_unavailable"
            raise AgentRuntimeError(
                code,
                "AI Gateway request timed out" if code == "timed_out" else "AI Gateway request failed",
                status=None,
                retryable=True,
            ) from error

    @staticmethod
    def _messages(body: NextToolRequest) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": body.system},
            {"role": "user", "content": body.task},
        ]
        for entry in body.transcript:
            call = entry["call"]
            messages.extend(
                [
                    {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": call["id"],
                                "type": "function",
                                "function": {
                                    "name": call["name"],
                                    "arguments": json.dumps(
                                        call.get("arguments"),
                                        ensure_ascii=False,
                                        separators=(",", ":"),
                                    ),
                                },
                            }
                        ],
                    },
                    {
                        "role": "tool",
                        "tool_call_id": call["id"],
                        "content": json.dumps(
                            entry["result"], ensure_ascii=False, separators=(",", ":")
                        ),
                    },
                ]
            )
        return messages

    def next_tool(self, body: NextToolRequest) -> dict[str, Any]:
        payload = {
            "profile": body.profile,
            "messages": self._messages(body),
            "tools": body.tools,
            "timeout_ms": body.timeout_ms,
            "temperature": 0 if body.profile == "evaluation" else 0.2,
            "max_completion_tokens": body.max_completion_tokens,
            "tool_choice": "required",
        }
        last_error: AgentRuntimeError | None = None
        for delay in (0, 5, 15):
            if delay:
                self.sleep(delay)
            try:
                result = self._post("/v1/tool-calls", payload, body.timeout_ms)["result"]
                if not isinstance(result.get("id"), str) or not result["id"]:
                    raise AgentRuntimeError(
                        "invalid_response",
                        "AI Gateway returned a tool call without an id",
                        status=200,
                        retryable=False,
                    )
                if not isinstance(result.get("name"), str) or not result["name"]:
                    raise ValueError("missing tool name")
                return result
            except AgentRuntimeError as error:
                last_error = error
                if not error.retryable:
                    raise
            except (KeyError, TypeError, ValueError) as error:
                raise AgentRuntimeError(
                    "invalid_response",
                    "AI Gateway returned an invalid tool call",
                    status=200,
                    retryable=False,
                ) from error
        raise last_error or AgentRuntimeError(
            "gateway_unavailable",
            "AI Gateway retry loop exhausted",
            status=None,
            retryable=True,
        )

    def embeddings(self, body: EmbeddingRequest) -> dict[str, Any]:
        try:
            result = self._post(
                "/v1/embeddings",
                {"texts": body.texts, "timeout_ms": body.timeout_ms},
                body.timeout_ms,
            )
            embeddings = result["embeddings"]
            if not isinstance(embeddings, list) or len(embeddings) != len(body.texts):
                raise ValueError("incomplete embeddings")
            return result
        except AgentRuntimeError:
            raise
        except (KeyError, TypeError, ValueError) as error:
            raise AgentRuntimeError(
                "invalid_response",
                "AI Gateway returned invalid embeddings",
                status=200,
                retryable=False,
            ) from error

    def readiness(self) -> bool:
        try:
            with self.open_url(f"{self.settings.ai_gateway_url}/health/ready", timeout=3) as response:
                return int(response.status) == 200
        except (HTTPError, URLError, TimeoutError, socket.timeout):
            return False

