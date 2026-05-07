-- =============================================================================
-- Agent Stack Template — Supabase Migration 00001_init.sql
-- =============================================================================
-- Creates all 6 tables, pgvector, RLS policies, indexes, and the
-- memory_write_versioned RPC.
--
-- Run this once in the Supabase SQL Editor of a fresh project.
-- Prerequisites: pgvector extension must be enabled before running.
--   Dashboard → Database → Extensions → vector → Enable
-- =============================================================================

-- Enable pgvector (idempotent)
CREATE EXTENSION IF NOT EXISTS vector;

-- =============================================================================
-- TABLE 1: tenants
-- =============================================================================

CREATE TABLE IF NOT EXISTS tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Default tenant so the system works out of the box
INSERT INTO tenants (slug, name)
VALUES ('default', 'Default Tenant')
ON CONFLICT (slug) DO NOTHING;

-- =============================================================================
-- TABLE 2: projects
-- =============================================================================

CREATE TABLE IF NOT EXISTS projects (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                      TEXT NOT NULL,
  slug                      TEXT NOT NULL,
  description               TEXT NOT NULL DEFAULT '',
  -- GitHub full repo name, e.g. "my-org/my-repo" (case-sensitive)
  repo_full_name            TEXT UNIQUE,
  -- LangGraph Cloud assistant UUID
  langgraph_assistant_id    TEXT,
  -- GitHub App installation ID (for scoped auth)
  installation_id           TEXT,
  -- Template used to initialise this project
  template_id               TEXT NOT NULL DEFAULT 'custom',
  -- Status: creating | ready | paused | archived | failed
  status                    TEXT NOT NULL DEFAULT 'creating',
  github_repo_url           TEXT,
  metadata                  JSONB NOT NULL DEFAULT '{}',
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_projects_tenant_id ON projects(tenant_id);
CREATE INDEX IF NOT EXISTS idx_projects_repo_full_name ON projects(repo_full_name);
CREATE INDEX IF NOT EXISTS idx_projects_langgraph_assistant_id ON projects(langgraph_assistant_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

-- =============================================================================
-- TABLE 3: agent_memory
-- =============================================================================

CREATE TABLE IF NOT EXISTS agent_memory (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id         TEXT NOT NULL,
  namespace        TEXT NOT NULL DEFAULT 'general',
  key              TEXT NOT NULL,
  content          TEXT NOT NULL DEFAULT '',
  -- memory_type: fact | lesson | reflection | preference | general | procedural
  memory_type      TEXT NOT NULL DEFAULT 'general',
  -- source: system | user | inference | reflection | background
  source           TEXT NOT NULL DEFAULT 'system',
  confidence       FLOAT NOT NULL DEFAULT 1.0,
  importance_score FLOAT NOT NULL DEFAULT 0.5,
  recall_count     INT NOT NULL DEFAULT 0,
  last_recalled_at TIMESTAMPTZ,
  ttl_expires_at   TIMESTAMPTZ,
  metadata         JSONB NOT NULL DEFAULT '{}',
  -- Vector embedding for semantic search (text-embedding-3-small = 1536 dims)
  embedding        VECTOR(1536),
  version          INT NOT NULL DEFAULT 1,
  superseded_by    UUID REFERENCES agent_memory(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent_id, namespace, key)
);

CREATE INDEX IF NOT EXISTS idx_agent_memory_agent_id ON agent_memory(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_memory_tenant_id ON agent_memory(tenant_id);
CREATE INDEX IF NOT EXISTS idx_agent_memory_namespace ON agent_memory(namespace);
CREATE INDEX IF NOT EXISTS idx_agent_memory_memory_type ON agent_memory(memory_type);
CREATE INDEX IF NOT EXISTS idx_agent_memory_importance_score ON agent_memory(importance_score);
CREATE INDEX IF NOT EXISTS idx_agent_memory_ttl ON agent_memory(ttl_expires_at) WHERE ttl_expires_at IS NOT NULL;

-- IVFFlat index for approximate nearest-neighbor vector search
-- Replace with HNSW for better recall if your Supabase plan supports it
CREATE INDEX IF NOT EXISTS idx_agent_memory_embedding
  ON agent_memory USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- =============================================================================
-- TABLE 4: tool_registry
-- =============================================================================

CREATE TABLE IF NOT EXISTS tool_registry (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID REFERENCES tenants(id) ON DELETE CASCADE,
  tool_name   TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT 'general',
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  -- JSON schema for the tool's parameters
  schema_json JSONB NOT NULL DEFAULT '{}',
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, tool_name)
);

CREATE INDEX IF NOT EXISTS idx_tool_registry_tenant_id ON tool_registry(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tool_registry_category ON tool_registry(category);
CREATE INDEX IF NOT EXISTS idx_tool_registry_enabled ON tool_registry(enabled);

-- =============================================================================
-- TABLE 5: system_state
-- =============================================================================

CREATE TABLE IF NOT EXISTS system_state (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID REFERENCES tenants(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      JSONB NOT NULL DEFAULT '{}',
  category   TEXT NOT NULL DEFAULT 'general',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, key)
);

CREATE INDEX IF NOT EXISTS idx_system_state_tenant_id ON system_state(tenant_id);
CREATE INDEX IF NOT EXISTS idx_system_state_category ON system_state(category);

-- =============================================================================
-- TABLE 6: shared_contexts
-- =============================================================================
-- Stores shared knowledge, SOPs, team conventions, and other reference
-- content that agents can look up at runtime.

CREATE TABLE IF NOT EXISTS shared_contexts (
  context_key TEXT NOT NULL,
  tenant_id   UUID REFERENCES tenants(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- scope: tenant (visible to one tenant) | global (visible to all)
  scope       TEXT NOT NULL DEFAULT 'tenant',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (context_key, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_shared_contexts_tenant_id ON shared_contexts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_shared_contexts_scope ON shared_contexts(scope);

-- =============================================================================
-- RLS (Row-Level Security) — enable and configure for all tables
-- =============================================================================

ALTER TABLE tenants         ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects        ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_memory    ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_registry   ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_state    ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_contexts ENABLE ROW LEVEL SECURITY;

-- Service role bypass: the service_role key (used by backend tasks) can read/write everything.
-- Add user-scoped policies if you expose data directly to end users via the anon/authenticated key.

CREATE POLICY "service_role_all_tenants"
  ON tenants FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_projects"
  ON projects FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_agent_memory"
  ON agent_memory FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_tool_registry"
  ON tool_registry FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_system_state"
  ON system_state FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_shared_contexts"
  ON shared_contexts FOR ALL TO service_role USING (true) WITH CHECK (true);

-- =============================================================================
-- RPC: memory_write_versioned
-- =============================================================================
-- Upserts a memory row, bumping the version counter each time.
-- On update: marks the old row as superseded_by the new one.
-- Returns the new row's UUID.

CREATE OR REPLACE FUNCTION memory_write_versioned(
  p_agent_id         TEXT,
  p_tenant_id        UUID,
  p_namespace        TEXT,
  p_key              TEXT,
  p_content          TEXT,
  p_memory_type      TEXT   DEFAULT 'general',
  p_source           TEXT   DEFAULT 'system',
  p_confidence       FLOAT  DEFAULT 1.0,
  p_importance_score FLOAT  DEFAULT 0.5,
  p_metadata         JSONB  DEFAULT '{}',
  p_ttl_expires_at   TIMESTAMPTZ DEFAULT NULL,
  p_embedding        VECTOR(1536) DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_existing_id UUID;
  v_existing_version INT;
  v_new_id UUID;
BEGIN
  -- Check if a row already exists for this (agent_id, namespace, key)
  SELECT id, version
  INTO v_existing_id, v_existing_version
  FROM agent_memory
  WHERE agent_id = p_agent_id
    AND namespace = p_namespace
    AND key       = p_key;

  IF v_existing_id IS NOT NULL THEN
    -- Create the new version row
    INSERT INTO agent_memory (
      tenant_id, agent_id, namespace, key,
      content, memory_type, source, confidence,
      importance_score, metadata, ttl_expires_at,
      embedding, version, created_at, updated_at
    ) VALUES (
      p_tenant_id, p_agent_id, p_namespace,
      p_key || ':v' || (v_existing_version + 1),  -- temporary key to avoid unique conflict
      p_content, p_memory_type, p_source, p_confidence,
      p_importance_score, p_metadata, p_ttl_expires_at,
      p_embedding, v_existing_version + 1, NOW(), NOW()
    )
    RETURNING id INTO v_new_id;

    -- Mark old row as superseded
    UPDATE agent_memory
    SET superseded_by = v_new_id,
        updated_at    = NOW()
    WHERE id = v_existing_id;

    -- Swap the key so the new row gets the canonical key
    UPDATE agent_memory SET key = p_key, updated_at = NOW()
    WHERE id = v_new_id;

    -- Remove the canonical key from the superseded row so no unique conflict
    UPDATE agent_memory
    SET key        = p_key || ':superseded:' || v_existing_id::TEXT,
        updated_at = NOW()
    WHERE id = v_existing_id;

  ELSE
    -- First write — plain insert
    INSERT INTO agent_memory (
      tenant_id, agent_id, namespace, key,
      content, memory_type, source, confidence,
      importance_score, metadata, ttl_expires_at,
      embedding, version, created_at, updated_at
    ) VALUES (
      p_tenant_id, p_agent_id, p_namespace, p_key,
      p_content, p_memory_type, p_source, p_confidence,
      p_importance_score, p_metadata, p_ttl_expires_at,
      p_embedding, 1, NOW(), NOW()
    )
    RETURNING id INTO v_new_id;
  END IF;

  RETURN v_new_id;
END;
$$;

GRANT EXECUTE ON FUNCTION memory_write_versioned TO service_role;

-- =============================================================================
-- RPC: memory_search_semantic
-- =============================================================================
-- Returns agent_memory rows ordered by cosine similarity to a query embedding.

CREATE OR REPLACE FUNCTION memory_search_semantic(
  p_embedding       VECTOR(1536),
  p_agent_id        TEXT          DEFAULT NULL,
  p_tenant_id       UUID          DEFAULT NULL,
  p_namespace       TEXT          DEFAULT NULL,
  p_memory_type     TEXT          DEFAULT NULL,
  p_min_similarity  FLOAT         DEFAULT 0.3,
  p_limit           INT           DEFAULT 10
)
RETURNS TABLE (
  id               UUID,
  agent_id         TEXT,
  namespace        TEXT,
  key              TEXT,
  content          TEXT,
  memory_type      TEXT,
  source           TEXT,
  confidence       FLOAT,
  importance_score FLOAT,
  metadata         JSONB,
  similarity       FLOAT,
  created_at       TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.agent_id,
    m.namespace,
    m.key,
    m.content,
    m.memory_type,
    m.source,
    m.confidence,
    m.importance_score,
    m.metadata,
    (1 - (m.embedding <=> p_embedding))::FLOAT AS similarity,
    m.created_at,
    m.updated_at
  FROM agent_memory m
  WHERE
    m.superseded_by IS NULL                          -- only live rows
    AND (p_agent_id    IS NULL OR m.agent_id   = p_agent_id)
    AND (p_tenant_id   IS NULL OR m.tenant_id  = p_tenant_id)
    AND (p_namespace   IS NULL OR m.namespace  = p_namespace)
    AND (p_memory_type IS NULL OR m.memory_type = p_memory_type)
    AND m.embedding IS NOT NULL
    AND (1 - (m.embedding <=> p_embedding)) >= p_min_similarity
    AND (m.ttl_expires_at IS NULL OR m.ttl_expires_at > NOW())
  ORDER BY m.embedding <=> p_embedding
  LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION memory_search_semantic TO service_role;

-- =============================================================================
-- Helpful view: active_projects
-- =============================================================================

CREATE OR REPLACE VIEW active_projects AS
SELECT
  p.id,
  p.tenant_id,
  t.slug  AS tenant_slug,
  t.name  AS tenant_name,
  p.name,
  p.slug,
  p.repo_full_name,
  p.langgraph_assistant_id,
  p.installation_id,
  p.template_id,
  p.status,
  p.github_repo_url,
  p.metadata,
  p.created_at,
  p.updated_at
FROM projects p
JOIN tenants t ON t.id = p.tenant_id
WHERE p.status = 'ready';

-- =============================================================================
-- Done!
-- =============================================================================
-- Tables  : tenants, projects, agent_memory, tool_registry, system_state, shared_contexts
-- Indexes : 15+ covering foreign keys, frequent filter columns, vector search
-- RLS     : enabled on all tables with service_role bypass policies
-- RPCs    : memory_write_versioned, memory_search_semantic
-- Views   : active_projects
-- =============================================================================
