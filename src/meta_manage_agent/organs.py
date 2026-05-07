"""Lumen organs — v13 minimal node implementations.

Single working node: main_agent_node. Wraps the deep agent (which IS
the model-tool loop). No reflection, no recall, no intent dance.

REMOVED in v13 (no opt-in, no deprecated):
  Nodes: verify_intent_node, intent_node, triage_node, inbox_check_node,
         simple_reply_node, recall_node, planner_node, notify_node,
         human_node, memory_writer_node, judge_node, reflector_node
  Helpers: _recall_block, _focus_block, _compose_node_prompt,
           _PLANNER_HINT, _pick_rubric_for, all rubric constants,
           all route_* helpers (route_after_triage, route_after_recall,
           route_after_inbox_check, enter_after_human)
  State fields: triage, intent, plan, reflection, recalled_memories,
                current_focus, intent_anchors, inbox_tasks, inbox_task_id,
                approved, approval_reason, memory_writer_summary,
                judge_summary, notify_message

KEPT in v13 (inlined into main_agent_node):
  Intent Token verification — was a separate verify_intent_node in v12;
  now an inline check at the entry of main_agent_node. Crypto path
  (peek_claims / verify / JWK fetch / JTI replay) lives in
  shared/intent_token.py and shared/supabase auth helpers below.

Single-node graph, single ReAct loop inside the deep agent.
"""
from __future__ import annotations

import json
import os
import time as _t
from typing import Annotated, Any, TypedDict

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from langchain_core.runnables import RunnableConfig
from langchain.chat_models import init_chat_model
from langgraph.graph.message import add_messages

from shared.runtime_context import context_from_config
from shared.audit_hook import (
    audit_node_enter,
    audit_node_exit,
    audit_run_started,
    audit_run_completed,
    llm_usage_from_response,
    estimate_cost_usd,
)


# ── State ─────────────────────────────────────────────────────────────────

class LumenState(TypedDict, total=False):
    """v13 state — minimal. Three things only:

    messages              — full conversation (append-only via add_messages)
    intent_token_raw      — raw JWT (passed via configurable.intent_token
                            or inline <INTENT_TOKEN> tag in latest user msg)
    verified_intent       — VerifiedIntent dict, populated when token validates
                            or when meta-deployment internal bypass applies
    intent_verify_reason  — set when token verification explicitly fails
    """
    messages: Annotated[list[BaseMessage], add_messages]
    intent_token_raw: str
    verified_intent: dict
    intent_verify_reason: str


# ── Model factory ─────────────────────────────────────────────────────────

DEFAULT_MODEL = os.getenv("LUMEN_FAST_MODEL", "anthropic:claude-sonnet-4-6")


def _llm(model_name: str = DEFAULT_MODEL):
    return init_chat_model(model_name)


# ── Helpers ───────────────────────────────────────────────────────────────

def _last_user_content(state: LumenState) -> str:
    """Extract the most recent human message's text."""
    for m in reversed(state.get("messages") or []):
        if isinstance(m, HumanMessage):
            c = m.content
            if isinstance(c, list):
                return " ".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in c)
            return str(c)
    return ""


# ── Intent Token verification (inlined; was verify_intent_node in v12) ────

_INTENT_TOKEN_TAG_OPEN = "<INTENT_TOKEN>"
_INTENT_TOKEN_TAG_CLOSE = "</INTENT_TOKEN>"


def _extract_intent_token_from_config_or_msg(
    state: LumenState, config: RunnableConfig,
) -> tuple[str, str]:
    """Find raw JWT string from two channels:
      1) config.configurable.intent_token (admin surface proxy)
      2) inline `<INTENT_TOKEN>...</INTENT_TOKEN>` in latest human message
         (used when Lumen forwards to Sega via run_assistant)

    Returns (token, latest_message_text). The text isn't cleaned here
    since v13 doesn't re-emit it as a downstream prompt; the deep agent
    sees the raw history.
    """
    configurable = (config.get("configurable") or {}) if isinstance(config, dict) else {}
    token = (configurable.get("intent_token") or "").strip()

    latest_text = _last_user_content(state)
    if not token and _INTENT_TOKEN_TAG_OPEN in latest_text:
        start = latest_text.find(_INTENT_TOKEN_TAG_OPEN) + len(_INTENT_TOKEN_TAG_OPEN)
        end = latest_text.find(_INTENT_TOKEN_TAG_CLOSE, start)
        if end > start:
            token = latest_text[start:end].strip()
    return token, latest_text


