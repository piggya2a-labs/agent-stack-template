/**
 * a2a-dispatch-sync · Synchronous A2A dispatch task.
 *
 * Called by `run_assistant()` Python tool when one agent wants to dispatch
 * another and wait for the final response. Gives the target agent its own
 * independent LangGraph thread (honoring the "every assistant = independent
 * thread" architectural contract), avoids PR #386 single-thread deadlock,
 * and bypasses all RemoteGraph bugs (peer-closed-connection, interrupt-resume,
 * recursion loops, orphan spans).
 *
 * Design:
 *   - Short/common path: create thread → POST /runs + /runs/{id}/join → return (sync, run_id retained)
 *   - Long-task heuristic: if caller hints at a tool class known to run long
 *     (E2B script / repo crawl / deep research), auto-downgrade to the async
 *     dispatch task and return a pointer instead of blocking.
 *   - Always writes a single `agent_memory(memory_type='dispatch')` audit row
 *     linking caller_run_id / target_run_id / trigger_run_id / correlation_id.
 *
 * Required env vars:
 *   LANGGRAPH_URL             — your LangGraph Cloud deployment URL
 *   LANGSMITH_API_KEY         — LangSmith API key
 *   SUPABASE_URL              — your Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */
import { task, tasks, tags } from "@trigger.dev/sdk";
import { appendDispatch } from "./streams";

function env(name: string, fallback = ""): string {
  const v = process.env[name];
  return v && v.length ? v : fallback;
}

// Tools known to run long — trigger auto-downgrade to async dispatch.
// Keep this set small & explicit; heuristics creep into bug magnets.
const LONG_TASK_TOOLS = new Set<string>([
  "e2b_run",
  "e2b_script",
  "repo_crawl",
  "deep_research",
  "claude_code_session",
]);

export interface A2ADispatchPayload {
  target_agent: string; // assistant name or configurable.prompt_name
  assistant_id?: string; // optional explicit UUID; if absent resolved from target_agent
  message: string;
  // Provenance & linking
  caller_assistant_id?: string;
  caller_run_id?: string; // LangSmith run_id of caller's run
  caller_thread_id?: string; // LangSmith thread_id of caller's thread
  correlation_id: string;
  tenant_id?: string;
  intent_token?: string;
  // Optional hint — allows caller to force async path for known long tools
  hint_tool_type?: string;
  actor_type?: string;
}

export interface A2ADispatchSyncResult {
  ok: boolean;
  agent: string;
  assistant_id: string;
  thread_id?: string;
  run_id?: string;
  response?: string;
  transport: "trigger_sync" | "trigger_async_downgrade";
  async_run_id?: string;
  memory_id?: string;
  error?: string;
}

interface LGMessage {
  type: string;
  content: string | Array<{ type: string; text: string }>;
}

interface LGRunResult {
  messages?: LGMessage[];
  metadata?: { run_id?: string };
}

function extractFinalText(result: LGRunResult): string {
  const messages = result.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.type !== "ai") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n\n");
    }
  }
  return "";
}

