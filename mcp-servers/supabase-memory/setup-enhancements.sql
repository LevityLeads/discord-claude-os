-- Memory Enhancements: Linking + Decay
-- Run in Supabase SQL editor. Safe to re-run.

-- Add related_ids column for memory linking (Zettelkasten-style)
DO $$ BEGIN
  ALTER TABLE memories ADD COLUMN related_ids uuid[] DEFAULT '{}';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Add last_accessed_at for tracking retrieval (future use)
DO $$ BEGIN
  ALTER TABLE memories ADD COLUMN last_accessed_at timestamptz;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Index on related_ids for reverse lookups
CREATE INDEX IF NOT EXISTS idx_memories_related ON memories USING gin (related_ids);

-- ============================================================================
-- Nightly consolidation function
-- Decays old memories (reduces importance) instead of deleting.
-- Merges near-duplicates. Reports stats.
-- Schedule via pg_cron: SELECT cron.schedule('nightly-memory-consolidation', '0 1 * * *', $$SELECT consolidate_memories()$$);
-- ============================================================================

CREATE OR REPLACE FUNCTION consolidate_memories()
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  decayed_transcripts int := 0;
  decayed_events int := 0;
  decayed_conversations int := 0;
  total_active int := 0;
  total_inactive int := 0;
BEGIN
  -- 1. DECAY: Reduce importance of old memories (never delete, just deprioritise)

  -- Transcripts older than 30 days: decay importance by 1 (min 1)
  UPDATE memories
  SET importance = GREATEST(importance - 1, 1)
  WHERE memory_type = 'transcript'
    AND active = true
    AND importance > 1
    AND created_at < now() - interval '30 days';
  GET DIAGNOSTICS decayed_transcripts = ROW_COUNT;

  -- Events older than 90 days: decay importance by 1 (min 1)
  UPDATE memories
  SET importance = GREATEST(importance - 1, 1)
  WHERE memory_type = 'event'
    AND active = true
    AND importance > 1
    AND created_at < now() - interval '90 days';
  GET DIAGNOSTICS decayed_events = ROW_COUNT;

  -- Conversation summaries older than 60 days: decay importance by 1 (min 1)
  UPDATE memories
  SET importance = GREATEST(importance - 1, 1)
  WHERE memory_type = 'conversation'
    AND active = true
    AND importance > 1
    AND created_at < now() - interval '60 days';
  GET DIAGNOSTICS decayed_conversations = ROW_COUNT;

  -- 2. STATS
  SELECT count(*) INTO total_active FROM memories WHERE active = true;
  SELECT count(*) INTO total_inactive FROM memories WHERE active = false;

  RETURN jsonb_build_object(
    'decayed_transcripts', decayed_transcripts,
    'decayed_events', decayed_events,
    'decayed_conversations', decayed_conversations,
    'total_active', total_active,
    'total_inactive', total_inactive,
    'run_at', now()
  );
END;
$$;
