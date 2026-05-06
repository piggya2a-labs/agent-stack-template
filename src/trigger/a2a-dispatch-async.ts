/**
 * src/trigger/a2a-dispatch-async.ts
 *
 * Asynchronous Agent-to-Agent (A2A) dispatch.
 * Maximum task duration: 7200 s (2 hours).
 *
 * Flow:
 *   1. Resolve target assistant UUID by name/prompt_name via LangGraph API
 *   2. Create a new LangGraph thread (each A2A call gets its own thread)
 *   3. Start a run (non-streaming) and wait for completion via polling
 *   4. Extract final response from the completed run
 *   5. Write dispatch audit entry to agent_memory (if tenant_id available)
 *   6. Complete the Trigger.dev waitpoint token if one was provided (callback mode)
 *   7. Return structured result
 *
 * Called by: Lumen / Sega / any agent via `start_assistant` tool (fire-and-forget mode)
 * Payload injected by: a2a_dispatch_async Trigger.dev orchestration task
 */

import { task, logger, wait } from "@trigger.dev/sdk";

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
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidPattern.test(agentName)) return agentName;

  const res = await lgFetch("/assistants/search", {
    method: "POST",
    body: JSON.stringify({ limit: 10 }),
  });
  if (!res.ok) {
    logger.warn("resolveAssistantId search failed", { status: res.status });
    return null;
  }

  const list = (await res.json()) as Array<{
    assistant_id: string;
    name: string;
    config?: { configurable?: { prompt_name?: string } };
  }>;

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

