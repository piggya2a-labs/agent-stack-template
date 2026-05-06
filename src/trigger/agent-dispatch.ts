/**
 * src/trigger/agent-dispatch.ts
 *
 * GitHub Issue [TASK] → LangGraph Cloud router.
 *
 * Triggered by a webhook (or any caller) with payload:
 *   { task, issue_number, repo_full_name, tenant_id? }
 *
 * Flow:
 *   1. Look up the assistant UUID in the `projects` table via Supabase REST
 *   2. Create a new LangGraph thread
 *   3. Stream a run on that thread with the task as user message
 *   4. Extract the final text response
 *   5. Post a comment on the GitHub Issue
 *   6. Write a memory entry (if tenant_id is known)
 */

import { task, logger } from "@trigger.dev/sdk";
import { getGitHubHeaders } from "./github-auth.js";

// ── env helper ────────────────────────────────────────────────────────────────

function env(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

// ── Supabase thin client ──────────────────────────────────────────────────────

async function supabaseFetch(
  path: string,
  init: RequestInit = {}
): Promise<unknown> {
  const url = `${env("SUPABASE_URL")}/rest/v1${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      apikey: env("SUPABASE_SERVICE_ROLE_KEY"),
      Authorization: `Bearer ${env("SUPABASE_SERVICE_ROLE_KEY")}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// ── LangGraph helpers ─────────────────────────────────────────────────────────

async function lgFetch(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
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

async function createThread(): Promise<string> {
  const res = await lgFetch("/threads", { method: "POST", body: "{}" });
  if (!res.ok) throw new Error(`createThread ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { thread_id: string };
  return data.thread_id;
}

async function streamRun(
  threadId: string,
  assistantId: string,
  userMessage: string
): Promise<string> {
  const res = await lgFetch(`/threads/${threadId}/runs/stream`, {
    method: "POST",
    body: JSON.stringify({
      assistant_id: assistantId,
      input: { messages: [{ role: "human", content: userMessage }] },
      stream_mode: ["values"],
    }),
  });

  if (!res.ok) {
    throw new Error(`streamRun ${res.status}: ${await res.text()}`);
  }

  // Parse SSE stream and capture the last AI message content
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
          messages?: Array<{ type: string; content: string | Array<{type: string; text?: string}> }>;
        };
        const messages = parsed?.messages;
        if (Array.isArray(messages)) {
          for (const msg of messages) {
            if (msg.type === "ai" || msg.type === "assistant") {
              if (typeof msg.content === "string") {
                lastAiContent = msg.content;
              } else if (Array.isArray(msg.content)) {
                // Handle structured content blocks
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
        // Non-JSON SSE lines (comments, etc.) — skip
      }
    }
  }

  return lastAiContent;
}

// ── GitHub Issue comment ──────────────────────────────────────────────────────

async function postIssueComment(
  repoFullName: string,
  issueNumber: number,
  body: string
): Promise<void> {
  const [owner, repo] = repoFullName.split("/");
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`;
  const res = await fetch(url, {
    method: "POST",
    headers: getGitHubHeaders(),
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`postIssueComment ${res.status}: ${text}`);
  }
}

// ── Memory write ──────────────────────────────────────────────────────────────

async function writeMemory(
  tenantId: string,
  agentId: string,
  key: string,
  content: string
): Promise<void> {
  // Skips silently if tenant_id is empty — never uses a fake/hardcoded UUID
  if (!tenantId) return;
  try {
    await supabaseFetch("/rpc/memory_write_versioned", {
      method: "POST",
      body: JSON.stringify({
        p_agent_id: agentId,
        p_tenant_id: tenantId,
        p_namespace: "agent_dispatch",
        p_key: key,
        p_content: content,
        p_memory_type: "fact",
        p_source: "system",
        p_confidence: 0.9,
        p_importance_score: 0.5,
      }),
    });
  } catch (err) {
    // Non-fatal — memory write failures never block the main flow
    logger.warn("Memory write failed (non-fatal)", { err });
  }
}

// ── Payload type ──────────────────────────────────────────────────────────────

export type AgentDispatchPayload = {
  /** The task text (Issue title or body excerpt) */
  task: string;
  /** GitHub Issue number */
  issue_number: number;
  /** Full repo name, e.g. "my-org/my-repo" */
  repo_full_name: string;
  /** Optional tenant UUID for memory scoping */
  tenant_id?: string;
};

// ── Task definition ───────────────────────────────────────────────────────────

export const agentDispatch = task({
  id: "agent-dispatch",
  maxDuration: 300,

  run: async (payload: AgentDispatchPayload) => {
    const { task: taskText, issue_number, repo_full_name, tenant_id } = payload;

    logger.info("agent-dispatch started", { repo_full_name, issue_number });

    // 1. Look up the LangGraph assistant for this repo
    const rows = (await supabaseFetch(
      `/projects?repo_full_name=eq.${encodeURIComponent(repo_full_name)}&status=eq.ready&select=langgraph_assistant_id,name,tenant_id&limit=1`
    )) as Array<{ langgraph_assistant_id: string; name: string; tenant_id: string }>;

    if (!rows || rows.length === 0) {
      const msg = `No active project found for repo \`${repo_full_name}\`. Please register it in the \`projects\` table.`;
      logger.warn("No project assistant found", { repo_full_name });
      await postIssueComment(repo_full_name, issue_number, msg);
      return { ok: false, reason: "no_project" };
    }

    const { langgraph_assistant_id: assistantId, name: projectName, tenant_id: projectTenantId } = rows[0];
    // Prefer the explicit tenant_id from the payload; fall back to the one stored on the project
    const effectiveTenantId = tenant_id ?? projectTenantId ?? "";

    logger.info("Routing to assistant", { assistantId, projectName });

    // 2. Create a new LangGraph thread
    const threadId = await createThread();
    logger.info("Thread created", { threadId });

    // 3. Stream the run
    const agentResponse = await streamRun(threadId, assistantId, taskText);

    if (!agentResponse) {
      const msg = `Agent ran but returned an empty response. Check the LangGraph deployment logs for thread \`${threadId}\`.`;
      await postIssueComment(repo_full_name, issue_number, msg);
      return { ok: false, reason: "empty_response", thread_id: threadId };
    }

    logger.info("Agent response received", { chars: agentResponse.length });

    // 4. Post result as GitHub Issue comment
    await postIssueComment(repo_full_name, issue_number, agentResponse);

    // 5. Write memory entry (skips if no tenant)
    await writeMemory(
      effectiveTenantId,
      assistantId,
      `dispatch:${repo_full_name}:${issue_number}`,
      `Task: ${taskText}\n\nResponse excerpt: ${agentResponse.slice(0, 500)}`
    );

    logger.info("agent-dispatch completed", { issue_number, thread_id: threadId });

    return {
      ok: true,
      thread_id: threadId,
      assistant_id: assistantId,
      response_length: agentResponse.length,
    };
  },
});
