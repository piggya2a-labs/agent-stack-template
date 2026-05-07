"""Meta Manage Agent — Unified Graph for all Meta-layer Agents.

One graph, multiple assistants. Each Assistant is differentiated by its
`configurable` values (prompt_name, model_name, tenant_id), which determines:
  - Which Prompt Hub identity it adopts (configurable.prompt_name)
  - Which tenant's data it can access (via runtime_context + RLS)

Architecture (v13 — model-tool loop · clean cut from v12):
================================================================
v12 had 12 explicit nodes producing template-like output and silent
prompt drift (trace 019dd7c1, 2026-04-29 confirmed). Clean cut:

Topology:
    START → main_agent_node → END

The model-tool loop runs INSIDE the deep agent inside main_agent_node
(canonical ReAct pattern: model → tool → observe → model → done).
The outer graph is a thin wrapper. Period.

REMOVED (no opt-in, no deprecated path, no fallback):
    Nodes: verify_intent_node, intent_node, triage_node, inbox_check_node,
           simple_reply_node, recall_node, planner_node, notify_node,
           human_node, memory_writer_node, judge_node, reflector_node
    Routers: route_after_triage, route_after_recall, route_after_inbox_check,
             enter_after_human
    Subagent intent modes (planner / triage / reflector / critic): the deep
    agent in v13 is a single ReAct loop, no nested intent dispatch.

Cross-agent dispatch:
    Out of graph. Use the `dispatch_a2a` tool (wraps existing
    a2a-dispatch-async/sync trigger tasks). The graph stays single-agent.

Persona changes:
    `propose_prompt_change` is removed from the main agent's tool slice
    (handled in shared tool_registry, separate commit). Persona changes
    go through human review on a Prompt Hub PR, not turn-time tool calls.

Memory write-back:
    Agent calls `memory_save` / `memory_create` itself when it judges
    something worth remembering — Anthropic Memory Tool protocol. No
    automatic write at turn end.

Scoring / evaluation:
    Out of graph. Eval pipelines run as separate scheduled jobs against
    LangSmith traces. Not a turn-time concern.

Intent token verification:
    Inlined into main_agent_node entry (no longer a separate node).
"""
from __future__ import annotations

import os
from typing import Any

from langchain.chat_models import init_chat_model
from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph

from deepagents import create_deep_agent
from shared.tools import (
    get_tools_for_agent,
    get_tools_for_intent,
    get_hitl_interrupts,
)
from shared.prompt import compose_system_prompt
from shared.runtime_context import context_from_config

from meta_manage_agent.organs import (
    LumenState,
    main_agent_node,
)

DEFAULT_MODEL = os.getenv("DEFAULT_AGENT_MODEL", "anthropic:claude-sonnet-4-6")


# Anthropic-style memory tool usage instruction. Appended to the inner
# agent's system_prompt so Claude reads its memory directory before any
# task — the on-policy behaviour Anthropic recommends in the Memory
# Tool docs (file path discipline + view-first protocol).
_MEMORY_TOOL_USAGE = """

## Your memory system (Anthropic Memory Tool, Supabase-backed)

You have file-system style memory tools:
  memory_view, memory_create, memory_str_replace, memory_insert,
  memory_delete, memory_rename
operating on a `/memories/...` directory persisted to Supabase
(tenant-scoped — you cannot see other tenants).

MEMORY PROTOCOL (mandatory):
1. ALWAYS call `memory_view("/memories")` before doing anything else.
   Read relevant files. This is your durable knowledge of the user
   and past work.
2. As you work, record durable facts / lessons / preferences via
   memory_create or memory_str_replace. Suggested filenames:
     /memories/preferences.md       — user's stated preferences
     /memories/lessons.md           — what you learned from mistakes
     /memories/projects/<name>.md   — per-project context / progress
     /memories/people/<name>.md     — per-person info
3. Keep the directory clean: rename or delete files no longer relevant.
   Do not create a new file when an existing one would do.
4. ASSUME INTERRUPTION: your context window may be reset. Anything
   not in memory is lost. Use it.

You also still have semantic recall via `memory_search_semantic` and
the legacy `memory_save / memory_search`. These read the same Supabase
table — memory_tool files are findable via semantic search too.
"""


# ─── Per-role main intent map ─────────────────────────────────────────
# Routes the inner deep agent's tool slice based on the assistant's own
# Prompt Hub identity. Anything unmapped falls back to legacy `main`
# (universal but bloated — 77 tools, ~30k input tokens of schema).
_PROMPT_TO_MAIN_INTENT: dict[str, str] = {
    "chiefofstaff-agent-001":   "main_lumen",
    "orchestrator-agent-001":   "main_polly",
    "dev-agent-001":            "main_dev",
    "ops-agent-001":            "main_sega",
    "ops-provisioner-agent-001": "main_ops",
    "evaluator-agent-001":      "main_evaluator",
}


def _resolve_main_intent(prompt_key: str | None) -> str:
    return _PROMPT_TO_MAIN_INTENT.get(prompt_key or "", "main")


