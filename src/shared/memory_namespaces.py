"""Memory namespace conventions — single source of truth.

Two-axis taxonomy:

  Scope axis  (whose memory is this?)
    SCOPE_LUMEN      = "lumen"      · Lumen's private memory
    SCOPE_POLLY      = "polly"      · Polly's private memory     (M2)
    SCOPE_SEGA       = "sega"       · Sega's private memory
    SCOPE_DEV        = "dev"        · Dev-agent private memory   (M2 · reserved for independent dev assistant)
    SCOPE_OPS        = "ops"        · Ops-provisioner agent memory(M2)
    SCOPE_EVAL       = "evaluator"  · Evaluator private memory   (M2)
    SCOPE_REFLECTOR  = "reflector"  · Reflector private memory   (M2)
    SCOPE_SHARED     = "shared"     · Team-wide shared memory
    SCOPE_PIGGY      = "piggy"      · User-scoped memory

  Category axis  (what kind of memory is this?)
    CAT_SELF        = "self"        · self-image / who-am-I notes
    CAT_LESSONS     = "lessons"     · learnings from past failures
    CAT_FACTS       = "facts"       · objective facts about the world
    CAT_PREFERENCES = "preferences" · user preferences / decision patterns
    CAT_EPISODIC    = "episodic"    · time-anchored event records
    CAT_PROCEDURAL  = "procedural"  · "how I should do X" rules
    CAT_TEAM        = "team"        · team-state (only for SCOPE_SHARED)
    CAT_ONGOING     = "ongoing"     · in-flight work state
    CAT_GOVERNANCE  = "governance"  · governance rules (only for SCOPE_SHARED)

Convention: namespace string is f"{scope}/{category}". Examples:
    "lumen/self"          — Lumen's self-image memory
    "polly/procedural"    — Polly's design-pattern learnings
    "sega/lessons"        — Sega's accumulated learnings
    "shared/team"         — current team-state (who's online, current focus)
    "shared/governance"   — living governance rules (see role_documents for canonical)
    "piggy/preferences"   — Piggy's product/style preferences

Helpers `ns()` and `parse()` keep callers from typo-bait string concatenation.

Three-archive architecture (M2 · 2026-04-24):
    Archive 1  role_documents     — per-power authoritative docs (new table)
    Archive 2  agent_memory       — private per-agent memory (this module)
    Archive 3  shared_contexts    — team in-flight context
"""
from __future__ import annotations


# ── Scope axis (横轴: whose memory) ──────────────────────────────────────
SCOPE_LUMEN      = "lumen"
SCOPE_POLLY      = "polly"
SCOPE_SEGA       = "sega"
SCOPE_DEV        = "dev"          # reserved for independent dev-agent-001 memory
SCOPE_OPS        = "ops"
SCOPE_EVAL       = "evaluator"
SCOPE_REFLECTOR  = "reflector"
SCOPE_SHARED     = "shared"
SCOPE_PIGGY      = "piggy"

ALL_SCOPES = frozenset({
    SCOPE_LUMEN, SCOPE_POLLY, SCOPE_SEGA, SCOPE_DEV,
    SCOPE_OPS, SCOPE_EVAL, SCOPE_REFLECTOR,
    SCOPE_SHARED, SCOPE_PIGGY,
})


# ── Category axis (纵轴: what kind) ──────────────────────────────────────
CAT_SELF        = "self"
CAT_LESSONS     = "lessons"
CAT_FACTS       = "facts"
CAT_PREFERENCES = "preferences"
CAT_EPISODIC    = "episodic"
CAT_PROCEDURAL  = "procedural"
CAT_TEAM        = "team"
CAT_ONGOING     = "ongoing"
CAT_GOVERNANCE  = "governance"
# v12 (2026-04-25) — runtime/transit categories per meta_manage_agent v12 SPEC.
# inbox    : A2A-派单收件箱     · namespace=(scope, "inbox", task_id)
# scratch  : 工具返回卸载区     · namespace=(scope, "scratch", key)
# 上述两类是「跨 run 短时」运行时数据，TTL 由 store backend 管理；不进入
# 长期 facts / lessons / procedural 三档语义记忆。
CAT_INBOX       = "inbox"
CAT_SCRATCH     = "scratch"

