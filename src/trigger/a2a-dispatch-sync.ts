/**
 * src/trigger/a2a-dispatch-sync.ts
 *
 * Synchronous Agent-to-Agent (A2A) dispatch.
 * Maximum task duration: 10 minutes (600 s).
 *
 * Flow:
 *   1. Resolve target assistant UUID by name/prompt_name via LangGraph API
 *   2. Create a new LangGraph thread (each A2A call gets its own thread)
 *   3. Stream the run, collecting the final response
 *   4. Write a dispatch audit entry to agent_memory (if tenant_id available)
 *   5. Return structured result to caller
 *
 * Called by: Lumen / Sega / any agent via `run_assistant` tool
 * Payload injected by: a2a_dispatch_sync Trigger.dev orchestration task
 */

import { task, logger } from "@trigger.dev/sdk";

// ── env helper ────────────────────────────────────────────────────────────────

function env(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

// ── LangGraph helpers ─────────────────────────────────────────────────────────

async function lgFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const base = env("LANGGRAPH_URL").replace(/\/$/, "");
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      "x-api-key": env("LANGSMITH_API_KEY"),
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

async function resolveAssistantId(agentName: string): Promise<string | null> {
  // agentName may already be a UUID — if so, return directly
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidPattern.test(agentName)) return agentName;

  // Search assistants by name
  const res = await lgFetch(
    `/assistants/search`,
    {
      method: "POST",
      body: JSON.stringify({ limit: 10 }),
    }
  );
  if (!res.ok) {
    logger.warn("resolveAssistantId search failed", { status: res.status });
    return null;
  }

  const list = (await res.json()) as Array<{
    assistant_id: string;
    name: string;
    config?: { configurable?: { prompt_name?: string } };
  }>;

  // Match by exact name, or by configurable.prompt_name
  const match = list.find(
    (a) =>
      a.name === agentName ||
      a.config?.configurable?.prompt_name === agentName
  );
  return match?.assistant_id ?? null;
}

async function createThread(): Promise<string> {
  const res = await lgFetch("/threads", { method: "POST", body: "{}" });
  if (!res.ok) throw new Error(`createThread ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { thread_id: string };
  return data.thread_id;
}

async function streamRun(
  threadId: string,
  assistantId: string,
  userMessage: string,
  metadata?: Record<string, unknown>
): Promise<string> {
  const res = await lgFetch(`/threads/${threadId}/runs/stream`, {
    method: "POST",
    body: JSON.stringify({
      assistant_id: assistantId,
      input: { messages: [{ role: "human", content: userMessage }] },
      stream_mode: ["values"],
      config: { metadata: metadata ?? {} },
    }),
  });

  if (!res.ok) {
    throw new Error(`streamRun ${res.status}: ${await res.text()}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body from LangGraph stream");

  const decoder = new TextDecoder();
  let buffer = "";
  let lastAiContent = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (raw === "[DONE]") continue;
      try {
        const parsed = JSON.parse(raw) as {
          messages?: Array<{
            type: string;
            content: string | Array<{ type: string; text?: string }>;
          }>;
        };
        const messages = parsed?.messages;
        if (Array.isArray(messages)) {
          for (const msg of messages) {
            if (msg.type === "ai" || msg.type === "assistant") {
              if (typeof msg.content === "string") {
                lastAiContent = msg.content;
              } else if (Array.isArray(msg.content)) {
                const text = msg.content
                  .filter((b) => b.type === "text")
                  .map((b) => b.text ?? "")
                  .join("");
                if (text) lastAiContent = text;
              }
            }
          }
        }
      } catch {
        // Non-JSON SSE line — skip
      }
    }
  }

  return lastAiContent;
}

// ── Supabase memory write ─────────────────────────────────────────────────────

