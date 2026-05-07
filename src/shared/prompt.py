"""Shared Prompt Composition — LangSmith Prompt Hub, native hot-swap.

2026-04-23 Piggy 决议（via Polly）: Identity prompt 的 Prompt Hub 定位由
每个 assistant 的 `config.configurable.prompt_name` 字段显式指定 —— **零中间层**、
**零 agent_id**、**零 assistant_id UUID**、**代码不管命名约定**。

New assistant 流程：
  1. Prompt Hub 建新 repo（人取名，比如 `ember-agent-prompt`）
  2. LangGraph 注册 assistant 时 `configurable.prompt_name = "ember-agent-prompt"`
  3. 完成 · 代码不需要改

Two kinds of prompts:

- **Identity prompts** — 每个 assistant 一条。key 由该 assistant 的
  `configurable.prompt_name` 给出。用 `compose_system_prompt(prompt_key)` 拉。

- **Intent-mode prompts** — `intent-001-triage` / `intent-002-planner` /
  `intent-003-reflector` / `intent-004-critic` / `intent-005-simplereply`
  (agent-agnostic · 描述"进入某种思考模式"的行为)。这些 key 是固定的
  (架构内 built-in)，不随 assistant 变化。用 `compose_intent_prompt()` 拉。

History:
  2026-04-22: 删 legacy `compose_subagent_prompt(role)` + hardcoded stubs
  2026-04-23: 删 `agent_id` 中间层 · 改用 configurable.prompt_name 显式定位
"""
from __future__ import annotations

from langsmith import Client


def compose_system_prompt(prompt_key: str, variant: str = "production") -> str:
    """Pull an identity prompt from LangSmith Prompt Hub.

    Args:
        prompt_key: Prompt Hub repo name or `name:variant`. Comes from
                    `config.configurable.prompt_name` — the assistant's own
                    registration decides which repo is its identity.
        variant:    defaults to "production" · ignored if `prompt_key` already
                    includes a `:variant` suffix.

    Returns empty string if Prompt Hub entry missing / prompt_key unset.
    """
    if not prompt_key:
        return ""
    key = prompt_key if ":" in prompt_key else f"{prompt_key}:{variant}"
    try:
        return Client().pull_prompt(key).messages[0].prompt.template or ""
    except Exception:
        return ""


def compose_intent_prompt(prompt_key: str, identity_prompt_key: str | None = None) -> str:
    """Pull an intent-mode prompt from Prompt Hub by its built-in key."""
    for variant in ("production", "latest"):
        try:
            _prompt = Client().pull_prompt(f"{prompt_key}:{variant}")
            text = _prompt.messages[0].prompt.template or ""
            if text.strip():
                return text
        except Exception:
            continue

    if identity_prompt_key:
        base = compose_system_prompt(identity_prompt_key, variant="production")
        if base.strip():
            return base + (
                f"\n\n---\n(Operating in an intent mode — intent-specific "
                f"prompt '{prompt_key}' not yet available in Prompt Hub. "
                f"Falling back to base identity.)"
            )

    return (
        f"(Intent-mode prompt '{prompt_key}' not found in Prompt Hub. "
        f"No identity fallback available. Misconfiguration.)"
    )