async def _verify_intent_inline(state: LumenState, config: RunnableConfig) -> dict:
    """Verify intent token at main_agent entry. Returns a state delta dict.

    Logic preserved from v12 verify_intent_node, with audit kept:

      No token  → meta-deployment internal trust bypass → verified_intent
                  with bypass=True (all internal Meta-Team agents trusted).
      Bad token → audit + intent_verify_reason set, verified_intent unset
                  (write tools refuse at prompt level).
      Good token → full crypto verify (signature, audience, tenant, JTI
                   replay protection) → verified_intent populated.
    """
    audit_node_enter("verify_intent_inline", None, config)
    token, _ = _extract_intent_token_from_config_or_msg(state, config)

    # Meta-deployment bypass: no token → trust internal Meta-Team peers.
    # External tenant agents run on a different deployment with stricter rules.
    if not token:
        configurable = (config.get("configurable") or {}) if isinstance(config, dict) else {}
        actor_id = configurable.get("assistant_id") or configurable.get("actor_id") or "meta-internal"
        tenant = configurable.get("tenant_id") or ""
        audit_node_exit("verify_intent_inline", None, config,
                        extra={"has_token": False, "bypass": "meta_deployment_internal_trust"})
        return {
            "verified_intent": {
                "principal_id": actor_id,
                "principal_type": "internal_team",
                "tenant_id": tenant,
                "action_class": "*",
                "scope": "meta:*",
                "bounds": {},
                "bypass": True,
                "bypass_reason": "meta_deployment_internal_trust",
            },
        }

    try:
        from shared.intent_token import verify as _verify, peek_claims, IntentTokenError
    except ImportError as e:
        audit_node_exit("verify_intent_inline", None, config,
                        extra={"has_token": True, "error": f"module_missing:{e}"})
        return {"intent_verify_reason": f"intent_token module unavailable: {e}"}

    try:
        claims = peek_claims(token)
    except Exception as e:
        return _record_intent_failure(config, jti="00000000-0000-0000-0000-000000000000",
                                      principal_id="unknown", tenant_id="",
                                      outcome="bad_sig", reason=f"peek failed: {e}")

    principal_id = (claims.get("principal") or {}).get("id") or claims.get("sub") or ""
    tenant_id = claims.get("tenant_id") or ""
    jti = claims.get("jti", "")

    pub_jwk = await _fetch_user_public_jwk(principal_id)
    if not pub_jwk:
        return _record_intent_failure(config, jti=jti, principal_id=principal_id,
                                      tenant_id=tenant_id, outcome="rejected",
                                      reason="no public key on file for principal")

    configurable = (config.get("configurable") or {}) if isinstance(config, dict) else {}
    assistant_id = configurable.get("assistant_id") or ""
    expected_tenant = configurable.get("tenant_id") or tenant_id

    try:
        verified = _verify(
            token=token,
            public_jwk=pub_jwk,
            expected_audience=assistant_id,
            expected_tenant_id=expected_tenant,
        )
    except IntentTokenError as e:
        outcome = ("expired" if "expired" in str(e).lower()
                   else "bad_sig" if "signature" in str(e).lower()
                   else "rejected")
        return _record_intent_failure(config, jti=jti, principal_id=principal_id,
                                      tenant_id=tenant_id, outcome=outcome, reason=str(e))

    replayed = await _check_and_record_jti(
        jti=verified.jti,
        principal_id=verified.principal_id,
        tenant_id=verified.tenant_id,
        expires_at=verified.expires_at,
    )
    if replayed:
        return _record_intent_failure(config, jti=jti, principal_id=principal_id,
                                      tenant_id=tenant_id, outcome="replay",
                                      reason="jti already seen")

    await _write_intent_audit(
        jti=verified.jti, principal_id=verified.principal_id,
        tenant_id=verified.tenant_id,
        action_class=verified.declared_intent.action_class,
        tool_name=None, outcome="verified", reason=None,
    )
    audit_node_exit("verify_intent_inline", None, config,
                    extra={"verified": True, "principal": verified.principal_id,
                           "action_class": verified.declared_intent.action_class})
    return {
        "intent_token_raw": token,
        "verified_intent": {
            "principal_id": verified.principal_id,
            "principal_type": verified.principal_type,
            "tenant_id": verified.tenant_id,
            "action_class": verified.declared_intent.action_class,
            "scope": verified.declared_intent.scope,
            "bounds": dict(verified.declared_intent.bounds),
            "issued_at": verified.issued_at,
            "expires_at": verified.expires_at,
            "jti": verified.jti,
        },
    }


