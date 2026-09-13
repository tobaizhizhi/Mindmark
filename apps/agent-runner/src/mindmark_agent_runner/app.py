from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hmac
import json
import os
from typing import Any

from .config import RunnerSettings
from .domain_turn import validate_domain_turn_request
from .gateway_client import AgentRuntimeError, AiGatewayClient
from .models import ValidationError, validate_next_tool_request
from .quality import validate_card_quality_request
from .runtime import AgentRuntime
from .tutor import validate_chapter_tutor_request


def handler_factory(settings: RunnerSettings, runtime: AgentRuntime) -> type[BaseHTTPRequestHandler]:
    class AgentHandler(BaseHTTPRequestHandler):
        server_version = "MindmarkAgentRunner/0.1"

        def log_message(self, format: str, *args: object) -> None:
            print(f"agent-runner {self.address_string()} {format % args}")

        def _authorized(self) -> bool:
            expected = f"Bearer {settings.internal_token}"
            supplied = self.headers.get("Authorization", "")
            return bool(settings.internal_token) and hmac.compare_digest(supplied, expected)

        def _json_body(self) -> object:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 4_000_000:
                raise ValidationError("request body size is invalid")
            try:
                return json.loads(self.rfile.read(length))
            except json.JSONDecodeError as error:
                raise ValidationError("request body is not valid JSON") from error

        def _send_json(self, status: int, body: Any) -> None:
            encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(encoded)

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/health/live":
                self._send_json(200, {"status": "ok", "service": "agent-runner"})
                return
            if self.path == "/health/ready":
                missing = settings.validation_errors()
                gateway_ready = not missing and runtime.readiness()
                self._send_json(
                    200 if gateway_ready else 503,
                    {
                        "status": "ready" if gateway_ready else "not_ready",
                        "missing": missing,
                        "ai_gateway": "ready" if gateway_ready else "unavailable",
                    },
                )
                return
            self._send_json(404, {"error": {"code": "not_found", "message": "Not found"}})

        def do_POST(self) -> None:  # noqa: N802
            if not self._authorized():
                self._send_json(401, {"error": {"code": "unauthorized", "message": "Unauthorized"}})
                return
            try:
                body = self._json_body()
                if self.path == "/v1/next-tool":
                    self._send_json(200, runtime.next_tool(validate_next_tool_request(body)))
                    return
                if self.path == "/v1/card-quality-evaluations":
                    self._send_json(
                        200,
                        runtime.evaluate_card(validate_card_quality_request(body)),
                    )
                    return
                if self.path == "/v1/outline-planning/next-tool":
                    self._send_json(
                        200,
                        runtime.next_outline_tool(validate_domain_turn_request(body)),
                    )
                    return
                if self.path == "/v1/chapter-design/next-tool":
                    self._send_json(
                        200,
                        runtime.next_chapter_design_tool(validate_domain_turn_request(body)),
                    )
                    return
                if self.path == "/v1/blueprint-worker/next-tool":
                    self._send_json(
                        200,
                        runtime.next_blueprint_worker_tool(validate_domain_turn_request(body)),
                    )
                    return
                if self.path == "/v1/chapter-tutor/answers":
                    self._send_json(
                        200,
                        runtime.answer_chapter_tutor(validate_chapter_tutor_request(body)),
                    )
                    return
                if self.path == "/v1/chapter-tutor/answers/stream":
                    self._stream_tutor(validate_chapter_tutor_request(body))
                    return
                self._send_json(404, {"error": {"code": "not_found", "message": "Not found"}})
            except ValidationError as error:
                self._send_json(400, {"error": {"code": "invalid_request", "message": str(error)}})
            except AgentRuntimeError as error:
                status = 429 if error.code == "rate_limited" else 504 if error.code == "timed_out" else 502
                if error.code == "not_configured":
                    status = 503
                self._send_json(
                    status,
                    {
                        "error": {
                            "code": error.code,
                            "message": str(error),
                            "status": error.status,
                            "retryable": error.retryable,
                        }
                    },
                )
            except (BrokenPipeError, ConnectionResetError):
                return

        def _stream_tutor(self, request: Any) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache, no-transform")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            try:
                for event in runtime.stream_chapter_tutor(request):
                    self._write_event(event)
            except AgentRuntimeError as error:
                self._write_event(
                    {
                        "type": "error",
                        "error": {
                            "code": error.code,
                            "message": str(error),
                            "status": error.status,
                            "retryable": error.retryable,
                        },
                    }
                )

        def _write_event(self, event: dict[str, Any]) -> None:
            encoded = json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode()
            self.wfile.write(b"data: " + encoded + b"\n\n")
            self.wfile.flush()

    return AgentHandler


def main() -> None:
    settings = RunnerSettings.from_env()
    port = int(os.environ.get("PORT", "8102"))
    server = ThreadingHTTPServer(
        ("0.0.0.0", port),
        handler_factory(settings, AgentRuntime(AiGatewayClient(settings))),
    )
    print(f"Mindmark Agent Runner listening on 0.0.0.0:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