async function writeDispatchMemory(opts: {
  tenantId: string;
  callerAgentId: string;
  targetAgentId: string;
  targetAgentName: string;
  threadId: string;
  correlationId: string;
  message: string;
  responseExcerpt: string;
}): Promise<void> {
  if (!opts.tenantId) return; // Never use a fake UUID
  const url = `${env("SUPABASE_URL")}/rest/v1/rpc/memory_write_versioned`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        apikey: env("SUPABASE_SERVICE_ROLE_KEY"),
        Authorization: `Bearer ${env("SUPABASE_SERVICE_ROLE_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_agent_id: opts.callerAgentId,
        p_tenant_id: opts.tenantId,
        p_namespace: "a2a_dispatches",
        p_key: `sync:${opts.targetAgentName}:${opts.correlationId}`,
        p_content: `[A2A sync dispatch to ${opts.targetAgentName}]\nMessage: ${opts.message.slice(0, 300)}\nResponse: ${opts.responseExcerpt.slice(0, 500)}`,
        p_memory_type: "fact",
        p_source: "system",
        p_confidence: 1.0,
        p_importance_score: 0.6,
        p_metadata: {
          target_agent_id: opts.targetAgentId,
          target_agent_name: opts.targetAgentName,
          thread_id: opts.threadId,
          correlation_id: opts.correlationId,
          transport: "trigger_sync",
        },
      }),
    });
    if (!res.ok) {
      logger.warn("writeDispatchMemory failed", { status: res.status });
    }
  } catch (err) {
    logger.warn("writeDispatchMemory error (non-fatal)", { err });
  }
}

// ── Payload type ──────────────────────────────────────────────────────────────

export type A2ADispatchSyncPayload = {
  /** Target agent: name, prompt_name, or UUID */
  agent_name: string;
  /** Message to send to the target agent */
  message: string;
  /** Caller's assistant UUID (for audit) */
  caller_assistant_id?: string;
  /** Caller's thread UUID (for correlation) */
  caller_thread_id?: string;
  /** Caller's LangSmith run UUID (for correlation) */
  caller_run_id?: string;
  /** Shared correlation ID linking both sides of the call */
  correlation_id?: string;
  /** Tenant UUID for memory scoping — skips memory write if absent */
  tenant_id?: string;
  /** Intent token payload (forwarded verbatim to target) */
  intent_token?: string;
};

// ── Task definition ───────────────────────────────────────────────────────────

export const a2aDispatchSync = task({
  id: "a2a_dispatch_sync",
  maxDuration: 600,

  run: async (payload: A2ADispatchSyncPayload) => {
    const {
      agent_name,
      message,
      caller_assistant_id = "unknown",
      caller_thread_id = null,
      caller_run_id = "unknown",
      correlation_id = crypto.randomUUID(),
      tenant_id = "",
      intent_token,
    } = payload;

    logger.info("a2a_dispatch_sync started", { agent_name, correlation_id });

    // 1. Resolve target assistant UUID
    const assistantId = await resolveAssistantId(agent_name);
    if (!assistantId) {
      throw new Error(
        `Could not resolve assistant "${agent_name}". Check the name or UUID and ensure it is deployed.`
      );
    }
    logger.info("Resolved assistant", { agent_name, assistantId });

    // 2. Create a dedicated thread for this A2A call
    const threadId = await createThread();
    logger.info("Thread created", { threadId });

    // 3. Build the full message (prepend intent token if provided)
    const fullMessage = intent_token
      ? `[INTENT_TOKEN:${intent_token}]\n\n${message}`
      : message;

    // 4. Stream the run
    const metadata: Record<string, unknown> = {
      a2a_caller_assistant_id: caller_assistant_id,
      a2a_caller_thread_id: caller_thread_id,
      a2a_caller_run_id: caller_run_id,
      a2a_correlation_id: correlation_id,
      tenant_id: tenant_id || undefined,
    };

    const response = await streamRun(threadId, assistantId, fullMessage, metadata);

    logger.info("a2a_dispatch_sync completed", {
      agent_name,
      correlation_id,
      thread_id: threadId,
      response_length: response.length,
    });

    // 5. Write audit memory entry
    await writeDispatchMemory({
      tenantId: tenant_id,
      callerAgentId: caller_assistant_id,
      targetAgentId: assistantId,
      targetAgentName: agent_name,
      threadId,
      correlationId: correlation_id,
      message,
      responseExcerpt: response,
    });

    return {
      ok: true,
      agent: agent_name,
      assistant_id: assistantId,
      thread_id: threadId,
      run_id: null, // individual run ID not exposed by stream endpoint
      response,
      transport: "trigger_sync" as const,
      correlation_id,
    };
  },
});