def _record_intent_failure(
    config: RunnableConfig, *, jti: str, principal_id: str,
    tenant_id: str, outcome: str, reason: str,
) -> dict:
    """Sync wrapper — fire-and-forget audit write, returns state delta."""
    import asyncio
    try:
        asyncio.get_event_loop().create_task(
            _write_intent_audit(
                jti=jti, principal_id=principal_id, tenant_id=tenant_id,
                action_class="", tool_name=None, outcome=outcome, reason=reason,
            )
        )
    except Exception:
        pass
    audit_node_exit("verify_intent_inline", None, config,
                    extra={"verified": False, "outcome": outcome, "reason": reason[:200]})
    return {"intent_verify_reason": f"{outcome}: {reason}"}


async def _fetch_user_public_jwk(principal_id: str) -> dict | None:
    """principal_id format: 'user:<email>'. Resolves to auth.users.id via
    the admin API then fetches user_signing_keys.public_jwk.
    """
    if not principal_id.startswith("user:"):
        return None
    email = principal_id.split(":", 1)[1]
    import httpx as _httpx
    from shared.supabase_client import SUPABASE_URL
    try:
        async with _httpx.AsyncClient(timeout=10) as client:
            svc = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
            headers = {"apikey": svc, "Authorization": f"Bearer {svc}"}
            r = await client.get(
                f"{SUPABASE_URL}/auth/v1/admin/users?per_page=200",
                headers=headers,
            )
            if r.status_code != 200:
                return None
            data = r.json()
            users = data.get("users") if isinstance(data, dict) else data
            if not isinstance(users, list):
                return None
            user_id: str | None = None
            for u in users:
                if isinstance(u, dict) and u.get("email", "").lower() == email.lower():
                    user_id = u.get("id")
                    break
            if not user_id:
                return None
            r2 = await client.get(
                f"{SUPABASE_URL}/rest/v1/user_signing_keys?user_id=eq.{user_id}&revoked_at=is.null&select=public_key_jwk&limit=1",
                headers=headers,
            )
            if r2.status_code != 200:
                return None
            rows = r2.json()
            return rows[0]["public_key_jwk"] if rows else None
    except Exception:
        return None


