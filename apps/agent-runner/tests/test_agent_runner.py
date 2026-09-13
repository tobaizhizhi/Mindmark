from __future__ import annotations

import json
from typing import Any
import unittest
from urllib.error import URLError

from langgraph.types import RetryPolicy

from mindmark_agent_runner.config import RunnerSettings
from mindmark_agent_runner.domain_turn import validate_domain_turn_request
from mindmark_agent_runner.graph import AgentGraph, retryable_gateway_error
from mindmark_agent_runner.gateway_client import AgentRuntimeError, AiGatewayClient
from mindmark_agent_runner.models import validate_next_tool_request
from mindmark_agent_runner.quality import validate_card_quality_request
from mindmark_agent_runner.runtime import AgentRuntime
from mindmark_agent_runner.tutor import (
    build_tutor_context,
    extract_partial_json_string_property,
    validate_chapter_tutor_request,
)


class FakeResponse:
    status = 200

    def __init__(self, payload: object) -> None:
        self.body = json.dumps(payload).encode()

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def read(self) -> bytes:
        return self.body


class FakeStreamResponse:
    status = 200

    def __init__(self, events: list[dict[str, Any]]) -> None:
        self.lines = [
            line
            for event in events
            for line in (
                f"data: {json.dumps(event, ensure_ascii=False)}\n".encode(),
                b"\n",
            )
        ]

    def __enter__(self) -> FakeStreamResponse:
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def __iter__(self):
        return iter(self.lines)