ALL_CATEGORIES = frozenset({
    CAT_SELF, CAT_LESSONS, CAT_FACTS, CAT_PREFERENCES,
    CAT_EPISODIC, CAT_PROCEDURAL, CAT_TEAM, CAT_ONGOING, CAT_GOVERNANCE,
    CAT_INBOX, CAT_SCRATCH,
})


# ── Recall defaults — which namespaces an agent pulls on startup ─────────
RECALL_DEFAULTS: dict[str, list[str]] = {
    "chiefofstaff-agent-001": [
        "lumen/self",
        "lumen/lessons",
        "lumen/procedural",
        "shared/team",
        "shared/ongoing",
        "shared/governance",
        "piggy/preferences",
    ],
    "orchestrator-agent-001": [
        "polly/self",
        "polly/lessons",
        "polly/procedural",
        "shared/team",
        "shared/ongoing",
        "shared/governance",
    ],
    "ops-agent-001": [
        "sega/self",
        "sega/lessons",
        "sega/procedural",
        "shared/team",
        "shared/ongoing",
        "piggy/preferences",
    ],
    "dev-agent-001": [
        "dev/self",
        "dev/lessons",
        "dev/procedural",
        "shared/team",
        "shared/ongoing",
        "shared/governance",
    ],
    "ops-provisioner-agent-001": [
        "ops/self",
        "ops/lessons",
        "ops/procedural",
        "shared/team",
        "shared/ongoing",
        "shared/governance",
    ],
    "evaluator-agent-001": [
        "evaluator/self",
        "evaluator/lessons",
        "evaluator/procedural",
        "shared/team",
        "shared/ongoing",
    ],
    "reflector-agent-001": [
        "reflector/self",
        "reflector/procedural",
        "lumen/lessons",    "lumen/procedural",
        "polly/lessons",    "polly/procedural",
        "sega/lessons",     "sega/procedural",
        "dev/lessons",      "dev/procedural",
        "ops/lessons",      "ops/procedural",
        "evaluator/lessons","evaluator/procedural",
        "shared/governance",
        "shared/team",
    ],
}


# ── Helpers ──────────────────────────────────────────────────────────────

def ns(scope: str, category: str) -> str:
    """Build a namespace string from scope + category, with validation."""
    if scope not in ALL_SCOPES:
        raise ValueError(
            f"Unknown memory scope: {scope!r}. "
            f"Must be one of {sorted(ALL_SCOPES)}."
        )
    if category not in ALL_CATEGORIES:
        raise ValueError(
            f"Unknown memory category: {category!r}. "
            f"Must be one of {sorted(ALL_CATEGORIES)}."
        )
    return f"{scope}/{category}"


def parse(namespace: str) -> tuple[str, str]:
    """Inverse of ns() — returns (scope, category) tuple from a namespace string."""
    if "/" not in namespace:
        return ("legacy", namespace or "general")
    scope, _, category = namespace.partition("/")
    return (scope, category)


def is_valid(namespace: str) -> bool:
    """True iff namespace string follows the {scope}/{category} convention."""
    scope, category = parse(namespace)
    return scope in ALL_SCOPES and category in ALL_CATEGORIES


LEGACY_NAMESPACE_MAP: dict[str, str] = {
    "general":          "shared/facts",
    "reflections":      "shared/episodic",
    "memory_tool":      "shared/ongoing",
    "":                 "shared/facts",
    "ops_agent/canonical": "shared/governance",
}


def upgrade_legacy(namespace: str) -> str:
    """Map a legacy namespace to the new convention, if applicable."""
    if is_valid(namespace):
        return namespace
    return LEGACY_NAMESPACE_MAP.get(namespace, "shared/facts")


PROMPT_NAME_TO_SCOPE: dict[str, str] = {
    "chiefofstaff-agent-001":     SCOPE_LUMEN,
    "orchestrator-agent-001":     SCOPE_POLLY,
    "ops-agent-001":              SCOPE_SEGA,
    "dev-agent-001":              SCOPE_DEV,
    "ops-provisioner-agent-001":  SCOPE_OPS,
    "evaluator-agent-001":        SCOPE_EVAL,
    "reflector-agent-001":        SCOPE_REFLECTOR,
}


def scope_for_prompt(prompt_name: str | None) -> str:
    """Return the memory scope that owns this assistant's runtime namespaces."""
    if not prompt_name:
        return SCOPE_SHARED
    return PROMPT_NAME_TO_SCOPE.get(prompt_name, SCOPE_SHARED)