async function startRun(
  threadId: string,
  assistantId: string,
  userMessage: string,
  metadata?: Record<string, unknown>
): Promise<string> {
  const res = await lgFetch(`/threads/${threadId}/runs`, {
    method: "POST",
    body: JSON.stringify({
      assistant_id: assistantId,
      input: { messages: [{ role: "human", content: userMessage }] },
      config: { metadata: metadata ?? {} },
    }),
  });
  if (!res.ok) throw new Error(`startRun ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { run_id: string };
  return data.run_id;
}

async function pollRunUntilDone(
  threadId: string,
  runId: string,
  maxWaitMs = 7_000_000
): Promise<string> {
  const pollIntervalMs = 3_000;
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    const res = await lgFetch(`/threads/${threadId}/runs/${runId}`);
    if (!res.ok) throw new Error(`pollRun ${res.status}: ${await res.text()}`);
    const run = (await res.json()) as { status: string };

    if (run.status === "success") return "success";
    if (run.status === "error" || run.status === "failed") {
      throw new Error(`LangGraph run ended with status: ${run.status}`);
    }
    if (run.status === "timeout") {
      throw new Error("LangGraph run timed out");
    }

    // Still running — wait before next poll
    await wait.for({ seconds: pollIntervalMs / 1_000 });
  }

  throw new Error(`Run ${runId} did not complete within the max wait window`);
}

async function getThreadLastAiMessage(threadId: string): Promise<string> {
  const res = await lgFetch(`/threads/${threadId}/state`);
  if (!res.ok) throw new Error(`getThreadState ${res.status}: ${await res.text()}`);

  const state = (await res.json()) as {
    values?: {
      messages?: Array<{
        type: string;
        content: string | Array<{ type: string; text?: string }>;
      }>;
    };
  };

  const messages = state?.values?.messages ?? [];
  // Walk backwards to find the last AI message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === "ai" || msg.type === "assistant") {
      if (typeof msg.content === "string") return msg.content;
      if (Array.isArray(msg.content)) {
        const text = msg.content
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("");
        if (text) return text;
      }
    }
  }
  return "";
}

// ── Supabase memory write ─────────────────────────────────────────────────────

async function writeDispatchMemory(opts: {
  tenantId: string;
  callerAgentId: string;
  targetAgentId: string;
  targetAgentName: string;
  threadId: string;
  runId: string;
  correlationId: string;
  message: string;
  responseExcerpt: string;
}): Promise<void> {
  if (!opts.tenantId) return; // Skip if no tenant — never use a fake UUID
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
        p_key: `async:${opts.targetAgentName}:${opts.correlationId}`,
        p_content: `[A2A async dispatch to ${opts.targetAgentName}]\nMessage: ${opts.message.slice(0, 300)}\nResponse: ${opts.responseExcerpt.slice(0, 500)}`,
        p_memory_type: "fact",
        p_source: "system",
        p_confidence: 1.0,
        p_importance_score: 0.6,
        p_metadata: {
          target_agent_id: opts.targetAgentId,
          target_agent_name: opts.targetAgentName,
          thread_id: opts.threadId,
          run_id: opts.runId,
          correlation_id: opts.correlationId,
          transport: "trigger_async",
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

// ── Trigger.dev waitpoint completion ─────────────────────────────────────────

async function completeWaitpointToken(
  tokenId: string,
  result: unknown
): Promise<void> {
  // Uses the Trigger.dev management API to complete a waitpoint token
  const triggerApiUrl = "https://api.trigger.dev/api/v1/waitpoints/tokens";
  try {
    const res = await fetch(`${triggerApiUrl}/${tokenId}/complete`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env("TRIGGER_SECRET_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ output: result }),
    });
    if (!res.ok) {
      logger.warn("completeWaitpointToken failed", { status: res.status });
    } else {
      logger.info("Waitpoint token completed", { tokenId });
    }
  } catch (err) {
    logger.warn("completeWaitpointToken error (non-fatal)", { err });
  }
}

// ── Payload type ──────────────────────────────────────────────────────────────

export type A2ADispatchAsyncPayload = {
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
  /**
   * If set, the task will complete this Trigger.dev waitpoint token
   * with the result once the target agent finishes.
   * Enables the caller to poll for the result via check_waitpoint_token.
   */
  callback_token?: string;
};

// ── Task definition ───────────────────────────────────────────────────────────

export const a2aDispatchAsync = task({
  id: "a2a_dispatch_async",
  maxDuration: 7200,

  run: async (payload: A2ADispatchAsyncPayload) => {
    const {
      agent_name,
      message,
      caller_assistant_id = "unknown",
      caller_thread_id = null,
      caller_run_id = "unknown",
      correlation_id = crypto.randomUUID(),
      tenant_id = "",
      intent_token,
      callback_token,
    } = payload;

    logger.info("a2a_dispatch_async started", { agent_name, correlation_id });

    // 1. Resolve target assistant UUID
    const assistantId = await resolveAssistantId(agent_name);
    if (!assistantId) {
      throw new Error(
        `Could not resolve assistant "${agent_name}". Check the name or UUID and ensure it is deployed.`
      );
    }
    logger.info("Resolved assistant", { agent_name, assistantId });

    // 2. Create a dedicated thread
    const threadId = await createThread();
    logger.info("Thread created", { threadId });

    // 3. Build the full message
    const fullMessage = intent_token
      ? `[INTENT_TOKEN:${intent_token}]\n\n${message}`
      : message;

    // 4. Start the run (non-streaming)
    const metadata: Record<string, unknown> = {
      a2a_caller_assistant_id: caller_assistant_id,
      a2a_caller_thread_id: caller_thread_id,
      a2a_caller_run_id: caller_run_id,
      a2a_correlation_id: correlation_id,
      tenant_id: tenant_id || undefined,
    };

    const runId = await startRun(threadId, assistantId, fullMessage, metadata);
    logger.info("Run started", { runId, threadId });

    // 5. Poll until done
    await pollRunUntilDone(threadId, runId);
    logger.info("Run completed", { runId });

    // 6. Retrieve the final response from thread state
    const response = await getThreadLastAiMessage(threadId);

    logger.info("a2a_dispatch_async completed", {
      agent_name,
      correlation_id,
      thread_id: threadId,
      run_id: runId,
      response_length: response.length,
    });

    // 7. Write audit memory entry
    await writeDispatchMemory({
      tenantId: tenant_id,
      callerAgentId: caller_assistant_id,
      targetAgentId: assistantId,
      targetAgentName: agent_name,
      threadId,
      runId,
      correlationId: correlation_id,
      message,
      responseExcerpt: response,
    });

    const result = {
      ok: true,
      agent: agent_name,
      assistant_id: assistantId,
      thread_id: threadId,
      run_id: runId,
      response,
      transport: "trigger_async" as const,
      correlation_id,
    };

    // 8. Complete waitpoint token if caller requested callback mode
    if (callback_token) {
      await completeWaitpointToken(callback_token, result);
    }

    return result;
  },
});
