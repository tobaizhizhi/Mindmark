from __future__ import annotations

from dataclasses import dataclass
import os
from typing import Mapping


@dataclass(frozen=True)
class ModelTarget:
    api_key: str
    model: str
    base_url: str
    max_tokens_parameter: str = "max_completion_tokens"
    provider_options: dict[str, object] | None = None


@dataclass(frozen=True)
class GatewaySettings:
    internal_token: str
    ai_api_key: str
    ai_model: str
    ai_base_url: str
    tutor_model: str | None
    design_model: str | None
    evaluation_api_key: str | None
    evaluation_model: str | None
    evaluation_base_url: str | None
    embedding_api_key: str | None
    embedding_model: str | None
    embedding_base_url: str | None
    fallback_api_key: str | None
    fallback_model: str
    fallback_base_url: str

    @classmethod
    def from_env(cls, environment: Mapping[str, str] | None = None) -> GatewaySettings:
        env = environment if environment is not None else os.environ

        def optional(name: str) -> str | None:
            value = env.get(name, "").strip()
            return value or None

        return cls(
            internal_token=env.get("AI_GATEWAY_INTERNAL_TOKEN", "").strip(),
            ai_api_key=env.get("AI_API_KEY", "").strip(),
            ai_model=env.get("AI_MODEL", "").strip(),
            ai_base_url=env.get("AI_BASE_URL", "https://api.openai.com/v1").strip().rstrip("/"),
            tutor_model=optional("AI_TUTOR_MODEL"),
            design_model=optional("AI_DESIGN_MODEL"),
            evaluation_api_key=optional("AI_EVALUATION_API_KEY"),
            evaluation_model=optional("AI_EVALUATION_MODEL"),
            evaluation_base_url=optional("AI_EVALUATION_BASE_URL"),
            embedding_api_key=optional("AI_EMBEDDING_API_KEY"),
            embedding_model=optional("AI_EMBEDDING_MODEL"),
            embedding_base_url=optional("AI_EMBEDDING_BASE_URL"),
            fallback_api_key=optional("AI_FALLBACK_API_KEY"),
            fallback_model=env.get("AI_FALLBACK_MODEL", "deepseek-chat").strip(),
            fallback_base_url=env.get(
                "AI_FALLBACK_BASE_URL", "https://api.deepseek.com/v1"
            ).strip().rstrip("/"),
        )

    def validation_errors(self) -> list[str]:
        missing = []
        if not self.internal_token:
            missing.append("AI_GATEWAY_INTERNAL_TOKEN")
        if not self.ai_api_key:
            missing.append("AI_API_KEY")
        if not self.ai_model:
            missing.append("AI_MODEL")
        return missing

    def target(self, profile: str) -> ModelTarget:
        if self.validation_errors():
            raise ValueError("AI Gateway is not configured")
        if profile == "evaluation":
            return ModelTarget(
                api_key=self.evaluation_api_key or self.ai_api_key,
                model=self.evaluation_model or self.ai_model,
                base_url=(self.evaluation_base_url or self.ai_base_url).rstrip("/"),
            )
        if profile == "embedding":
            if not self.embedding_model:
                raise ValueError("AI_EMBEDDING_MODEL is not configured")
            return ModelTarget(
                api_key=self.embedding_api_key or self.ai_api_key,
                model=self.embedding_model,
                base_url=(self.embedding_base_url or self.ai_base_url).rstrip("/"),
            )
        model = {
            "generation": self.ai_model,
            "design": self.design_model or self.ai_model,
            "tutor": self.tutor_model or self.ai_model,
        }.get(profile)
        if not model:
            raise ValueError(f"Unknown AI profile: {profile}")
        return ModelTarget(
            api_key=self.ai_api_key,
            model=model,
            base_url=self.ai_base_url,
        )

    def fallback_target(self) -> ModelTarget | None:
        if not self.fallback_api_key:
            return None
        return ModelTarget(
            api_key=self.fallback_api_key,
            model=self.fallback_model,
            base_url=self.fallback_base_url,
            max_tokens_parameter="max_tokens",
            provider_options={"thinking": {"type": "disabled"}},
        )

