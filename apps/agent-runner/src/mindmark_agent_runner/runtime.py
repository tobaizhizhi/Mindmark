from __future__ import annotations

from typing import Any, Iterator

from langgraph.types import RetryPolicy

from .gateway_client import AiGatewayClient
from .chapter_design import ChapterDesignGraph
from .domain_turn import DomainTurnRequest
from .graph import AgentGraph
from .models import NextToolRequest
from .outline import OutlinePlanningGraph
from .quality import CardQualityGraph, CardQualityRequest
from .tutor import ChapterTutorGraph, ChapterTutorRequest
from .worker import BlueprintWorkerGraph


class AgentRuntime:
    """Deep module for model-driven work; external tools remain in Workflow Runner."""

    def __init__(
        self,
        gateway: AiGatewayClient,
        *,
        retry_policy: RetryPolicy | None = None,
    ) -> None:
        self.agent_graph = AgentGraph(gateway, retry_policy=retry_policy)
        self.card_quality = CardQualityGraph(self.agent_graph)
        self.outline_planning = OutlinePlanningGraph(self.agent_graph)
        self.chapter_design = ChapterDesignGraph(self.agent_graph)
        self.blueprint_worker = BlueprintWorkerGraph(self.agent_graph)
        self.chapter_tutor = ChapterTutorGraph(self.agent_graph, gateway)

    def next_tool(self, request: NextToolRequest) -> dict[str, Any]:
        return self.agent_graph.next_tool(request)

    def evaluate_card(self, request: CardQualityRequest) -> dict[str, Any]:
        return self.card_quality.evaluate(request)

    def next_outline_tool(self, request: DomainTurnRequest) -> dict[str, Any]:
        return self.outline_planning.next_tool(request)

    def next_chapter_design_tool(self, request: DomainTurnRequest) -> dict[str, Any]:
        return self.chapter_design.next_tool(request)

    def next_blueprint_worker_tool(self, request: DomainTurnRequest) -> dict[str, Any]:
        return self.blueprint_worker.next_tool(request)

    def answer_chapter_tutor(self, request: ChapterTutorRequest) -> dict[str, Any]:
        return self.chapter_tutor.answer(request)

    def stream_chapter_tutor(
        self, request: ChapterTutorRequest
    ) -> Iterator[dict[str, Any]]:
        return self.chapter_tutor.stream(request)

    def readiness(self) -> bool:
        return self.agent_graph.readiness()
