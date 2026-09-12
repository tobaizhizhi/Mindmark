from __future__ import annotations

from dataclasses import dataclass
import os
from typing import Mapping


@dataclass(frozen=True)
class RunnerSettings:
    internal_token: str
    ai_gateway_url: str
    ai_gateway_token: str

    @classmethod
    def from_env(cls, environment: Mapping[str, str] | None = None) -> RunnerSettings:
        env = environment if environment is not None else os.environ
        return cls(
            internal_token=env.get("AGENT_RUNNER_INTERNAL_TOKEN", "").strip(),
            ai_gateway_url=env.get("AI_GATEWAY_URL", "http://127.0.0.1:8101").strip().rstrip("/"),
            ai_gateway_token=env.get("AI_GATEWAY_INTERNAL_TOKEN", "").strip(),
        )

    def validation_errors(self) -> list[str]:
        missing = []
        if not self.internal_token:
            missing.append("AGENT_RUNNER_INTERNAL_TOKEN")
        if not self.ai_gateway_url:
            missing.append("AI_GATEWAY_URL")
        if not self.ai_gateway_token:
            missing.append("AI_GATEWAY_INTERNAL_TOKEN")
        return missing

