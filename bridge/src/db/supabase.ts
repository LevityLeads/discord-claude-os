import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Supabase client for ki_* tables (separate from SQLite database.ts)
// ---------------------------------------------------------------------------

let supabase: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
  if (supabase) return supabase;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.warn("[supabase-db] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set");
    return null;
  }

  supabase = createClient(url, key);
  return supabase;
}

// ---------------------------------------------------------------------------
// Thread management
// ---------------------------------------------------------------------------

export interface KiThread {
  id: string;
  channel_id: string;
  title: string;
  auto_titled: boolean;
  status: string;
  discord_channel_id: string | null;
  total_tokens: number;
  message_count: number;
  last_activity_at: string;
  created_at: string;
}

/**
 * Find an existing thread by ID. Returns null if not found.
 */
export async function getThread(threadId: string): Promise<KiThread | null> {
  const client = getClient();
  if (!client) return null;

  const { data, error } = await client
    .from("ki_threads")
    .select("*")
    .eq("id", threadId)
    .single();

  if (error || !data) return null;
  return data as KiThread;
}

/**
 * Create a new thread in ki_threads. Returns the thread record.
 */
export async function createThread(params: {
  channelId: string;
  title?: string;
  discordChannelId?: string;
}): Promise<KiThread | null> {
  const client = getClient();
  if (!client) return null;

  const id = randomUUID();
  const now = new Date().toISOString();

  const row = {
    id,
    channel_id: params.channelId,
    title: params.title ?? "New conversation",
    auto_titled: !params.title,
    status: "active",
    discord_channel_id: params.discordChannelId ?? null,
    total_tokens: 0,
    message_count: 0,
    last_activity_at: now,
    created_at: now,
  };

  const { data, error } = await client
    .from("ki_threads")
    .insert(row)
    .select()
    .single();

  if (error) {
    console.warn(`[supabase-db] Failed to create thread: ${error.message}`);
    return null;
  }

  return data as KiThread;
}

/**
 * Update thread's last_activity_at timestamp.
 * Message count is derived from ki_messages rows (SELECT COUNT) when needed,
 * so we no longer maintain a racy counter here.
 */
export async function touchThread(threadId: string): Promise<void> {
  const client = getClient();
  if (!client) return;

  const { error } = await client
    .from("ki_threads")
    .update({ last_activity_at: new Date().toISOString() })
    .eq("id", threadId);

  if (error) {
    console.warn(`[supabase-db] Failed to touch thread: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Message management
// ---------------------------------------------------------------------------

export interface KiMessage {
  id: string;
  thread_id: string;
  session_id: string | null;
  role: string;
  content: string;
  agent_role: string | null;
  has_attachments: boolean;
  created_at: string;
}

/**
 * Write a message to ki_messages.
 */
export async function writeMessage(params: {
  threadId: string;
  sessionId?: string | null;
  role: "human" | "assistant";
  content: string;
  agentRole?: string | null;
}): Promise<KiMessage | null> {
  const client = getClient();
  if (!client) return null;

  const row = {
    id: randomUUID(),
    thread_id: params.threadId,
    session_id: params.sessionId ?? null,
    role: params.role,
    content: params.content,
    agent_role: params.agentRole ?? null,
    has_attachments: false,
    created_at: new Date().toISOString(),
  };

  const { data, error } = await client
    .from("ki_messages")
    .insert(row)
    .select()
    .single();

  if (error) {
    console.warn(`[supabase-db] Failed to write message: ${error.message}`);
    return null;
  }

  return data as KiMessage;
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

export interface KiSession {
  id: string;
  thread_id: string;
  sdk_session_id: string | null;
  status: string;
  agents: unknown;
  total_cost_usd: number;
  duration_ms: number;
  started_at: string;
  ended_at: string | null;
  last_heartbeat: string;
}

/**
 * Create a new session in ki_sessions.
 */
export async function createSession(params: {
  threadId: string;
  sdkSessionId?: string | null;
}): Promise<KiSession | null> {
  const client = getClient();
  if (!client) return null;

  const now = new Date().toISOString();
  const row = {
    id: randomUUID(),
    thread_id: params.threadId,
    sdk_session_id: params.sdkSessionId ?? null,
    status: "running",
    agents: null,
    total_cost_usd: 0,
    duration_ms: 0,
    started_at: now,
    ended_at: null,
    last_heartbeat: now,
  };

  const { data, error } = await client
    .from("ki_sessions")
    .insert(row)
    .select()
    .single();

  if (error) {
    console.warn(`[supabase-db] Failed to create session: ${error.message}`);
    return null;
  }

  return data as KiSession;
}

/**
 * Update a session's status and optionally set end time + cost.
 */
export async function updateSession(
  sessionId: string,
  updates: {
    status?: string;
    sdkSessionId?: string;
    totalCostUsd?: number;
    durationMs?: number;
    ended?: boolean;
  },
): Promise<void> {
  const client = getClient();
  if (!client) return;

  const row: Record<string, unknown> = {
    last_heartbeat: new Date().toISOString(),
  };

  if (updates.status) row.status = updates.status;
  if (updates.sdkSessionId) row.sdk_session_id = updates.sdkSessionId;
  if (updates.totalCostUsd !== undefined) row.total_cost_usd = updates.totalCostUsd;
  if (updates.durationMs !== undefined) row.duration_ms = updates.durationMs;
  if (updates.ended) row.ended_at = new Date().toISOString();

  const { error } = await client
    .from("ki_sessions")
    .update(row)
    .eq("id", sessionId);

  if (error) {
    console.warn(`[supabase-db] Failed to update session: ${error.message}`);
  }
}

/**
 * Get the latest active session for a thread.
 */
export async function getActiveSession(threadId: string): Promise<KiSession | null> {
  const client = getClient();
  if (!client) return null;

  const { data, error } = await client
    .from("ki_sessions")
    .select("*")
    .eq("thread_id", threadId)
    .eq("status", "running")
    .order("started_at", { ascending: false })
    .limit(1)
    .single();

  if (error || !data) return null;
  return data as KiSession;
}

/**
 * Find a channel by slug or ID.
 */
export async function getChannel(channelIdOrSlug: string): Promise<{ id: string; slug: string; name: string; project_path: string } | null> {
  const client = getClient();
  if (!client) return null;

  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(channelIdOrSlug);

  // Query by UUID id or by slug (not both, to avoid Postgres type error)
  const col = isUUID ? "id" : "slug";
  const { data, error } = await client
    .from("ki_channels")
    .select("id, slug, name, project_path")
    .eq(col, channelIdOrSlug)
    .limit(1)
    .single();

  if (error || !data) return null;
  return data;
}
