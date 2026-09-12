from __future__ import annotations

from dataclasses import dataclass
from typing import Any


class ValidationError(ValueError):
    pass


@dataclass(frozen=True)
class ToolCallRequest:
    profile: str
    messages: list[dict[str, Any]]
    tools: list[dict[str, Any]]
    timeout_ms: int
    temperature: float
    max_completion_tokens: int
    tool_choice: str | dict[str, Any]


@dataclass(frozen=True)
class EmbeddingRequest:
    texts: list[str]
    timeout_ms: int


def _bounded_int(value: object, name: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValidationError(f"{name} must be an integer between {minimum} and {maximum}")
    return value


def validate_tool_request(value: object) -> ToolCallRequest:
    if not isinstance(value, dict):
        raise ValidationError("request body must be an object")
    allowed = {
        "profile",
        "messages",
        "tools",
        "timeout_ms",
        "temperature",
        "max_completion_tokens",
        "tool_choice",
    }
    if unknown := set(value) - allowed:
        raise ValidationError(f"unknown fields: {', '.join(sorted(unknown))}")
    profile = value.get("profile")
    if profile not in {"generation", "design", "evaluation", "tutor"}:
        raise ValidationError("profile is invalid")
    messages = value.get("messages")
    if not isinstance(messages, list) or not 1 <= len(messages) <= 64:
        raise ValidationError("messages must contain 1 to 64 entries")
    for message in messages:
        if not isinstance(message, dict) or message.get("role") not in {
            "system",
            "user",
            "assistant",
            "tool",
        }:
            raise ValidationError("messages contain an invalid entry")
    tools = value.get("tools")
    if not isinstance(tools, list) or not 1 <= len(tools) <= 32:
        raise ValidationError("tools must contain 1 to 32 entries")
    for tool in tools:
        if (
            not isinstance(tool, dict)
            or not isinstance(tool.get("name"), str)
            or not tool["name"]
            or not isinstance(tool.get("description"), str)
            or not isinstance(tool.get("parameters"), dict)
        ):
            raise ValidationError("tools contain an invalid entry")
    temperature_value = value.get("temperature", 0.2)
    if isinstance(temperature_value, bool) or not isinstance(temperature_value, (int, float)):
        raise ValidationError("temperature must be a number")
    temperature = float(temperature_value)
    if not 0 <= temperature <= 2:
        raise ValidationError("temperature must be between 0 and 2")
    tool_choice = value.get("tool_choice", "required")
    if tool_choice != "required" and not isinstance(tool_choice, dict):
        raise ValidationError("tool_choice is invalid")
    return ToolCallRequest(
        profile=profile,
        messages=messages,
        tools=tools,
        timeout_ms=_bounded_int(value.get("timeout_ms", 120_000), "timeout_ms", 1_000, 600_000),
        temperature=temperature,
        max_completion_tokens=_bounded_int(
            value.get("max_completion_tokens", 4_096),
            "max_completion_tokens",
            1,
            32_768,
        ),
        tool_choice=tool_choice,
    )


def validate_embedding_request(value: object) -> EmbeddingRequest:
    if not isinstance(value, dict) or set(value) - {"texts", "timeout_ms"}:
        raise ValidationError("embedding request body is invalid")
    texts = value.get("texts")
    if (
        not isinstance(texts, list)
        or not 1 <= len(texts) <= 256
        or any(not isinstance(text, str) for text in texts)
    ):
        raise ValidationError("texts must contain 1 to 256 strings")
    return EmbeddingRequest(
        texts=texts,
        timeout_ms=_bounded_int(value.get("timeout_ms", 60_000), "timeout_ms", 1_000, 600_000),
    )

