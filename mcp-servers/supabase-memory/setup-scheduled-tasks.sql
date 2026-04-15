-- Scheduled Tasks
-- Run this in the Supabase SQL editor after the memories table setup.
-- Safe to re-run: uses IF NOT EXISTS / OR REPLACE throughout.

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,                         -- human-readable name ("daily-briefing")
  cron_expression text NOT NULL,              -- standard 5-field cron ("0 8 * * *")
  timezone text DEFAULT 'UTC',
  channel_id text NOT NULL,                   -- Discord channel ID to send the prompt to
  project text,                               -- team/project tag (for context)
  prompt text NOT NULL,                       -- the prompt to send to Claude
  enabled boolean DEFAULT true,
  last_run_at timestamptz,                    -- when this task last fired
  last_run_status text,                       -- 'success', 'failed', 'skipped'
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  metadata jsonb DEFAULT '{}'                 -- extra config if needed
);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_enabled ON scheduled_tasks (enabled) WHERE enabled = true;

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_scheduled_tasks_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS scheduled_tasks_updated_at ON scheduled_tasks;
CREATE TRIGGER scheduled_tasks_updated_at
  BEFORE UPDATE ON scheduled_tasks
  FOR EACH ROW
  EXECUTE FUNCTION update_scheduled_tasks_updated_at();
