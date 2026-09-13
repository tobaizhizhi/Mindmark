from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError as PydanticValidationError

from .models import NextToolRequest, ValidationError


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, populate_by_name=True)


class DomainToolCall(StrictModel):
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    arguments: dict[str, Any]


class DomainTranscriptEntry(StrictModel):
    call: DomainToolCall
    result: Any


class DomainTurnRequest(StrictModel):
    context: dict[str, Any]
    transcript: list[DomainTranscriptEntry] = Field(default_factory=list, max_length=16)
    timeout_ms: int = Field(default=120_000, ge=1_000, le=600_000)
    max_completion_tokens: int = Field(default=4_096, ge=1, le=32_768)


def validate_domain_turn_request(value: object) -> DomainTurnRequest:
    try:
        return DomainTurnRequest.model_validate(value)
    except PydanticValidationError as error:
        raise ValidationError("domain agent request is invalid") from error


def next_tool_request(
    request: DomainTurnRequest,
    *,
    profile: str,
    system: str,
    task: str,
    tools: list[dict[str, Any]],
) -> NextToolRequest:
    return NextToolRequest(
        profile=profile,
        system=system,
        task=task,
        tools=tools,
        transcript=[entry.model_dump() for entry in request.transcript],
        timeout_ms=request.timeout_ms,
        max_completion_tokens=request.max_completion_tokens,
    )


def language_instruction(output_language: str) -> str:
    if output_language == "zh-CN":
        return "Write every learner-facing field in Simplified Chinese."
    if output_language == "en":
        return "Write every learner-facing field in English."
    raise ValidationError("outputLanguage is invalid")