async function resolveAssistantId(
  nameOrId: string,
): Promise<string | null> {
  // UUID shape → pass through
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nameOrId)) {
    return nameOrId;
  }
  const base = env("LANGGRAPH_URL").replace(/\/$/, "");
  const apiKey = env("LANGSMITH_API_KEY");
  try {
    const r = await fetch(`${base}/assistants/search`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 50 }),
    });
    if (!r.ok) return null;
    const list = (await r.json()) as Array<{
      assistant_id: string;
      name?: string;
      config?: { configurable?: { prompt_name?: string } };
    }>;
    const lower = nameOrId.toLowerCase();
    for (const a of list) {
      const promptName = a.config?.configurable?.prompt_name ?? "";
      const name = a.name ?? "";
      if (
        a.assistant_id === nameOrId ||
        promptName === nameOrId ||
        promptName.toLowerCase() === lower ||
        name === nameOrId ||
        name.toLowerCase() === lower
      ) {
        return a.assistant_id;
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

async function writeDispatchMemory(
  payload: A2ADispatchPayload,
  triggerRunId: string,
  targetRunId: string | undefined,
  threadId: string | undefined,
  mode: "sync" | "async_downgrade",
): Promise<string | undefined> {
  const supaUrl = env("SUPABASE_URL").replace(/\/$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) return undefined;
  // Fall back to default tenant if caller context didn't carry one (Studio
  // test invocations, cron dispatches). Audit should never be silently
  // skipped — better a default-tenant row than a death spot.
  const tenantForAudit = payload.tenant_id || "00000000-0000-0000-0000-000000000001";

  const body = {
    p_agent_id: payload.caller_assistant_id ?? "_shared",
    p_namespace: "shared/ongoing",
    p_key: `dispatch-${triggerRunId.slice(0, 8)}`,
    p_content: `A2A dispatch · ${payload.caller_assistant_id ?? "unknown"} → ${payload.target_agent} · mode=${mode} · msg="${payload.message.slice(0, 200)}"`,
    p_memory_type: "dispatch",
    p_confidence: 1.0,
    p_source: "a2a-dispatch-sync",
    p_tenant_id: tenantForAudit,
    p_metadata: {
      correlation_id: payload.correlation_id,
      trigger_run_id: triggerRunId,
      caller_run_id: payload.caller_run_id ?? null,
      target_run_id: targetRunId ?? null,
      target_thread_id: threadId ?? null,
      target_agent: payload.target_agent,
      mode,
    },
  };
  try {
    const r = await fetch(`${supaUrl}/rest/v1/rpc/memory_write_versioned`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) return undefined;
    const j = (await r.json()) as { id?: string };
    return j?.id;
  } catch {
    return undefined;
  }
}

export const a2aDispatchSync = task({
  id: "a2a_dispatch_sync",
  maxDuration: 600, // 10 min — still generous; long tools auto-downgrade to async
  retry: { maxAttempts: 1 },

  run: async (
    payload: A2ADispatchPayload,
    { ctx },
  ): Promise<A2ADispatchSyncResult> => {
    const triggerRunId = ctx?.run?.id ?? `fallback-${Date.now()}`;

    const emitDispatch = async (
      event: "triggered" | "completed" | "failed",
      extra: Record<string, unknown> = {},
    ) => {
      await appendDispatch({
        event,
        child_run_id: triggerRunId,
        target_agent: payload.target_agent,
        caller_agent: payload.caller_assistant_id ?? "unknown",
        caller_thread_id: payload.caller_thread_id ?? null,
        correlation_id: payload.correlation_id,
        transport: "trigger_sync",
        timestamp: new Date().toISOString(),
        ...extra,
      });
    };
    await emitDispatch("triggered");

    // Heuristic: long-task tools → auto-downgrade to async dispatch.
    if (payload.hint_tool_type && LONG_TASK_TOOLS.has(payload.hint_tool_type)) {
      const handle = await tasks.trigger("a2a_dispatch_async", payload, {
        tags: payload.tenant_id ? [`tenant:${payload.tenant_id}`] : undefined,
      });
      const memoryId = await writeDispatchMemory(
        payload,
        triggerRunId,
        undefined,
        undefined,
        "async_downgrade",
      );
      return {
        ok: true,
        agent: payload.target_agent,
        assistant_id: payload.assistant_id ?? "",
        transport: "trigger_async_downgrade",
        async_run_id: handle.id,
        memory_id: memoryId,
      };
    }

    // Resolve assistant_id
    const assistantId =
      payload.assistant_id ?? (await resolveAssistantId(payload.target_agent));
    if (!assistantId) {
      return {
        ok: false,
        agent: payload.target_agent,
        assistant_id: "",
        transport: "trigger_sync",
        error: `assistant '${payload.target_agent}' not found`,
      };
    }

    // Create independent thread for the target
    const lgBase = env("LANGGRAPH_URL").replace(/\/$/, "");
    const apiKey = env("LANGSMITH_API_KEY");
    const headers = { "x-api-key": apiKey, "Content-Type": "application/json" };

    const threadResp = await fetch(`${lgBase}/threads`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        metadata: {
          source: "a2a_dispatch_sync",
          from: payload.caller_assistant_id ?? "unknown",
          target: payload.target_agent,
          trigger_run_id: triggerRunId,
          correlation_id: payload.correlation_id,
          parent_run_id: payload.caller_run_id ?? null,
        },
      }),
    });
    if (!threadResp.ok) {
      return {
        ok: false,
        agent: payload.target_agent,
        assistant_id: assistantId,
        transport: "trigger_sync",
        error: `thread create: ${threadResp.status} ${await threadResp.text()}`,
      };
    }
    const { thread_id: threadId } = (await threadResp.json()) as {
      thread_id: string;
    };

    try {
      await tags.add([`thread:${threadId}`]);
    } catch (err) {
      console.warn(`tags.add target-thread failed (non-fatal): ${err}`);
    }

    // Forward intent_token inline if present (target's verify_intent_node will strip + verify)
    const outgoing = payload.intent_token
      ? `<INTENT_TOKEN>${payload.intent_token}</INTENT_TOKEN>\n${payload.message}`
      : payload.message;

    const runCreateBody = {
      assistant_id: assistantId,
      input: { messages: [{ role: "human", content: outgoing }] },
      config: {
        configurable: {
          tenant_id: payload.tenant_id ?? null,
          actor_type: payload.actor_type ?? "agent",
          actor_id: payload.caller_assistant_id ?? null,
          source: "a2a_dispatch",
          parent_trigger_run_id: triggerRunId,
          parent_langsmith_run_id: payload.caller_run_id ?? null,
          correlation_id: payload.correlation_id,
          a2a_caller_assistant_id: payload.caller_assistant_id ?? null,
          a2a_caller_run_id: payload.caller_run_id ?? null,
          a2a_caller_thread_id: payload.caller_thread_id ?? null,
        },
        metadata: {
          trigger_run_id: triggerRunId,
          correlation_id: payload.correlation_id,
          parent_run_id: payload.caller_run_id ?? null,
          a2a_caller_assistant_id: payload.caller_assistant_id ?? null,
        },
      },
    };

    // Step 1: POST /runs — fire the run, grab real run_id immediately
    const runCreateResp = await fetch(`${lgBase}/threads/${threadId}/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify(runCreateBody),
    });
    if (!runCreateResp.ok) {
      return {
        ok: false,
        agent: payload.target_agent,
        assistant_id: assistantId,
        thread_id: threadId,
        transport: "trigger_sync",
        error: `runs create: ${runCreateResp.status} ${await runCreateResp.text()}`,
      };
    }
    const runMeta = (await runCreateResp.json()) as { run_id?: string };
    const targetRunId = runMeta.run_id;
    if (!targetRunId) {
      return {
        ok: false,
        agent: payload.target_agent,
        assistant_id: assistantId,
        thread_id: threadId,
        transport: "trigger_sync",
        error: "runs create returned no run_id",
      };
    }

    // Step 2: /runs/{id}/join — wait for completion, get final state
    const joinResp = await fetch(
      `${lgBase}/threads/${threadId}/runs/${targetRunId}/join`,
      { method: "GET", headers },
    );
    if (!joinResp.ok) {
      return {
        ok: false,
        agent: payload.target_agent,
        assistant_id: assistantId,
        thread_id: threadId,
        run_id: targetRunId,
        transport: "trigger_sync",
        error: `runs join: ${joinResp.status} ${await joinResp.text()}`,
      };
    }
    const result = (await joinResp.json()) as LGRunResult;
    const response = extractFinalText(result);

    const memoryId = await writeDispatchMemory(
      payload,
      triggerRunId,
      targetRunId,
      threadId,
      "sync",
    );

    await emitDispatch("completed", {
      target_thread_id: threadId,
      output_excerpt: (response ?? "").slice(0, 200),
    });

    return {
      ok: true,
      agent: payload.target_agent,
      assistant_id: assistantId,
      thread_id: threadId,
      run_id: targetRunId,
      response: response || "(target agent returned no text)",
      transport: "trigger_sync",
      memory_id: memoryId,
    };
  },
});