class AgentRunnerTests(unittest.TestCase):
    @staticmethod
    def settings() -> RunnerSettings:
        return RunnerSettings(
            internal_token="runner-secret",
            ai_gateway_url="https://gateway.example",
            ai_gateway_token="gateway-secret",
        )

    def test_translates_agent_transcript_to_gateway_messages(self) -> None:
        settings = RunnerSettings(
            internal_token="runner-secret",
            ai_gateway_url="https://gateway.example",
            ai_gateway_token="gateway-secret",
        )

        def open_url(incoming: Any, **_: object) -> FakeResponse:
            self.assertEqual(incoming.headers["Authorization"], "Bearer gateway-secret")
            payload = json.loads(incoming.data)
            self.assertEqual(
                [message["role"] for message in payload["messages"]],
                ["system", "user", "assistant", "tool"],
            )
            self.assertEqual(payload["profile"], "design")
            return FakeResponse(
                {
                    "result": {
                        "id": "call-2",
                        "name": "submit",
                        "arguments": {"ok": True},
                    },
                    "telemetry": {
                        "duration_ms": 1,
                        "model": "test-model",
                        "outcome": "success",
                        "provider_status": 200,
                        "prompt_tokens": 1,
                        "completion_tokens": 1,
                        "total_tokens": 2,
                    },
                }
            )

        body = validate_next_tool_request(
            {
                "profile": "design",
                "system": "Use tools.",
                "task": "Submit a result.",
                "tools": [
                    {
                        "name": "submit",
                        "description": "Submit",
                        "parameters": {"type": "object"},
                    }
                ],
                "transcript": [
                    {
                        "call": {"id": "call-1", "name": "read", "arguments": {}},
                        "result": {"context": "bounded"},
                    }
                ],
            }
        )
        result = AgentGraph(AiGatewayClient(settings, open_url)).next_tool(body)
        self.assertEqual(
            result,
            {"id": "call-2", "name": "submit", "arguments": {"ok": True}},
        )

    def test_marks_exhausted_gateway_retries_as_final_for_the_caller(self) -> None:
        attempts = 0

        def open_url(_: Any, **__: object) -> FakeResponse:
            nonlocal attempts
            attempts += 1
            raise URLError("gateway unavailable")

        body = validate_next_tool_request(
            {
                "profile": "generation",
                "system": "Use tools.",
                "task": "Submit a result.",
                "tools": [
                    {
                        "name": "submit",
                        "description": "Submit",
                        "parameters": {"type": "object"},
                    }
                ],
            }
        )
        graph = AgentGraph(
            AiGatewayClient(
                RunnerSettings(
                    internal_token="runner-secret",
                    ai_gateway_url="https://gateway.example",
                    ai_gateway_token="gateway-secret",
                ),
                open_url,
            ),
            retry_policy=RetryPolicy(
                initial_interval=0,
                backoff_factor=1,
                max_interval=0,
                max_attempts=3,
                jitter=False,
                retry_on=retryable_gateway_error,
            ),
        )

        with self.assertRaises(AgentRuntimeError) as raised:
            graph.next_tool(body)

        self.assertEqual(attempts, 3)
        self.assertFalse(raised.exception.retryable)

    def test_card_quality_prompt_and_schema_are_owned_by_python_runtime(self) -> None:
        card_id = f"0x{'6' * 64}"

        def open_url(incoming: Any, **_: object) -> FakeResponse:
            payload = json.loads(incoming.data)
            self.assertEqual(payload["profile"], "evaluation")
            self.assertIn("Card Quality Evaluator", payload["messages"][0]["content"])
            self.assertEqual(
                payload["tools"][0]["name"],
                "submit_card_quality_evaluation",
            )
            self.assertFalse(
                payload["tools"][0]["parameters"]["additionalProperties"]
            )
            return FakeResponse(
                {
                    "result": {
                        "id": "quality-call",
                        "name": "submit_card_quality_evaluation",
                        "arguments": {
                            "cardId": card_id,
                            "citationSufficient": True,
                            "factuality": 5,
                            "learningValue": 4,
                            "clarity": 4,
                            "completeness": 4,
                            "citationRelevance": 5,
                            "difficultyFit": 4,
                            "verdict": "ACCEPT",
                            "reasons": [],
                        },
                    },
                    "telemetry": {"model": "quality-model"},
                }
            )

        request = validate_card_quality_request(
            {
                "conceptName": "checks-effects-interactions",
                "slot": {
                    "objective": "Explain safe external-call ordering",
                    "type": "application",
                    "difficulty": 4,
                    "required": True,
                    "sourceBlockIndexes": [3],
                },
                "card": {
                    "cardId": card_id,
                    "type": "qa",
                    "question": "Why update state first?",
                    "answer": "It prevents reuse of stale state.",
                    "keyPoint": "Update before interaction",
                    "source": {"page": 2, "quote": "update state first"},
                    "importance": 5,
                    "initialDifficulty": 4,
                },
                "evidenceBlocks": [
                    {
                        "blockIndex": 3,
                        "pageNumber": 2,
                        "text": "update state first",
                    }
                ],
                "rubricMinimums": {
                    "factuality": 4,
                    "learningValue": 3,
                    "clarity": 3,
                    "completeness": 3,
                    "citationRelevance": 4,
                    "difficultyFit": 3,
                },
            }
        )
        runtime = AgentRuntime(
            AiGatewayClient(
                RunnerSettings(
                    internal_token="runner-secret",
                    ai_gateway_url="https://gateway.example",
                    ai_gateway_token="gateway-secret",
                ),
                open_url,
            )
        )

        response = runtime.evaluate_card(request)

        self.assertEqual(response["evaluation"]["cardId"], card_id)
        self.assertEqual(response["prompt_version"], "card-rubric-langgraph-v1")

    def test_domain_prompts_and_tool_schemas_are_owned_by_python(self) -> None:
        requests: list[dict[str, Any]] = []
        calls = iter(
            [
                {"id": "outline", "name": "read_source_outline", "arguments": {}},
                {
                    "id": "concepts",
                    "name": "propose_chapter_concepts",
                    "arguments": {"concepts": []},
                },
                {
                    "id": "cards",
                    "name": "save_work_unit_draft",
                    "arguments": {"cards": []},
                },
            ]
        )

        def open_url(incoming: Any, **_: object) -> FakeResponse:
            payload = json.loads(incoming.data)
            requests.append(payload)
            return FakeResponse(
                {
                    "result": next(calls),
                    "telemetry": {"model": "test-model"},
                }
            )

        runtime = AgentRuntime(AiGatewayClient(self.settings(), open_url))
        outline = runtime.next_outline_tool(
            validate_domain_turn_request(
                {
                    "context": {
                        "projectId": f"0x{'1' * 64}",
                        "goal": "Learn scheduling",
                        "chapterBudget": {
                            "minChapters": 1,
                            "targetChapters": 2,
                            "maxChapters": 3,
                        },
                        "outputLanguage": "en",
                    },
                    "transcript": [],
                }
            )
        )
        design = runtime.next_chapter_design_tool(
            validate_domain_turn_request(
                {
                    "context": {
                        "phase": "inventory",
                        "goal": "理解重入",
                        "chapter": {
                            "chapterId": 0,
                            "title": "重入防御",
                            "summary": "理解调用顺序",
                            "sourceRange": [0, 1],
                        },
                        "policy": {
                            "importantConceptNeedsRequiredSlot": True,
                            "importantMisconceptionNeedsRequiredSlot": True,
                            "cardTypes": ["concept", "application"],
                            "cardCount": {"minimum": 1, "target": 2, "maximum": 3},
                        },
                        "outputLanguage": "zh-CN",
                        "blocks": [
                            {
                                "blockIndex": 0,
                                "pageNumber": 1,
                                "kind": "paragraph",
                                "text": "外部调用前更新状态。",
                            }
                        ],
                    },
                    "transcript": [],
                }
            )
        )
        worker = runtime.next_blueprint_worker_tool(
            validate_domain_turn_request(
                {
                    "context": {
                        "chapterId": 0,
                        "chapterTitle": "重入防御",
                        "slotCount": 1,
                        "outputLanguage": "zh-CN",
                    },
                    "transcript": [
                        {
                            "call": {
                                "id": "server-read",
                                "name": "read_assigned_work_unit",
                                "arguments": {},
                            },
                            "result": {"blocks": [{"text": "untrusted source"}]},
                        }
                    ],
                }
            )
        )

        self.assertEqual(outline["prompt_version"], "outline-planning-langgraph-v1")
        self.assertEqual(design["prompt_version"], "chapter-design-langgraph-v1")
        self.assertEqual(worker["prompt_version"], "blueprint-worker-langgraph-v1")
        self.assertEqual(
            [tool["name"] for tool in requests[0]["tools"]],
            ["read_source_outline", "propose_chapters"],
        )
        self.assertEqual(requests[1]["tools"][0]["name"], "propose_chapter_concepts")
        self.assertEqual(requests[2]["tools"][0]["name"], "save_work_unit_draft")
        for payload in requests:
            self.assertIn("untrusted", payload["messages"][0]["content"].lower())

    def test_tutor_retrieval_prompt_and_partial_stream_parsing_live_in_python(self) -> None:
        request = validate_chapter_tutor_request(
            {
                "question": "为什么时间片不能太小？",
                "currentPage": 11,
                "selectedText": "频繁上下文切换",
                "history": [],
                "reading": {
                    "title": "CPU 调度",
                    "blocks": [
                        {
                            "blockId": "source-block-1",
                            "position": 0,
                            "kind": "heading",
                            "text": "时间片轮转",
                            "pageNumber": 10,
                        },
                        {
                            "blockId": "source-block-2",
                            "position": 1,
                            "kind": "paragraph",
                            "text": "时间片过小会导致频繁上下文切换。",
                            "pageNumber": 11,
                        },
                    ],
                },
            }
        )
        context = build_tutor_context(request)
        self.assertLess(context.index("source-block-2"), context.index("source-block-1"))
        self.assertLessEqual(len(context), 24_000)
        self.assertEqual(
            extract_partial_json_string_property('{"answer":"先给\\n结论', "answer"),
            "先给\n结论",
        )
        self.assertEqual(
            extract_partial_json_string_property(
                '{"citations":[],"answer":"回答"}', "answer"
            ),
            "回答",
        )

        def open_url(incoming: Any, **_: object) -> FakeResponse:
            payload = json.loads(incoming.data)
            task = json.loads(payload["messages"][1]["content"])
            self.assertLess(
                task["sourceContext"].index("source-block-2"),
                task["sourceContext"].index("source-block-1"),
            )
            self.assertEqual(payload["tools"][0]["name"], "answer_pdf_question")
            return FakeResponse(
                {
                    "result": {
                        "id": "tutor",
                        "name": "answer_pdf_question",
                        "arguments": {
                            "answer": "上下文切换会增加开销。",
                            "citations": [
                                {
                                    "blockId": "source-block-2",
                                    "pageNumber": 11,
                                    "quote": "频繁上下文切换",
                                }
                            ],
                            "suggestedQuestions": [],
                        },
                    },
                    "telemetry": {"model": "tutor-model"},
                }
            )

        response = AgentRuntime(
            AiGatewayClient(self.settings(), open_url)
        ).answer_chapter_tutor(request)
        self.assertEqual(response["prompt_version"], "chapter-tutor-langgraph-v1")

    def test_tutor_stream_does_not_retry_after_emitting_an_answer(self) -> None:
        request = validate_chapter_tutor_request(
            {
                "question": "什么是重入？",
                "currentPage": 1,
                "selectedText": None,
                "history": [],
                "reading": {
                    "title": "重入",
                    "blocks": [
                        {
                            "blockId": "source-block-1",
                            "position": 0,
                            "kind": "paragraph",
                            "text": "外部调用会转移控制权。",
                            "pageNumber": 1,
                        }
                    ],
                },
            }
        )
        attempts = 0

        def open_url(_: Any, **__: object) -> FakeStreamResponse:
            nonlocal attempts
            attempts += 1
            return FakeStreamResponse(
                [
                    {"type": "arguments_delta", "delta": '{"answer":"已经输出'},
                    {
                        "type": "error",
                        "error": {
                            "code": "model_failed",
                            "message": "upstream disconnected",
                            "status": 503,
                            "retryable": True,
                        },
                    },
                ]
            )

        stream = AgentRuntime(
            AiGatewayClient(self.settings(), open_url)
        ).stream_chapter_tutor(request)
        self.assertEqual(next(stream), {"type": "answer_delta", "delta": "已经输出"})
        with self.assertRaises(AgentRuntimeError):
            next(stream)
        self.assertEqual(attempts, 1)


if __name__ == "__main__":
    unittest.main()
