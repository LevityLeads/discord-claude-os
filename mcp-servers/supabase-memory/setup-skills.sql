-- Skills Registry
-- Run in Supabase SQL editor. Safe to re-run.

-- Enable pgvector if not already enabled
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,                    -- slug ("competitor-analysis", "cold-email-sequence")
  description text NOT NULL,                    -- what it does and when to use it
  prompt_template text NOT NULL,                -- the actual instructions
  tags text[] DEFAULT '{}',                     -- categories ("marketing", "dev", "research")
  embedding vector(1536),                       -- for semantic discovery
  input_params jsonb DEFAULT '[]',              -- what the skill needs from the user
  examples text[] DEFAULT '{}',                 -- example invocations
  project text,                                 -- team-specific skill, or null for global
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  active boolean DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_skills_embedding
  ON skills USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_skills_tags ON skills USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_skills_active ON skills (active) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_skills_name ON skills (name);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_skills_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS skills_updated_at ON skills;
CREATE TRIGGER skills_updated_at
  BEFORE UPDATE ON skills
  FOR EACH ROW
  EXECUTE FUNCTION update_skills_updated_at();

-- Semantic search for skills
CREATE OR REPLACE FUNCTION search_skills(
  query_embedding vector(1536),
  match_count int DEFAULT 5,
  filter_tags text[] DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  name text,
  description text,
  prompt_template text,
  tags text[],
  input_params jsonb,
  examples text[],
  project text,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.id,
    s.name,
    s.description,
    s.prompt_template,
    s.tags,
    s.input_params,
    s.examples,
    s.project,
    1 - (s.embedding <=> query_embedding) AS similarity
  FROM skills s
  WHERE s.active = true
    AND (filter_tags IS NULL OR s.tags && filter_tags)
  ORDER BY s.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
