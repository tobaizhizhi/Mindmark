from __future__ import annotations

from collections.abc import Iterator
import json
import socket
import time
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .config import GatewaySettings, ModelTarget
from .models import EmbeddingRequest, ToolCallRequest


OpenUrl = Callable[..., Any]


class GatewayError(Exception):
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


def status_error(status: int) -> GatewayError:
    if status == 429:
        return GatewayError(
            "rate_limited",
            "AI model request failed with status 429",
            status=status,
            retryable=True,
        )
    return GatewayError(
        "model_failed",
        f"AI model request failed with status {status}",
        status=status,
        retryable=status >= 500,
    )


def transport_error(error: Exception) -> GatewayError:
    if isinstance(error, GatewayError):
        return error
    if isinstance(error, (TimeoutError, socket.timeout)):
        return GatewayError(
            "timed_out", "AI model request timed out", status=None, retryable=True
        )
    return GatewayError(
        "model_failed", "AI model request failed", status=None, retryable=True
    )


class ModelGateway:
    def __init__(self, settings: GatewaySettings, open_url: OpenUrl = urlopen) -> None:
        self.settings = settings
        self.open_url = open_url

    @staticmethod
    def _payload(request: ToolCallRequest, target: ModelTarget, *, stream: bool) -> dict[str, Any]:
        payload: dict[str, Any] = {
            **(target.provider_options or {}),
            "model": target.model,
            "temperature": request.temperature,
            target.max_tokens_parameter: request.max_completion_tokens,
            "parallel_tool_calls": False,
            "tool_choice": request.tool_choice,
            "messages": request.messages,
            "tools": [{"type": "function", "function": tool} for tool in request.tools],
        }
        if stream:
            payload.update({"stream": True, "stream_options": {"include_usage": True}})
        return payload

    @staticmethod
    def _request(
        url: str,
        target: ModelTarget,
        payload: dict[str, Any],
        *,
        stream: bool = False,
    ) -> Request:
        headers = {
            "Authorization": f"Bearer {target.api_key}",
            "Content-Type": "application/json",
        }
        if stream:
            headers["Accept"] = "text/event-stream"
        return Request(
            url,
            data=json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode(),
            headers=headers,
            method="POST",
        )

    def call_tool(self, request: ToolCallRequest) -> dict[str, Any]:
        primary = self.settings.target(request.profile)
        try:
            return self._call_target(request, primary)
        except GatewayError as error:
            fallback = self.settings.fallback_target()
            if not fallback or not error.retryable:
                raise
            return self._call_target(request, fallback)

    def _call_target(self, request: ToolCallRequest, target: ModelTarget) -> dict[str, Any]:
        started_at = time.monotonic()
        status: int | None = None
        incoming = self._request(
            f"{target.base_url}/chat/completions",
            target,
            self._payload(request, target, stream=False),
        )
        try:
            with self.open_url(incoming, timeout=request.timeout_ms / 1_000) as response:
                status = int(response.status)
                payload = json.loads(response.read())
        except HTTPError as error:
            raise status_error(error.code) from error
        except (URLError, TimeoutError, socket.timeout) as error:
            raise transport_error(error) from error
        try:
            call = payload["choices"][0]["message"]["tool_calls"][0]
            result = {
                "id": call.get("id"),
                "name": call["function"]["name"],
                "arguments": json.loads(call["function"]["arguments"]),
            }
            usage = payload.get("usage") or {}
        except (KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError) as error:
            raise GatewayError(
                "invalid_response",
                "AI model returned invalid tool response",
                status=status,
                retryable=False,
            ) from error
        return {
            "result": result,
            "telemetry": {
                "duration_ms": int((time.monotonic() - started_at) * 1_000),
                "model": target.model,
                "outcome": "success",
                "provider_status": status,
                "prompt_tokens": usage.get("prompt_tokens"),
                "completion_tokens": usage.get("completion_tokens"),
                "total_tokens": usage.get("total_tokens"),
            },
        }

    def stream_tool(self, request: ToolCallRequest) -> Iterator[dict[str, Any]]:
        primary = self.settings.target(request.profile)
        emitted = False
        try:
            for event in self._stream_target(request, primary):
                emitted = True
                yield event
        except GatewayError as error:
            fallback = self.settings.fallback_target()
            if emitted or not fallback or not error.retryable:
                raise
            yield from self._stream_target(request, fallback)

    def _stream_target(
        self, request: ToolCallRequest, target: ModelTarget
    ) -> Iterator[dict[str, Any]]:
        incoming = self._request(
            f"{target.base_url}/chat/completions",
            target,
            self._payload(request, target, stream=True),
            stream=True,
        )
        call_id: str | None = None
        call_name: str | None = None
        argument_text = ""
        saw_done = False
        try:
            response_context = self.open_url(incoming, timeout=request.timeout_ms / 1_000)
            with response_context as response:
                status = int(response.status)
                data_lines: list[str] = []
                for raw_line in response:
                    line = raw_line.decode("utf-8").rstrip("\r\n")
                    if line.startswith("data:"):
                        data_lines.append(line[5:].lstrip())
                        continue
                    if line or not data_lines:
                        continue
                    frame = "\n".join(data_lines)
                    data_lines = []
                    if frame == "[DONE]":
                        saw_done = True
                        continue
                    try:
                        payload = json.loads(frame)
                        for choice in payload.get("choices") or []:
                            for call in choice.get("delta", {}).get("tool_calls", []):
                                if call.get("index") != 0:
                                    continue
                                call_id = call.get("id") or call_id
                                function = call.get("function") or {}
                                call_name = function.get("name") or call_name
                                delta = function.get("arguments") or ""
                                if delta:
                                    argument_text += delta
                                    yield {"type": "arguments_delta", "delta": delta}
                    except (TypeError, ValueError, json.JSONDecodeError) as error:
                        raise GatewayError(
                            "invalid_response",
                            "AI model returned invalid stream data",
                            status=status,
                            retryable=False,
                        ) from error
                if data_lines or not call_name or not argument_text or not saw_done:
                    raise GatewayError(
                        "invalid_response",
                        "AI model returned an incomplete stream",
                        status=status,
                        retryable=False,
                    )
        except HTTPError as error:
            raise status_error(error.code) from error
        except (URLError, TimeoutError, socket.timeout) as error:
            raise transport_error(error) from error
        try:
            arguments = json.loads(argument_text)
        except json.JSONDecodeError as error:
            raise GatewayError(
                "invalid_response",
                "AI model returned invalid tool arguments",
                status=status,
                retryable=False,
            ) from error
        yield {
            "type": "result",
            "result": {"id": call_id, "name": call_name, "arguments": arguments},
        }

    def embeddings(self, request: EmbeddingRequest) -> dict[str, Any]:
        try:
            target = self.settings.target("embedding")
        except ValueError as error:
            raise GatewayError(
                "not_configured", str(error), status=None, retryable=False
            ) from error
        incoming = self._request(
            f"{target.base_url}/embeddings",
            target,
            {
                "model": target.model,
                "input": request.texts,
                "encoding_format": "float",
            },
        )
        try:
            with self.open_url(incoming, timeout=request.timeout_ms / 1_000) as response:
                status = int(response.status)
                payload = json.loads(response.read())
        except HTTPError as error:
            raise status_error(error.code) from error
        except (URLError, TimeoutError, socket.timeout) as error:
            raise transport_error(error) from error
        try:
            ordered = sorted(payload["data"], key=lambda item: item["index"])
            if len(ordered) != len(request.texts) or any(
                item["index"] != index for index, item in enumerate(ordered)
            ):
                raise ValueError("incomplete or unordered embeddings")
            embeddings = [[float(value) for value in item["embedding"]] for item in ordered]
            if not embeddings or any(len(item) != len(embeddings[0]) for item in embeddings):
                raise ValueError("inconsistent embedding dimensions")
        except (KeyError, TypeError, ValueError) as error:
            raise GatewayError(
                "invalid_response",
                "Embedding model returned an invalid response",
                status=status,
                retryable=False,
            ) from error
        return {"embeddings": embeddings, "model": target.model}