async def _check_and_record_jti(
    *, jti: str, principal_id: str, tenant_id: str, expires_at: int,
) -> bool:
    """Check if `jti` has been seen. Return True on replay, False on first use."""
    import httpx as _httpx
    from shared.supabase_client import SUPABASE_URL
    from datetime import datetime, timezone
    svc = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    get_headers = {"apikey": svc, "Authorization": f"Bearer {svc}"}
    post_headers = {**get_headers, "Content-Type": "application/json",
                    "Prefer": "resolution=ignore-duplicates,return=minimal"}
    try:
        async with _httpx.AsyncClient(timeout=5) as client:
            r = await client.get(
                f"{SUPABASE_URL}/rest/v1/intent_jti_seen?jti=eq.{jti}&select=jti",
                headers=get_headers,
            )
            if r.status_code == 200 and r.json():
                return True  # replay
            await client.post(
                f"{SUPABASE_URL}/rest/v1/intent_jti_seen",
                json=[{
                    "jti": jti,
                    "principal_id": principal_id,
                    "tenant_id": tenant_id,
                    "expires_at": datetime.fromtimestamp(expires_at, timezone.utc).isoformat(),
                }],
                headers=post_headers,
            )
    except Exception:
        # Fail-open: token is already signature-verified and audience-checked;
        # replay window at worst = token lifetime (5 min).
        pass
    return False


async def _write_intent_audit(
    *, jti: str, principal_id: str, tenant_id: str,
    action_class: str, tool_name: str | None,
    outcome: str, reason: str | None,
) -> None:
    import httpx as _httpx
    from shared.supabase_client import SUPABASE_URL
    svc = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    headers = {
        "apikey": svc, "Authorization": f"Bearer {svc}",
        "Content-Type": "application/json", "Prefer": "return=minimal",
    }
    try:
        async with _httpx.AsyncClient(timeout=5) as client:
            await client.post(
                f"{SUPABASE_URL}/rest/v1/intent_audit_chain",
                json=[{
                    "jti": jti or "00000000-0000-0000-0000-000000000000",
                    "principal_id": principal_id or "unknown",
                    "tenant_id": tenant_id or "00000000-0000-0000-0000-000000000000",
                    "action_class": action_class or "",
                    "tool_name": tool_name,
                    "outcome": outcome,
                    "reason": (reason or "")[:500],
                }],
                headers=headers,
            )
    except Exception:
        pass


# ── NODE: main_agent (the only node in v13) ──────────────────────────────
#
# v13 hotfix: inner deep agent is now passed in via closure-captured kwarg
# (graph.py wraps this in `bound_main_agent_node` which closes over `inner`).
# v12's `_MAIN_AGENT_SLOT` module global was unsafe under concurrent runs —
# 5 parallel assistants would all converge onto the last factory-built
# inner agent, causing identity confusion.


