"""Runtime context for agent execution — tenant + actor identity propagation.

Provides a typed dataclass that travels through LangGraph's
`config.configurable` so every tool can know:
  - Which tenant the request is for
  - Who is acting (user / system / operator)
  - Cross-tenant override flag for admin / operator scenarios

Usage in a tool:
    from langchain_core.runnables import RunnableConfig
    from shared.runtime_context import context_from_config

    @tool
    def my_tool(arg: str, config: RunnableConfig) -> str:
        ctx = context_from_config(config)
        tenant_id = ctx.effective_tenant_id
        ...
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class AgentGatewayContext:
    """Typed tenant + actor context for a single agent invocation."""

    tenant_id: str | None = None
    actor_type: str = "system"
    actor_id: str | None = None
    operator_id: str | None = None
    target_tenant_id: str | None = None
    allow_cross_tenant_override: bool = False
    run_id: str | None = None
    thread_id: str | None = None
    request_reason: str | None = None
    github_installation_id: str | None = None
    issue_number: int | None = None
    repository_full_name: str | None = None
    assistant_id: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def effective_tenant_id(self) -> str | None:
        return self.target_tenant_id or self.tenant_id

    @property
    def is_operator(self) -> bool:
        return self.actor_type == "operator" and self.operator_id is not None

    @property
    def is_cross_tenant(self) -> bool:
        return (
            self.target_tenant_id is not None
            and self.target_tenant_id != self.tenant_id
        )

    def can_access_tenant(self, tenant_id: str) -> bool:
        if self.effective_tenant_id == tenant_id:
            return True
        if self.allow_cross_tenant_override and self.is_operator:
            return True
        return False


def context_from_config(config: Any) -> AgentGatewayContext:
    """Extract AgentGatewayContext from a LangGraph RunnableConfig."""
    configurable: dict[str, Any] = {}

    if config is None:
        return AgentGatewayContext()

    if isinstance(config, dict):
        configurable = config.get("configurable", {}) or {}
    else:
        try:
            configurable = config.get("configurable", {}) or {}
        except Exception:
            pass

    ctx_obj = configurable.get("_gateway_context")
    if isinstance(ctx_obj, AgentGatewayContext):
        return ctx_obj

    return AgentGatewayContext(
        tenant_id=configurable.get("tenant_id"),
        actor_type=configurable.get("actor_type", "system"),
        actor_id=configurable.get("actor_id"),
        operator_id=configurable.get("operator_id"),
        target_tenant_id=configurable.get("target_tenant_id"),
        allow_cross_tenant_override=bool(
            configurable.get("allow_cross_tenant_override", False)
        ),
        run_id=configurable.get("run_id"),
        thread_id=configurable.get("thread_id"),
        request_reason=configurable.get("request_reason"),
        github_installation_id=configurable.get("github_installation_id"),
        issue_number=configurable.get("issue_number"),
        repository_full_name=configurable.get("repository_full_name"),
        assistant_id=configurable.get("assistant_id"),
        extra={
            k: v
            for k, v in configurable.items()
            if k
            not in {
                "tenant_id", "actor_type", "actor_id", "operator_id",
                "target_tenant_id", "allow_cross_tenant_override",
                "run_id", "thread_id", "request_reason",
                "github_installation_id", "issue_number",
                "repository_full_name", "assistant_id", "_gateway_context",
            }
        },
    )


def make_config(
    tenant_id: str | None = None,
    actor_type: str = "system",
    actor_id: str | None = None,
    **kwargs: Any,
) -> dict[str, Any]:
    """Convenience: build a RunnableConfig dict with gateway context."""
    ctx = AgentGatewayContext(
        tenant_id=tenant_id,
        actor_type=actor_type,
        actor_id=actor_id,
        **{k: v for k, v in kwargs.items() if hasattr(AgentGatewayContext, k)},
    )
    return {"configurable": {"_gateway_context": ctx, "tenant_id": tenant_id}}
