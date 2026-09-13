from __future__ import annotations

from typing import Any, Sequence

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, convert_to_openai_messages
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.runnables import Runnable
from langchain_core.tools import BaseTool
from langchain_core.utils.function_calling import convert_to_openai_tool
from pydantic import ConfigDict

from .gateway_client import AiGatewayClient


class AiGatewayChatModel(BaseChatModel):
    """LangChain chat-model adapter for Mindmark's private AI Gateway."""

    gateway: AiGatewayClient
    model_config = ConfigDict(arbitrary_types_allowed=True)

    @property
    def _llm_type(self) -> str:
        return "mindmark-ai-gateway"

    @property
    def _identifying_params(self) -> dict[str, Any]:
        return {"gateway_url": self.gateway.settings.ai_gateway_url}

    def bind_tools(
        self,
        tools: Sequence[dict[str, Any] | type | Any | BaseTool],
        *,
        tool_choice: str | None = None,
        **kwargs: Any,
    ) -> Runnable[Any, AIMessage]:
        normalized = [convert_to_openai_tool(tool)["function"] for tool in tools]
        return self.bind(
            tools=normalized,
            tool_choice=tool_choice or "required",
            **kwargs,
        )

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        del stop
        wire_messages = convert_to_openai_messages(messages)
        if not isinstance(wire_messages, list):
            wire_messages = [wire_messages]
        response = self.gateway.call_tool(
            profile=str(kwargs["profile"]),
            messages=wire_messages,
            tools=list(kwargs["tools"]),
            timeout_ms=int(kwargs["timeout_ms"]),
            max_completion_tokens=int(kwargs["max_completion_tokens"]),
        )
        call = response["result"]
        message = AIMessage(
            content="",
            tool_calls=[
                {
                    "id": call["id"],
                    "name": call["name"],
                    "args": call["arguments"],
                    "type": "tool_call",
                }
            ],
            response_metadata={"telemetry": response["telemetry"]},
        )
        return ChatResult(generations=[ChatGeneration(message=message)])