def _compose_inner_prompt(prompt_key: str | None) -> str:
    """Inner deep agent system prompt — Prompt Hub identity + memory tool usage."""
    if not prompt_key:
        return _MEMORY_TOOL_USAGE.strip()
    base = compose_system_prompt(prompt_key, variant="production") or ""
    return (base.rstrip() + _MEMORY_TOOL_USAGE).strip()


def _interrupts_for(source: str) -> dict[str, bool]:
    """HITL interrupt dict from `tool_registry.metadata` (with built-in fallback)."""
    return get_hitl_interrupts(source)


def _build_inner_deep_agent(prompt_key: str | None, model_name: str,
                            tenant_id: str | None, source: str = "human_chat"):
    """Build the inner deep agent — this IS the model-tool loop.

    Canonical ReAct loop:
        model_call → tool_use → tool_result → model_call → ... → done

    All "intelligence" lives here. The outer StateGraph (v13) routes once
    into this single node and exits.

    Tool slicing: per-role `main_<role>` intent slice based on the
    assistant's identity prompt. Unknown prompts → legacy universal `main`,
    then fallback to `get_tools_for_agent`.

    Subagents: empty in v13. No nested intent dispatch. The deep agent is
    a single ReAct loop with one tool slice.
    """
    main_intent = _resolve_main_intent(prompt_key)
    tools = get_tools_for_intent(None, main_intent, tenant_id=tenant_id)
    if not tools:
        tools = get_tools_for_intent(None, "main", tenant_id=tenant_id) \
            or get_tools_for_agent(None, tenant_id=tenant_id)
    system_prompt = _compose_inner_prompt(prompt_key)
    return create_deep_agent(
        model=init_chat_model(model_name),
        tools=tools,
        system_prompt=system_prompt,
        subagents=[],  # v13: no nested intent modes
        interrupt_on=_interrupts_for(source),
    )


def _build_outer_graph(inner_agent: Any) -> Any:
    """v13 outer graph — thin wrapper around the model-tool loop.

    Topology:
        START → main_agent_node → END

    `inner_agent` is captured via closure (per-run, NOT module global) — this
    is the v13 hotfix vs the v12 _MAIN_AGENT_SLOT module-level slot, which
    raced under concurrent runs (5 parallel assistants would all converge
    onto the last factory-built inner agent, causing identity confusion).
    """
    builder = StateGraph(LumenState)

    async def bound_main_agent_node(state: LumenState, config: RunnableConfig) -> dict:
        # Closure capture: each graph(config) call creates a fresh closure
        # bound to its own inner_agent. No shared mutable state across runs.
        return await main_agent_node(state, config, inner_agent=inner_agent)

    import httpx as _httpx_retry
    import httpcore as _httpcore_retry
    from langgraph.types import RetryPolicy

    _retry_policy = RetryPolicy(
        retry_on=(
            _httpx_retry.ReadError,
            _httpx_retry.ConnectError,
            _httpcore_retry.ReadError,
            _httpcore_retry.ConnectError,
        ),
        max_attempts=3,
        initial_interval=1.0,
        backoff_factor=2.0,
    )
    builder.add_node("main_agent_node", bound_main_agent_node, retry=_retry_policy)
    builder.add_edge(START, "main_agent_node")
    builder.add_edge("main_agent_node", END)
    return builder.compile()


def graph(config: RunnableConfig):
    """Factory called on each run by LangGraph Cloud.

    Returns the OUTER StateGraph (v13). The inner deep agent is built fresh
    each call and bound to main_agent_node via closure (no module-level slot,
    no concurrent-run identity bleed).

    configurable.source branches the HITL interrupt set:
      human_chat (default)  → full HITL (risk gates on)
      autonomous_heartbeat  → relaxed HITL (cron isn't a user)
    """
    configurable = config.get("configurable", {}) or {}
    prompt_key = configurable.get("prompt_name") or None
    model_name = configurable.get("model_name", DEFAULT_MODEL)
    source = configurable.get("source", "human_chat")

    ctx = context_from_config(config)
    if "_gateway_context" not in configurable:
        configurable["_gateway_context"] = ctx
    tenant_id = ctx.effective_tenant_id

    inner = _build_inner_deep_agent(
        prompt_key, model_name, tenant_id, source=source,
    )

    outer = _build_outer_graph(inner_agent=inner)

    run_metadata = {
        "prompt_key": prompt_key,
        "assistant_id": ctx.assistant_id,
        "tenant_id": tenant_id,
        "actor_type": ctx.actor_type,
        "actor_id": ctx.actor_id,
        "thread_id": ctx.thread_id,
        "model_name": model_name,
        "source": source,
        "graph_version": "v13-model-tool-loop",
        "interrupt_count": len(_interrupts_for(source)),
        "memory_backend": "supabase+anthropic-memory-tool",
    }
    run_tags = [
        f"assistant:{(ctx.assistant_id or 'unknown')[:8]}",
        f"prompt:{prompt_key or 'unset'}",
        f"tenant:{tenant_id or 'none'}",
        f"actor:{ctx.actor_type or 'system'}",
        f"source:{source}",
        "graph:v13-model-tool-loop",
    ]
    return outer.with_config(
        metadata={k: v for k, v in run_metadata.items() if v is not None},
        tags=run_tags,
    )
