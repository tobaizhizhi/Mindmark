from __future__ import annotations

import json
import socket
from typing import Any, Callable, Iterator
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .config import RunnerSettings
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
    ) -> None:
        self.settings = settings
        self.open_url = open_url

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

    def call_tool(
        self,
        *,
        profile: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        timeout_ms: int,
        max_completion_tokens: int,
    ) -> dict[str, Any]:
        payload = {
            "profile": profile,
            "messages": messages,
            "tools": tools,
            "timeout_ms": timeout_ms,
            "temperature": 0 if profile == "evaluation" else 0.2,
            "max_completion_tokens": max_completion_tokens,
            "tool_choice": "required",
        }
        try:
            response = self._post("/v1/tool-calls", payload, timeout_ms)
            result = response["result"]
            if not isinstance(result, dict):
                raise ValueError("tool call is not an object")
            if not isinstance(result.get("id"), str) or not result["id"]:
                raise ValueError("missing tool call id")
            if not isinstance(result.get("name"), str) or not result["name"]:
                raise ValueError("missing tool name")
            if not isinstance(result.get("arguments"), dict):
                raise ValueError("tool arguments are not an object")
            telemetry = response.get("telemetry")
            return {
                "result": result,
                "telemetry": telemetry if isinstance(telemetry, dict) else {},
            }
        except AgentRuntimeError:
            raise
        except (KeyError, TypeError, ValueError) as error:
            raise AgentRuntimeError(
                "invalid_response",
                "AI Gateway returned an invalid tool call",
                status=200,
                retryable=False,
            ) from error

    def stream_tool(
        self,
        *,
        profile: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        timeout_ms: int,
        max_completion_tokens: int,
    ) -> Iterator[dict[str, Any]]:
        incoming = Request(
            f"{self.settings.ai_gateway_url}/v1/tool-calls/stream",
            data=json.dumps(
                {
                    "profile": profile,
                    "messages": messages,
                    "tools": tools,
                    "timeout_ms": timeout_ms,
                    "temperature": 0.2,
                    "max_completion_tokens": max_completion_tokens,
                    "tool_choice": "required",
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode(),
            headers={
                "Authorization": f"Bearer {self.settings.ai_gateway_token}",
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
            },
            method="POST",
        )
        completed = False
        try:
            with self.open_url(incoming, timeout=(timeout_ms / 1_000) + 5) as response:
                data_lines: list[str] = []
                for raw_line in response:
                    line = raw_line.decode("utf-8").rstrip("\r\n")
                    if line.startswith("data:"):
                        data_lines.append(line[5:].lstrip())
                        continue
                    if line or not data_lines:
                        continue
                    event = json.loads("\n".join(data_lines))
                    data_lines = []
                    if not isinstance(event, dict):
                        raise ValueError("stream event is not an object")
                    if event.get("type") == "error":
                        detail = event.get("error")
                        if not isinstance(detail, dict):
                            raise ValueError("stream error is invalid")
                        raise AgentRuntimeError(
                            str(detail.get("code", "model_failed")),
                            str(detail.get("message", "AI Gateway stream failed")),
                            status=detail.get("status"),
                            retryable=bool(detail.get("retryable")),
                        )
                    if event.get("type") == "arguments_delta":
                        if not isinstance(event.get("delta"), str):
                            raise ValueError("stream delta is invalid")
                    elif event.get("type") == "result":
                        result = event.get("result")
                        if (
                            not isinstance(result, dict)
                            or not isinstance(result.get("name"), str)
                            or not isinstance(result.get("arguments"), dict)
                        ):
                            raise ValueError("stream result is invalid")
                        completed = True
                    else:
                        raise ValueError("stream event type is invalid")
                    yield event
                if data_lines or not completed:
                    raise ValueError("stream is incomplete")
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
        except (TypeError, ValueError, json.JSONDecodeError) as error:
            raise AgentRuntimeError(
                "invalid_response",
                "AI Gateway returned an invalid stream",
                status=200,
                retryable=False,
            ) from error

    def readiness(self) -> bool:
        try:
            with self.open_url(f"{self.settings.ai_gateway_url}/health/ready", timeout=3) as response:
                return int(response.status) == 200
        except (HTTPError, URLError, TimeoutError, socket.timeout):
            return False
