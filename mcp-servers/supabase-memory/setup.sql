-- Memory System
-- Run this in the Supabase SQL editor to set up the memories table.
-- Safe to re-run: uses IF NOT EXISTS / OR REPLACE throughout.

-- Enable pgvector if not already enabled
CREATE EXTENSION IF NOT EXISTS vector;

-- Main memories table
CREATE TABLE IF NOT EXISTS memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content text NOT NULL,
  embedding vector(1536),
  memory_type text NOT NULL CHECK (memory_type IN (
    'fact', 'decision', 'event', 'preference', 'correction',
    'conversation', 'pattern', 'learning', 'transcript'
  )),
  project text,                          -- team/project tag, null = global
  tags text[] DEFAULT '{}',
  importance smallint DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
  source text,                           -- where it came from (discord, session, manual)
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  expires_at timestamptz,                -- auto-expire temporary memories
  superseded_by uuid REFERENCES memories(id),
  metadata jsonb DEFAULT '{}',
  active boolean DEFAULT true
);

-- Indexes for fast retrieval
CREATE INDEX IF NOT EXISTS idx_memories_embedding
  ON memories USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_memories_project ON memories (project);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories (memory_type);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_active ON memories (active) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories (importance DESC);

-- Auto-update updated_at on changes
CREATE OR REPLACE FUNCTION update_memories_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS memories_updated_at ON memories;
CREATE TRIGGER memories_updated_at
  BEFORE UPDATE ON memories
  FOR EACH ROW
  EXECUTE FUNCTION update_memories_updated_at();

-- Semantic search across all memories (or filtered)
CREATE OR REPLACE FUNCTION search_memories(
  query_embedding vector(1536),
  match_count int DEFAULT 10,
  filter_project text DEFAULT NULL,
  filter_types text[] DEFAULT NULL,
  min_importance smallint DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  content text,
  memory_type text,
  project text,
  tags text[],
  importance smallint,
  source text,
  created_at timestamptz,
  metadata jsonb,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.content,
    m.memory_type,
    m.project,
    m.tags,
    m.importance,
    m.source,
    m.created_at,
    m.metadata,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM memories m
  WHERE m.active = true
    AND (filter_project IS NULL OR m.project = filter_project)
    AND (filter_types IS NULL OR m.memory_type = ANY(filter_types))
    AND m.importance >= min_importance
    AND (m.expires_at IS NULL OR m.expires_at > now())
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Timeline: recent entries for a project or globally
CREATE OR REPLACE FUNCTION memory_timeline(
  filter_project text DEFAULT NULL,
  entry_limit int DEFAULT 20,
  filter_types text[] DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  content text,
  memory_type text,
  project text,
  tags text[],
  importance smallint,
  source text,
  created_at timestamptz,
  metadata jsonb
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.content,
    m.memory_type,
    m.project,
    m.tags,
    m.importance,
    m.source,
    m.created_at,
    m.metadata
  FROM memories m
  WHERE m.active = true
    AND (filter_project IS NULL OR m.project = filter_project)
    AND (filter_types IS NULL OR m.memory_type = ANY(filter_types))
    AND (m.expires_at IS NULL OR m.expires_at > now())
  ORDER BY m.created_at DESC
  LIMIT entry_limit;
END;
$$;

-- Find near-duplicates (for dedup before storing)
CREATE OR REPLACE FUNCTION find_similar_memory(
  query_embedding vector(1536),
  similarity_threshold float DEFAULT 0.95,
  filter_project text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  content text,
  memory_type text,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.content,
    m.memory_type,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM memories m
  WHERE m.active = true
    AND 1 - (m.embedding <=> query_embedding) >= similarity_threshold
    AND (filter_project IS NULL OR m.project = filter_project)
  ORDER BY m.embedding <=> query_embedding
  LIMIT 1;
END;
$$;
