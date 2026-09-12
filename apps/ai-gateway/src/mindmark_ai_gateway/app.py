from __future__ import annotations

from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hmac
import json
import os
from typing import Any

from .config import GatewaySettings
from .models import ValidationError, validate_embedding_request, validate_tool_request
from .provider import GatewayError, ModelGateway


def error_payload(error: GatewayError) -> dict[str, object]:
    return {
        "error": {
            "code": error.code,
            "message": str(error),
            "status": error.status,
            "retryable": error.retryable,
        }
    }


def handler_factory(settings: GatewaySettings, gateway: ModelGateway) -> type[BaseHTTPRequestHandler]:
    class GatewayHandler(BaseHTTPRequestHandler):
        server_version = "MindmarkAiGateway/0.1"

        def log_message(self, format: str, *args: object) -> None:
            print(f"ai-gateway {self.address_string()} {format % args}")

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
                self._send_json(200, {"status": "ok", "service": "ai-gateway"})
                return
            if self.path == "/health/ready":
                missing = settings.validation_errors()
                self._send_json(
                    200 if not missing else 503,
                    {"status": "ready" if not missing else "not_ready", "missing": missing},
                )
                return
            self._send_json(404, {"error": {"code": "not_found", "message": "Not found"}})

        def do_POST(self) -> None:  # noqa: N802
            if not self._authorized():
                self._send_json(401, {"error": {"code": "unauthorized", "message": "Unauthorized"}})
                return
            try:
                body = self._json_body()
                if self.path == "/v1/tool-calls":
                    self._send_json(200, gateway.call_tool(validate_tool_request(body)))
                    return
                if self.path == "/v1/tool-calls/stream":
                    self._stream(validate_tool_request(body))
                    return
                if self.path == "/v1/embeddings":
                    self._send_json(200, gateway.embeddings(validate_embedding_request(body)))
                    return
                self._send_json(404, {"error": {"code": "not_found", "message": "Not found"}})
            except ValidationError as error:
                self._send_json(400, {"error": {"code": "invalid_request", "message": str(error)}})
            except GatewayError as error:
                status = 429 if error.code == "rate_limited" else 504 if error.code == "timed_out" else 502
                if error.code == "not_configured":
                    status = 503
                self._send_json(status, error_payload(error))
            except (BrokenPipeError, ConnectionResetError):
                return

        def _stream(self, request: Any) -> None:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache, no-transform")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            try:
                for event in gateway.stream_tool(request):
                    self._write_event(event)
            except GatewayError as error:
                self._write_event({"type": "error", **error_payload(error)})

        def _write_event(self, event: dict[str, Any]) -> None:
            encoded = json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode()
            self.wfile.write(b"data: " + encoded + b"\n\n")
            self.wfile.flush()

    return GatewayHandler


def main() -> None:
    settings = GatewaySettings.from_env()
    port = int(os.environ.get("PORT", "8101"))
    server = ThreadingHTTPServer(("0.0.0.0", port), handler_factory(settings, ModelGateway(settings)))
    print(f"Mindmark AI Gateway listening on 0.0.0.0:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
