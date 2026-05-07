/**
 * agent-dispatch.ts — Trigger.dev Orchestrator Task
 *
 * Triggered by github-webhook when a [TASK] issue is opened.
 * Routes to the repo's registered project assistant.
 *
 * Payload: { task, issue_number, tenant_id, installation_id, repo_full_name }
 *
 * Required env vars:
 *   SUPABASE_URL               — your Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY  — Supabase service role key
 *   LANGGRAPH_URL              — your LangGraph Cloud deployment URL
 *   LANGSMITH_API_KEY          — LangSmith API key
 *   GITHUB_TOKEN               — GitHub PAT (Issues read/write)
 */

import { task, wait } from "@trigger.dev/sdk";
import { getInstallationToken } from "./github-auth";

// ── Environment helpers ───────────────────────────────────────────────────────

function env(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function supabaseHeaders(): Record<string, string> {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

// Look up a user's project by repo — returns assistant info if found.
async function lookupProjectByRepo(
  tenantId: string,
  repoFullName: string,
): Promise<{ assistantId: string; langgraphUrl: string } | null> {
  const url = env("SUPABASE_URL");
  const motherUrl = env("LANGGRAPH_URL");
  const resp = await fetch(
    `${url}/rest/v1/projects?tenant_id=eq.${tenantId}&repo_full_name=eq.${encodeURIComponent(repoFullName)}&status=eq.ready&select=langgraph_assistant_id&limit=1`,
    { headers: supabaseHeaders() },
  );
  if (!resp.ok) {
    console.warn(
      `lookupProjectByRepo: Supabase error ${resp.status} for ${repoFullName}`,
    );
    return null;
  }
  const rows = (await resp.json()) as Array<{ langgraph_assistant_id: string | null }>;
  const assistantId = rows[0]?.langgraph_assistant_id;
  if (!assistantId) return null;
  return { assistantId, langgraphUrl: motherUrl };
}

// ── LangGraph API ─────────────────────────────────────────────────────────────

interface LangGraphRunResult {
  threadId: string;
  runId: string;
  output: string;
  calledCopilotIssue: boolean;
}

async function callLangGraphAssistant(
  assistantId: string,
  langgraphUrl: string,
  taskText: string,
  tenantId: string,
  installationId: number,
): Promise<LangGraphRunResult> {
  const apiKey = env("LANGSMITH_API_KEY");
  const baseUrl = langgraphUrl.replace(/\/$/, "");

  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "Content-Type": "application/json",
  };

  const threadResp = await fetch(`${baseUrl}/threads`, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
  if (!threadResp.ok) {
    throw new Error(`LangGraph /threads failed: ${threadResp.status} ${await threadResp.text()}`);
  }
  const { thread_id: threadId } = (await threadResp.json()) as { thread_id: string };

  const runResp = await fetch(`${baseUrl}/threads/${threadId}/runs/wait`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      assistant_id: assistantId,
      input: {
        messages: [{ role: "human", content: taskText }],
      },
      config: {
        configurable: {
          tenant_id: tenantId,
          installation_id: String(installationId),
          actor_type: "system",
          actor_id: "agent-dispatch",
          source: "github_task_issue",
        },
      },
    }),
  });

  if (!runResp.ok) {
    throw new Error(`LangGraph /runs/wait failed: ${runResp.status} ${await runResp.text()}`);
  }

  const result = (await runResp.json()) as {
    messages?: Array<{
      type: string;
      content: string | Array<{ type: string; text: string }>;
      tool_calls?: Array<{ name: string }>;
    }>;
    metadata?: { run_id?: string };
  };

  const messages = result.messages ?? [];
  let output = JSON.stringify(result);
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === "ai") {
      const content = messages[i].content;
      if (typeof content === "string") {
        output = content;
      } else if (Array.isArray(content)) {
        output = content.filter(b => b.type === "text").map(b => b.text).join("\n\n") || output;
      }
      break;
    }
  }

  const calledCopilotIssue = messages.some(
    m => m.type === "ai" &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.some(tc => tc.name === "create_copilot_issue")
  );

  const runId = result.metadata?.run_id ?? threadId;
  return { threadId, runId, output, calledCopilotIssue };
}

// ── GitHub helpers ────────────────────────────────────────────────────────────

async function githubHeaders(installationId: number): Promise<Record<string, string>> {
  try {
    const token = await getInstallationToken(installationId);
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    };
  } catch (e) {
    console.warn(`Installation token failed, falling back to PAT: ${e}`);
    const pat = env("GITHUB_TOKEN", "");
    return {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    };
  }
}

async function postGitHubCommentIdempotent(
  repoFullName: string,
  issueNumber: number,
  body: string,
  idempotencyKey: string,
  installationId: number,
): Promise<void> {
  const headers = await githubHeaders(installationId);
  const marker = `<!-- idem:${idempotencyKey} -->`;
  const bodyWithMarker = `${body}\n\n${marker}`;

  try {
    const listResp = await fetch(
      `https://api.github.com/repos/${repoFullName}/issues/${issueNumber}/comments?per_page=100`,
      { headers }
    );
    if (listResp.ok) {
      const comments = (await listResp.json()) as Array<{ body: string }>;
      if (comments.some(c => c.body?.includes(marker))) return;
    }
  } catch { /* proceed */ }

  await fetch(
    `https://api.github.com/repos/${repoFullName}/issues/${issueNumber}/comments`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ body: bodyWithMarker }),
    }
  );
}

