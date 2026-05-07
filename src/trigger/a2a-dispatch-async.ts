/**
 * a2a-dispatch-async · Fire-and-forget / long-task A2A dispatch.
 *
 * Called when:
 *   - Caller explicitly wants async (start_assistant / run_assistant_async_with_callback)
 *   - Or a2a_dispatch_sync's heuristic auto-downgrades a long-tool dispatch
 *
 * Runs up to 2 hours by default (maxDuration 7200s). Target agent gets its own
 * independent LangGraph thread. On completion:
 *   - If caller passed a `callback_token`, completes that Waitpoint with the
 *     result — caller's `wait.forToken()` resumes.
 *   - Always writes `agent_memory(memory_type='dispatch')` audit row with
 *     correlation_id so caller can find the result even without a token.
 *
 * Required env vars:
 *   LANGGRAPH_URL             — your LangGraph Cloud deployment URL
 *   LANGSMITH_API_KEY         — LangSmith API key
 *   SUPABASE_URL              — your Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */
import { task, wait, tags } from "@trigger.dev/sdk";
import { appendDispatch } from "./streams";

import type {
  A2ADispatchPayload,
} from "./a2a-dispatch-sync";

function env(name: string, fallback = ""): string {
  const v = process.env[name];
  return v && v.length ? v : fallback;
}

export interface A2ADispatchAsyncPayload extends A2ADispatchPayload {
  callback_token?: string; // Waitpoint token id; if set, completed on finish
}

export interface A2ADispatchAsyncResult {
  ok: boolean;
  agent: string;
  assistant_id: string;
  thread_id?: string;
  run_id?: string;
  response?: string;
  memory_id?: string;
  callback_completed?: boolean;
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
  payload: A2ADispatchAsyncPayload,
  triggerRunId: string,
  targetRunId: string | undefined,
  threadId: string | undefined,
  finalResponse: string | undefined,
): Promise<string | undefined> {
  const supaUrl = env("SUPABASE_URL").replace(/\/$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) return undefined;
  // Fall back to default tenant if caller context didn't carry one — audit
  // should never be silently skipped (same policy as a2a-dispatch-sync).
  const tenantForAudit = payload.tenant_id || "00000000-0000-0000-0000-000000000001";

  const body = {
    p_agent_id: payload.caller_assistant_id ?? "_shared",
    p_namespace: "shared/ongoing",
    p_key: `dispatch-${triggerRunId.slice(0, 8)}`,
    p_content: `A2A async dispatch · ${payload.caller_assistant_id ?? "unknown"} → ${payload.target_agent} · finished · reply="${(finalResponse ?? "").slice(0, 200)}"`,
    p_memory_type: "dispatch",
    p_confidence: 1.0,
    p_source: "a2a-dispatch-async",
    p_tenant_id: tenantForAudit,
    p_metadata: {
      correlation_id: payload.correlation_id,
      trigger_run_id: triggerRunId,
      caller_run_id: payload.caller_run_id ?? null,
      target_run_id: targetRunId ?? null,
      target_thread_id: threadId ?? null,
      target_agent: payload.target_agent,
      mode: "async",
      callback_token: payload.callback_token ?? null,
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

export const a2aDispatchAsync = task({
  id: "a2a_dispatch_async",
  maxDuration: 7200, // 2 h — override per-run with longer if needed
  retry: { maxAttempts: 1 },

  run: async (
    payload: A2ADispatchAsyncPayload,
    { ctx },
  ): Promise<A2ADispatchAsyncResult> => {
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
        transport: "trigger_async",
        timestamp: new Date().toISOString(),
        ...extra,
      });
    };
    await emitDispatch("triggered");

    const assistantId =
      payload.assistant_id ?? (await resolveAssistantId(payload.target_agent));
    if (!assistantId) {
      return {
        ok: false,
        agent: payload.target_agent,
        assistant_id: "",
        error: `assistant '${payload.target_agent}' not found`,
      };
    }

    const lgBase = env("LANGGRAPH_URL").replace(/\/$/, "");
    const apiKey = env("LANGSMITH_API_KEY");
    const headers = { "x-api-key": apiKey, "Content-Type": "application/json" };

    const threadResp = await fetch(`${lgBase}/threads`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        metadata: {
          source: "a2a_dispatch_async",
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
        error: "runs create returned no run_id",
      };
    }

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
      response,
    );

    // If caller gave us a Waitpoint token, complete it with the result so
    // the caller's `wait.forToken()` resumes.
    let callbackCompleted = false;
    if (payload.callback_token) {
      try {
        await wait.completeToken(payload.callback_token, {
          ok: true,
          agent: payload.target_agent,
          assistant_id: assistantId,
          thread_id: threadId,
          run_id: targetRunId,
          response: response || "(target agent returned no text)",
          memory_id: memoryId,
        });
        callbackCompleted = true;
      } catch {
        // Token completion failure is non-fatal — caller can still find the
        // result via agent_memory by correlation_id.
      }
    }

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
      memory_id: memoryId,
      callback_completed: callbackCompleted,
    };
  },
});
