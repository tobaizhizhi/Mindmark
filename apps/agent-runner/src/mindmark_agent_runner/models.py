from __future__ import annotations

from dataclasses import dataclass
from typing import Any


class ValidationError(ValueError):
    pass


@dataclass(frozen=True)
class NextToolRequest:
    profile: str
    system: str
    task: str
    tools: list[dict[str, Any]]
    transcript: list[dict[str, Any]]
    timeout_ms: int
    max_completion_tokens: int


def _bounded_int(value: object, name: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValidationError(f"{name} must be an integer between {minimum} and {maximum}")
    return value


def validate_next_tool_request(value: object) -> NextToolRequest:
    if not isinstance(value, dict):
        raise ValidationError("request body must be an object")
    allowed = {
        "profile",
        "system",
        "task",
        "tools",
        "transcript",
        "timeout_ms",
        "max_completion_tokens",
    }
    if unknown := set(value) - allowed:
        raise ValidationError(f"unknown fields: {', '.join(sorted(unknown))}")
    profile = value.get("profile")
    if profile not in {"generation", "design", "evaluation"}:
        raise ValidationError("profile is invalid")
    system = value.get("system")
    task = value.get("task")
    if not isinstance(system, str) or not 1 <= len(system) <= 32_000:
        raise ValidationError("system must contain 1 to 32000 characters")
    if not isinstance(task, str) or not 1 <= len(task) <= 2_000_000:
        raise ValidationError("task must contain 1 to 2000000 characters")
    tools = value.get("tools")
    if not isinstance(tools, list) or not 1 <= len(tools) <= 32:
        raise ValidationError("tools must contain 1 to 32 entries")
    transcript = value.get("transcript", [])
    if not isinstance(transcript, list) or len(transcript) > 16:
        raise ValidationError("transcript must contain at most 16 entries")
    for entry in transcript:
        if not isinstance(entry, dict) or not isinstance(entry.get("call"), dict) or "result" not in entry:
            raise ValidationError("transcript contains an invalid entry")
        call = entry["call"]
        if not all(isinstance(call.get(field), str) and call[field] for field in ("id", "name")):
            raise ValidationError("transcript contains an invalid tool call")
        if not isinstance(call.get("arguments"), dict):
            raise ValidationError("transcript tool arguments must be an object")
    return NextToolRequest(
        profile=profile,
        system=system,
        task=task,
        tools=tools,
        transcript=transcript,
        timeout_ms=_bounded_int(value.get("timeout_ms", 120_000), "timeout_ms", 1_000, 600_000),
        max_completion_tokens=_bounded_int(
            value.get("max_completion_tokens", 4_096),
            "max_completion_tokens",
            1,
            32_768,
        ),
    )
