# Setup Guide

Step-by-step guide to deploy the full agent stack from scratch.
Estimated time: **30–60 minutes**.

---

## Prerequisites

| Service | Purpose | Cost |
|---------|---------|------|
| [Supabase](https://supabase.com) | Database, memory, state | Free tier works |
| [LangSmith / LangGraph Cloud](https://smith.langchain.com) | Agent execution | Paid plan required |
| [Trigger.dev](https://trigger.dev) | Orchestration | Free tier works |
| [GitHub](https://github.com) | Task intake, code | Free |

---

## Step 1 — Supabase Setup

### 1.1 Create a project

1. Go to [app.supabase.com](https://app.supabase.com) → **New project**
2. Choose a region close to your users
3. Save the database password

### 1.2 Enable pgvector

In the Supabase dashboard: **Database** → **Extensions** → search `vector` → **Enable**

Or in SQL Editor:
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### 1.3 Run the migration

1. Open **SQL Editor** in your Supabase dashboard
2. Paste the full content of `supabase/migrations/00001_init.sql`
3. Click **Run**

This creates all 6 tables, indexes, RLS policies, the `memory_write_versioned` RPC, and a default tenant.

### 1.4 Get your credentials

From **Project Settings** → **API**:
- `SUPABASE_URL` — Project URL (e.g. `https://xxxx.supabase.co`)
- `SUPABASE_SERVICE_ROLE_KEY` — the `service_role` key (keep secret)

---

## Step 2 — LangGraph Cloud Setup

### 2.1 Deploy your agent graph

1. Go to [smith.langchain.com](https://smith.langchain.com) → **Deployments** → **+ New Deployment**
2. Connect your GitHub repo containing your `langgraph.json`
3. Set environment variables (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.)
4. Deploy

### 2.2 Create an Assistant

After your graph is deployed:
1. Deployment → **Assistants** → **+ New Assistant**
2. Select your graph
3. Copy the **Assistant UUID** — needed in Step 4

### 2.3 Get credentials

- `LANGGRAPH_URL` — deployment URL (e.g. `https://YOUR-ORG-abc123.us.langgraph.app`)
- `LANGSMITH_API_KEY` — from **Settings** → **API Keys** → **Create API Key**

---

## Step 3 — Trigger.dev Setup

### 3.1 Create a project

1. Go to [trigger.dev](https://trigger.dev) → **New Project** → **Node.js**
2. Copy the **Project Ref** (e.g. `proj_xxxxxxxxxxxx`)

### 3.2 Get your secret key

**Project Settings** → **API Keys** → copy the Secret Key (`tr_prod_...` or `tr_dev_...`).

### 3.3 Deploy

```bash
pnpm install
export TRIGGER_SECRET_KEY=tr_prod_...
pnpm run deploy
```

Tasks deployed: `agent-dispatch`, `a2a_dispatch_sync`, `a2a_dispatch_async`.

### 3.4 Set environment variables in Trigger.dev

Dashboard → **Environment Variables**, add:

```
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
LANGGRAPH_URL
LANGSMITH_API_KEY
GITHUB_TOKEN
```

---

## Step 4 — Register Your Project

The `agent-dispatch` task routes GitHub Issues to LangGraph assistants by looking up the `projects` table. Insert a row for each repo you want to connect.

Run in your Supabase SQL editor:

```sql
-- Optional: create a named tenant (a default tenant already exists)
INSERT INTO tenants (slug, name)
VALUES ('my-team', 'My Team')
ON CONFLICT (slug) DO NOTHING;

-- Register your project
INSERT INTO projects (
  tenant_id,
  name,
  slug,
  repo_full_name,
  langgraph_assistant_id,
  status
)
VALUES (
  (SELECT id FROM tenants WHERE slug = 'my-team'),
  'My Agent Project',
  'my-agent-project',
  'your-org/your-repo',                        -- GitHub repo full name (exact, case-sensitive)
  'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',      -- LangGraph assistant UUID from Step 2.2
  'ready'
);
```

---

## Step 5 — GitHub Setup

### 5.1 Create a PAT

GitHub → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens**

Required permissions:
- **Issues**: Read & write
- **Contents**: Read

Copy the token → `GITHUB_TOKEN`

### 5.2 Wire the webhook

The `agent-dispatch` task is triggered via Trigger.dev's HTTP endpoint. You need to forward GitHub issue-opened events to it.

**Option A** — Use a small webhook proxy (e.g. a Cloudflare Worker or AWS Lambda) that:
1. Receives GitHub webhook POST
2. Verifies the payload (HMAC-SHA256 with your webhook secret)
3. Calls: `POST https://api.trigger.dev/api/v1/tasks/agent-dispatch/trigger` with your `TRIGGER_SECRET_KEY` as Bearer token
4. Body: `{ "payload": { "task": "<issue title>", "issue_number": <n>, "repo_full_name": "<owner/repo>" } }`

**Option B** — Use Trigger.dev's native GitHub integration (see [trigger.dev/docs/integrations](https://trigger.dev/docs/integrations))

### 5.3 Test

Open an issue in your connected repo with title: `[TASK] hello world`

Expected result:
1. Trigger.dev run appears in dashboard
2. Issue gets a comment with the agent's response

---

## Step 6 — Optional: Tool Registry

Populate `tool_registry` so agents can discover tools dynamically:

```sql
INSERT INTO tool_registry (tool_name, description, category, enabled, schema_json)
VALUES (
  'web_search',
  'Search the web for current information',
  'research',
  true,
  '{"parameters": {"query": {"type": "string", "description": "Search query"}}}'
);
```

---

## Environment Variables Reference

| Variable | Description | Where to find |
|----------|-------------|---------------|
| `SUPABASE_URL` | Supabase project URL | Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key | Project Settings → API |
| `LANGGRAPH_URL` | LangGraph Cloud deployment URL | LangSmith → Deployments |
| `LANGSMITH_API_KEY` | LangSmith API key | LangSmith → Settings → API Keys |
| `GITHUB_TOKEN` | GitHub Personal Access Token | GitHub → Developer Settings |
| `TRIGGER_PROJECT_REF` | Trigger.dev project ref | Trigger.dev → Project Settings |
| `TRIGGER_SECRET_KEY` | Trigger.dev secret key | Trigger.dev → API Keys |

---

## Troubleshooting

**"No project assistant found" comment on issue**
→ Check `projects.repo_full_name` exactly matches `owner/repo` (case-sensitive).

**`memory_write_versioned` RPC not found**
→ Re-run the full migration SQL. The function is at the bottom of the file.

**LangGraph runs fail with 401**
→ Verify `LANGSMITH_API_KEY` is set in Trigger.dev environment variables (not just `.env`).

**pgvector extension error during migration**
→ Enable the `vector` extension in Supabase Dashboard → Database → Extensions first.

**Trigger.dev tasks not receiving events**
→ Check your webhook proxy is forwarding the correct payload shape: `{ task, issue_number, repo_full_name }`.