async function checkIssueHasLabel(
  repoFullName: string,
  issueNumber: number,
  labelName: string,
  installationId: number,
): Promise<boolean> {
  const headers = await githubHeaders(installationId);
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${repoFullName}/issues/${issueNumber}/labels`,
      { headers }
    );
    if (!resp.ok) return false;
    const labels = (await resp.json()) as Array<{ name: string }>;
    return labels.some(l => l.name === labelName);
  } catch { return false; }
}

async function assignCopilotToIssue(
  repoFullName: string,
  issueNumber: number,
  installationId: number,
): Promise<void> {
  const headers = await githubHeaders(installationId);
  try {
    await fetch(
      `https://api.github.com/repos/${repoFullName}/issues/${issueNumber}/assignees`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ assignees: ["copilot-swe-agent[bot]"] }),
      }
    );
  } catch (e) {
    console.warn(`Copilot assign failed: ${e}`);
  }
}

// ── Trigger.dev Task ──────────────────────────────────────────────────────────

export interface AgentDispatchPayload {
  task: string;
  issue_number: number;
  tenant_id: string;
  installation_id: number;
  repo_full_name: string;
}

export const agentDispatch = task({
  id: "agent-dispatch",
  retry: { maxAttempts: 3 },

  async run(payload: AgentDispatchPayload, { ctx }) {
    const {
      task: taskText,
      issue_number: issueNumber,
      tenant_id: tenantId,
      installation_id: installationId,
      repo_full_name: repoFullName,
    } = payload;

    const runPrefix = ctx?.run?.id ?? `fallback-${issueNumber}-${Date.now()}`;

    // ── Copilot direct-assign branch ──────────────────────────────────────
    const isCopilotTask = await checkIssueHasLabel(repoFullName, issueNumber, "copilot-task", installationId);
    if (isCopilotTask) {
      await postGitHubCommentIdempotent(
        repoFullName, issueNumber,
        `🤖 **Copilot direct mode**: detected \`copilot-task\` label, assigning to GitHub Copilot...`,
        `${runPrefix}:copilot-assign`, installationId
      );

      await assignCopilotToIssue(repoFullName, issueNumber, installationId);

      const token = await wait.createToken();
      await postGitHubCommentIdempotent(
        repoFullName, issueNumber,
        [
          "## ⏳ Waiting for Copilot",
          "",
          "Copilot has been assigned. Waiting for PR to be submitted and merged.",
          "",
          `*[Webhook URL](${token.url})*`,
          `*tenant: \`${tenantId}\` · agent-gateway*`,
        ].join("\n"),
        `${runPrefix}:copilot-wait`, installationId
      );

      const waitPayload = await wait.forToken(token);

      await postGitHubCommentIdempotent(
        repoFullName, issueNumber,
        "## ✅ Copilot task complete\n\nPR merged — task loop closed.",
        `${runPrefix}:copilot-done`, installationId
      );

      return { ok: true, assignee: "copilot-swe-agent", tenantId, waitPayload };
    }

    // ── Normal LangGraph routing branch ───────────────────────────────────
    const project = await lookupProjectByRepo(tenantId, repoFullName);
    if (!project) {
      await postGitHubCommentIdempotent(
        repoFullName, issueNumber,
        [
          "## ⚠️ No project assistant found",
          "",
          `Repo \`${repoFullName}\` has no registered LangGraph assistant in the \`projects\` table.`,
          "Please bind a \`langgraph_assistant_id\` via the setup guide and re-open this issue.",
        ].join("\n"),
        `${runPrefix}:no-project`, installationId
      );
      return { ok: false, reason: "no_project_assistant", tenantId };
    }

    await postGitHubCommentIdempotent(
      repoFullName, issueNumber,
      `⚙️ **Running...**`,
      `${runPrefix}:executing`, installationId
    );

    let lgResult: LangGraphRunResult;
    try {
      lgResult = await callLangGraphAssistant(
        project.assistantId,
        project.langgraphUrl,
        taskText,
        tenantId,
        installationId,
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await postGitHubCommentIdempotent(
        repoFullName, issueNumber,
        `## ❌ Task failed\n\n\`\`\`\n${errMsg}\n\`\`\`\n\n*tenant: \`${tenantId}\` · agent-gateway*`,
        `${runPrefix}:error`, installationId
      );
      throw err;
    }
    const { threadId, runId, output, calledCopilotIssue } = lgResult;

    if (calledCopilotIssue) {
      const token = await wait.createToken();
      await postGitHubCommentIdempotent(
        repoFullName, issueNumber,
        [
          "## ⏳ Task paused — waiting for external action",
          "",
          `**Assistant**: \`${project.assistantId}\``,
          "",
          output,
          "",
          `*[Webhook URL](${token.url})*`,
          `*\`run_id\`: \`${runId}\` · tenant: \`${tenantId}\` · agent-gateway*`,
        ].join("\n"),
        `${runPrefix}:wait`, installationId
      );

      const waitPayload = await wait.forToken(token);

      await postGitHubCommentIdempotent(
        repoFullName, issueNumber,
        "## ✅ Task resumed and complete\n\nPR merged — task loop closed.",
        `${runPrefix}:resume`, installationId
      );

      return { ok: true, assistantId: project.assistantId, runId, threadId, tenantId, waitPayload };
    }

    await postGitHubCommentIdempotent(
      repoFullName, issueNumber,
      [
        "## ✅ Task complete",
        "",
        `**Assistant**: \`${project.assistantId}\``,
        "",
        output,
        "",
        `*\`run_id\`: \`${runId}\` · tenant: \`${tenantId}\` · agent-gateway*`,
      ].join("\n"),
      `${runPrefix}:result`, installationId
    );

    return { ok: true, assistantId: project.assistantId, runId, threadId, tenantId };
  },
});
