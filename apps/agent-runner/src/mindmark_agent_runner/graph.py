from __future__ import annotations

import json
from typing import Any, TypedDict

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langgraph.graph import END, START, StateGraph
from langgraph.types import RetryPolicy

from .gateway_client import AgentRuntimeError, AiGatewayClient
from .langchain_model import AiGatewayChatModel
from .models import NextToolRequest


class AgentGraphState(TypedDict, total=False):
    request: NextToolRequest
    messages: list[BaseMessage]
    response: AIMessage
    result: dict[str, Any]


def retryable_gateway_error(error: Exception) -> bool:
    return isinstance(error, AgentRuntimeError) and error.retryable


def transcript_messages(request: NextToolRequest) -> list[BaseMessage]:
    messages: list[BaseMessage] = [
        SystemMessage(content=request.system),
        HumanMessage(content=request.task),
    ]
    for entry in request.transcript:
        call = entry["call"]
        messages.extend(
            [
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "id": call["id"],
                            "name": call["name"],
                            "args": call["arguments"],
                            "type": "tool_call",
                        }
                    ],
                ),
                ToolMessage(
                    content=json.dumps(
                        entry["result"], ensure_ascii=False, separators=(",", ":")
                    ),
                    tool_call_id=call["id"],
                ),
            ]
        )
    return messages


class AgentGraph:
    """A LangGraph turn that stops at the external TypeScript tool seam."""

    def __init__(
        self,
        gateway: AiGatewayClient,
        *,
        retry_policy: RetryPolicy | None = None,
    ) -> None:
        self.gateway = gateway
        self.model = AiGatewayChatModel(gateway=gateway)
        builder = StateGraph(AgentGraphState)
        builder.add_node(
            "model",
            self._call_model,
            retry_policy=retry_policy
            or RetryPolicy(
                initial_interval=5,
                backoff_factor=3,
                max_interval=15,
                max_attempts=3,
                jitter=False,
                retry_on=retryable_gateway_error,
            ),
        )
        builder.add_node("select_external_tool", self._select_external_tool)
        builder.add_edge(START, "model")
        builder.add_edge("model", "select_external_tool")
        builder.add_edge("select_external_tool", END)
        self.compiled = builder.compile()

    def _call_model(self, state: AgentGraphState) -> dict[str, AIMessage]:
        request = state["request"]
        model = self.model.bind_tools(
            request.tools,
            tool_choice="required",
            profile=request.profile,
            timeout_ms=request.timeout_ms,
            max_completion_tokens=request.max_completion_tokens,
        )
        return {"response": model.invoke(state["messages"])}

    @staticmethod
    def _select_external_tool(state: AgentGraphState) -> dict[str, dict[str, Any]]:
        calls = state["response"].tool_calls
        if len(calls) != 1:
            raise AgentRuntimeError(
                "invalid_response",
                "AI Gateway must return exactly one tool call",
                status=200,
                retryable=False,
            )
        call = calls[0]
        return {
            "result": {
                "id": call["id"],
                "name": call["name"],
                "arguments": call["args"],
            }
        }

    def next_tool(self, request: NextToolRequest) -> dict[str, Any]:
        try:
            state = self.compiled.invoke(
                {"request": request, "messages": transcript_messages(request)},
                config={
                    "tags": ["mindmark-agent-runner", request.profile],
                    "metadata": {"profile": request.profile},
                },
            )
            return state["result"]
        except AgentRuntimeError as error:
            if not error.retryable:
                raise
            # LangGraph has exhausted this module's retry policy.
            raise AgentRuntimeError(
                error.code,
                str(error),
                status=error.status,
                retryable=False,
            ) from error

    def readiness(self) -> bool:
        return self.gateway.readiness()
