from __future__ import annotations

import json
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError as PydanticValidationError

from .gateway_client import AgentRuntimeError
from .graph import AgentGraph
from .models import NextToolRequest, ValidationError, _bounded_int


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class QualitySlot(StrictModel):
    objective: str
    type: str
    difficulty: int
    required: bool
    source_block_indexes: list[int] = Field(alias="sourceBlockIndexes")


class QualityCard(StrictModel):
    id: str = Field(alias="cardId", pattern=r"^0x[0-9a-fA-F]{64}$")
    type: str
    question: str
    answer: str
    key_point: str = Field(alias="keyPoint")
    source: dict[str, Any]
    importance: int
    initial_difficulty: int = Field(alias="initialDifficulty")


class EvidenceBlock(StrictModel):
    block_index: int = Field(alias="blockIndex")
    page_number: int | None = Field(alias="pageNumber")
    text: str


class CardQualityRequest(StrictModel):
    concept_name: str = Field(alias="conceptName")
    slot: QualitySlot
    card: QualityCard
    evidence_blocks: list[EvidenceBlock] = Field(alias="evidenceBlocks")
    rubric_minimums: dict[str, int] = Field(alias="rubricMinimums")
    timeout_ms: int = 120_000
    max_completion_tokens: int = 4_096


class CardQualityEvaluation(StrictModel):
    card_id: str = Field(alias="cardId", pattern=r"^0x[0-9a-fA-F]{64}$")
    citation_sufficient: bool = Field(alias="citationSufficient")
    factuality: int = Field(ge=0, le=5)
    learning_value: int = Field(alias="learningValue", ge=0, le=5)
    clarity: int = Field(ge=0, le=5)
    completeness: int = Field(ge=0, le=5)
    citation_relevance: int = Field(alias="citationRelevance", ge=0, le=5)
    difficulty_fit: int = Field(alias="difficultyFit", ge=0, le=5)
    verdict: Literal["ACCEPT", "REPAIR", "REJECT"]
    reasons: list[Annotated[str, Field(min_length=1, max_length=500)]] = Field(
        max_length=8
    )


SUBMIT_QUALITY_TOOL = {
    "name": "submit_card_quality_evaluation",
    "description": (
        "Submit evidence sufficiency, six Rubric scores, a verdict, and actionable reasons."
    ),
    "parameters": CardQualityEvaluation.model_json_schema(by_alias=True),
}


def validate_card_quality_request(value: object) -> CardQualityRequest:
    try:
        request = CardQualityRequest.model_validate(value)
        request.timeout_ms = _bounded_int(
            request.timeout_ms, "timeout_ms", 1_000, 600_000
        )
        request.max_completion_tokens = _bounded_int(
            request.max_completion_tokens,
            "max_completion_tokens",
            1,
            32_768,
        )
        if not request.rubric_minimums or any(
            isinstance(score, bool) or not 0 <= score <= 5
            for score in request.rubric_minimums.values()
        ):
            raise ValidationError("rubricMinimums must contain scores between 0 and 5")
        return request
    except PydanticValidationError as error:
        raise ValidationError("card quality request is invalid") from error


class CardQualityGraph:
    prompt_version = "card-rubric-langgraph-v1"

    def __init__(self, agent_graph: AgentGraph) -> None:
        self.agent_graph = agent_graph

    def evaluate(self, request: CardQualityRequest) -> dict[str, Any]:
        minimums = json.dumps(
            request.rubric_minimums, ensure_ascii=False, separators=(",", ":")
        )
        task = {
            "conceptName": request.concept_name,
            "slot": request.slot.model_dump(by_alias=True),
            "card": request.card.model_dump(by_alias=True),
            "evidence": [
                block.model_dump(by_alias=True) for block in request.evidence_blocks
            ],
        }
        call = self.agent_graph.next_tool(
            NextToolRequest(
                profile="evaluation",
                system=" ".join(
                    [
                        "You are the Mindmark Card Quality Evaluator.",
                        "Judge only the supplied Card Blueprint Slot, Knowledge Card, and Source Block evidence.",
                        "First decide whether the quoted evidence is sufficient for every material claim in the answer.",
                        "Then score factuality, learning value, clarity, completeness, citation relevance, and difficulty fit from 0 to 5.",
                        f"Use these minimum scores for ACCEPT: {minimums}.",
                        "Do not use external knowledge.",
                        "ACCEPT only when the evidence is sufficient and every minimum is met.",
                        "Give concise, actionable repair reasons and submit exactly one structured evaluation.",
                    ]
                ),
                task=json.dumps(task, ensure_ascii=False, separators=(",", ":")),
                tools=[SUBMIT_QUALITY_TOOL],
                transcript=[],
                timeout_ms=request.timeout_ms,
                max_completion_tokens=request.max_completion_tokens,
            )
        )
        if call["name"] != SUBMIT_QUALITY_TOOL["name"]:
            raise AgentRuntimeError(
                "invalid_response",
                "Card quality model called an unknown tool",
                status=200,
                retryable=False,
            )
        try:
            evaluation = CardQualityEvaluation.model_validate(call["arguments"])
        except PydanticValidationError as error:
            raise AgentRuntimeError(
                "invalid_response",
                "Card quality model returned an invalid evaluation",
                status=200,
                retryable=False,
            ) from error
        if evaluation.card_id != request.card.id:
            raise AgentRuntimeError(
                "invalid_response",
                "Card quality model returned the wrong cardId",
                status=200,
                retryable=False,
            )
        return {
            "evaluation": evaluation.model_dump(by_alias=True),
            "model": "agent-runner:evaluation",
            "prompt_version": self.prompt_version,
        }