async def main_agent_node(state: LumenState, config: RunnableConfig,
                           *, inner_agent: Any = None) -> dict:
    """v13 sole node: run the deep agent — this IS the model-tool loop.

    `inner_agent` is the deep agent built per-run by graph.py and passed
    in via closure. Direct LangGraph node calls without closure (legacy)
    will get None and short-circuit.

    Entry sequence:
      1. Verify intent token (inline; was verify_intent_node in v12)
      2. Compose system prompt fragment with security gating
      3. Invoke deep agent (canonical ReAct loop runs internally:
         model → tool → observe → model → ... → done)
    """
    agent = inner_agent
    if agent is None:
        return {"messages": [AIMessage(content="[main_agent: inner agent not bound — graph factory must pass via closure]")]}

    # 1. Inline intent token verification.
    verify_delta = await _verify_intent_inline(state, config)
    verified_intent = verify_delta.get("verified_intent")
    verify_reason = verify_delta.get("intent_verify_reason", "")

    # 2. Compose system prompt — security directive only. Identity + memory
    #    tool usage are part of the deep agent's own system_prompt
    #    (composed in graph._compose_inner_prompt at factory time).
    history = list(state.get("messages") or [])
    sys_parts: list[str] = []

    if verified_intent:
        secs_left = max(0, int(verified_intent.get("expires_at", 0)) - int(_t.time())) \
            if verified_intent.get("expires_at") else 0
        bypass = verified_intent.get("bypass") is True
        if bypass:
            sys_parts.append(
                "**INTENT TOKEN VERIFIED (meta-internal bypass)** ✅\n"
                f"- principal: `{verified_intent.get('principal_id','?')}`\n"
                f"- bypass_reason: `{verified_intent.get('bypass_reason','meta_internal')}`\n"
                "All write tools unlocked for internal Meta-Team peer call."
            )
        else:
            sys_parts.append(
                "**INTENT TOKEN VERIFIED** ✅\n"
                f"- principal: `{verified_intent.get('principal_id','?')}`\n"
                f"- action_class: `{verified_intent.get('action_class','?')}`\n"
                f"- tenant: `{verified_intent.get('tenant_id','?')}`\n"
                f"- valid for: {secs_left}s more\n"
                "All write tools unlocked. Execute user intent directly — "
                "no further re-confirmation needed this run."
            )
    else:
        sys_parts.append(
            "**NO VERIFIED INTENT TOKEN** 🔒\n"
            f"- reason: `{verify_reason or 'not provided'}`\n"
            "Write tools are GATED — REFUSE requests to run "
            "`e2b_python_sandbox`, `steel_*`, `create_task_issue`, `merge_pr`, "
            "`create_pr_comment`, `deploy_edge_function`, `apply_migration`, "
            "`vault_read_secret`. Read tools (memory_view, list_agents, pulse "
            "queries, audit reads, PR list) remain available.\n"
            "If the user asks for a write action: "
            "'这条请求需要 Intent Token 授权才能跑写工具。请在前端 Shield 授权面板"
            "里解锁本次会话的写权限。'"
        )

    messages_for_agent = [SystemMessage(content="\n\n---\n\n".join(sys_parts))] + history

    # 3. Invoke deep agent — runs the model-tool loop until done.
    t0 = audit_run_started(None, config, run_meta={
        "messages_in": len(messages_for_agent),
        "verified_intent": bool(verified_intent),
        "graph_version": "v13",
    })
    try:
        result = await agent.ainvoke({"messages": messages_for_agent}, config=config)
        new_msgs = result.get("messages", [])[len(messages_for_agent):]

        agg_in = agg_out = 0
        for m in new_msgs:
            um = getattr(m, "usage_metadata", None) or {}
            agg_in += int(um.get("input_tokens", 0) or 0)
            agg_out += int(um.get("output_tokens", 0) or 0)
        audit_run_completed(None, config, summary={
            "new_messages": len(new_msgs),
            "tokens_in": agg_in,
            "tokens_out": agg_out,
            "cost_usd_est": estimate_cost_usd("claude-sonnet-4-6", agg_in, agg_out),
        }, started_at=t0, status="success")

        update: dict = {"messages": new_msgs}
        # Carry verify_delta keys forward so they're visible in run state.
        update.update(verify_delta)
        return update
    except Exception as e:
        # ── Composio partial-failure recovery ────────────────────────────
        # COMPOSIO_MULTI_EXECUTE_TOOL raises ToolException even when only
        # 1 tool in a batch fails. This crashes the entire run instead of
        # letting the agent handle partial results. We intercept it here
        # and convert it to an AIMessage so the agent can read the partial
        # results and decide what to do (retry, report, continue).
        from langchain_core.tools.base import ToolException as _ToolException
        if isinstance(e, _ToolException):
            msg = str(e)
            if '"error_count"' in msg and '"success_count"' in msg:
                audit_run_completed(None, config, summary={
                    "error_class": "ToolException_composio_partial",
                    "recovered": True,
                }, started_at=t0, status="partial")
                return {
                    "messages": [AIMessage(content=(
                        "⚠️ Composio batch call had partial failures. "
                        "Inspect `error_count` / `results` in the JSON below "
                        "to see which tools failed, then decide whether to retry "
                        "or continue with partial data:\n\n"
                        f"```json\n{msg[:4000]}\n```"
                    ))],
                    **verify_delta,
                }
        # ── Generic failure ──────────────────────────────────────────────
        audit_run_completed(None, config, summary={
            "error_class": type(e).__name__,
            "error_msg_truncated": str(e)[:500],
        }, started_at=t0, status="failure")
        raise
