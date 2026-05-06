# Agent Stack Template

A production-ready infrastructure template for building multi-agent systems with:

- **LangGraph Cloud** — agent graph execution and observability
- **Trigger.dev** — orchestration, A2A dispatch, scheduled tasks
- **Supabase** — persistent memory, tool registry, state management
- **GitHub** — task intake via Issues (`[TASK]` prefix convention)

## Architecture

```
GitHub Issue [TASK]
  → Trigger.dev webhook
  → agent-dispatch task
  → Supabase projects lookup (repo → assistant)
  → LangGraph Cloud run
  → GitHub Issue comment (result)
```

Agent-to-agent calls flow through `a2a-dispatch-sync` (≤10 min) or `a2a-dispatch-async` (≤2 hours), each giving the target agent its own independent thread.

## Repository Structure

```
.
├── supabase/
│   └── migrations/
│       └── 00001_init.sql       # All 6 tables + pgvector + RPC
├── src/
│   └── trigger/
│       ├── init.ts              # Global middleware (auto tenant-tag)
│       ├── streams.ts           # Realtime stream definitions
│       ├── github-auth.ts       # GitHub PAT helper
│       ├── agent-dispatch.ts    # GitHub Issue → LangGraph router
│       ├── a2a-dispatch-sync.ts # Synchronous A2A dispatch (≤10 min)
│       └── a2a-dispatch-async.ts# Async A2A dispatch (≤2 hours)
├── .env.example
├── trigger.config.ts
├── package.json
├── tsconfig.json
└── SETUP.md
```

## Quick Start

See [SETUP.md](./SETUP.md) for the full step-by-step guide.

1. Create accounts: Supabase, LangGraph Cloud, Trigger.dev
2. Run `supabase/migrations/00001_init.sql` in your Supabase SQL editor
3. Deploy your LangGraph graph and create an assistant
4. Copy `.env.example` → `.env`, fill in your keys
5. `pnpm install && pnpm run deploy`
6. Register your repo in the `projects` table (see SETUP.md Step 4)
7. Open a `[TASK] your task here` issue → agent responds
