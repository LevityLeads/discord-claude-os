import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Event types for the Bot Interface
// ---------------------------------------------------------------------------

export type BridgeEvent =
  | { type: "session_start"; sessionId: string; threadId: string }
  | { type: "session_end"; sessionId: string; totalCostUsd: number; durationMs: number }
  | { type: "text_chunk"; sessionId: string; content: string }
  | { type: "text_complete"; sessionId: string; fullContent: string }
  | { type: "tool_call_start"; sessionId: string; toolName: string; input: Record<string, unknown>; agentRole?: string }
  | { type: "tool_call_end"; sessionId: string; toolName: string; durationMs: number; error?: string }
  | { type: "approval_request"; sessionId: string; requestId: string; toolName: string; input: Record<string, unknown> }
  | { type: "session_blocked"; sessionId: string; reason: string };

// ---------------------------------------------------------------------------
// Broadcaster -- sends events via Supabase Realtime + persists to ki_tool_events
// ---------------------------------------------------------------------------

/** Check if a string is a valid UUID (v4). Discord snowflake IDs will fail this. */
const isUUID = (id: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

let supabase: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
  if (supabase) return supabase;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.warn("[broadcaster] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set, broadcasting disabled");
    return null;
  }

  supabase = createClient(url, key);
  console.log("[broadcaster] Supabase client initialized");
  return supabase;
}

// Channel cache: reuse Realtime channels across events for the same thread.
// Without this, every single event (hundreds during a streaming response) would
// create and immediately destroy a channel, hammering Supabase Realtime.
const channelCache = new Map<string, ReturnType<SupabaseClient["channel"]>>();

function getOrCreateChannel(client: SupabaseClient, threadId: string): ReturnType<SupabaseClient["channel"]> {
  const key = `thread:${threadId}`;
  let ch = channelCache.get(key);
  if (!ch) {
    ch = client.channel(key);
    channelCache.set(key, ch);
  }
  return ch;
}

/**
 * Clean up a cached Realtime channel when a session ends.
 * Call this when broadcasting `session_end` to free resources.
 */
export function cleanupChannel(threadId: string): void {
  const client = getClient();
  const key = `thread:${threadId}`;
  const ch = channelCache.get(key);
  if (ch && client) {
    client.removeChannel(ch);
    channelCache.delete(key);
  }
}

/**
 * Broadcast an event to Supabase Realtime and persist to ki_tool_events.
 *
 * Realtime channel: `thread:{threadId}`
 * Persistence: ki_tool_events table (for tool_call_start, tool_call_end, approval_request)
 * All events are broadcast; only tool-related ones are persisted to the table.
 */
export async function broadcast(threadId: string, event: BridgeEvent): Promise<void> {
  const client = getClient();
  if (!client) return;

  // Discord sessions use snowflake IDs (not UUIDs). Skip all Supabase operations
  // for these -- Realtime broadcast logs noisy deprecation warnings and the DB insert
  // fails on the UUID column constraint. Only HTTP-originated sessions (UUID thread IDs)
  // get Realtime + persistence.
  if (!isUUID(threadId)) return;

  const timestamp = new Date().toISOString();

  // Broadcast via Supabase Realtime (cached channel)
  try {
    const channel = getOrCreateChannel(client, threadId);
    await channel.send({
      type: "broadcast",
      event: event.type,
      payload: { ...event, timestamp },
    });
    // Clean up channel when session ends (no more events expected)
    if (event.type === "session_end") {
      cleanupChannel(threadId);
    }
  } catch (err) {
    console.warn(
      `[broadcaster] Realtime broadcast failed for thread ${threadId}:`,
      err instanceof Error ? err.message : err,
    );
  }

  // Persist tool events to ki_tool_events for history/replay.
  if (
    (event.type === "tool_call_start" ||
     event.type === "tool_call_end" ||
     event.type === "approval_request")
  ) {
    try {
      const row: Record<string, unknown> = {
        thread_id: threadId,
        session_id: event.sessionId,
        event_type: event.type,
        created_at: timestamp,
      };

      if (event.type === "tool_call_start") {
        row.tool_name = event.toolName;
        row.tool_input = event.input;
        row.agent_role = event.agentRole ?? null;
      } else if (event.type === "tool_call_end") {
        row.tool_name = event.toolName;
        row.duration_ms = event.durationMs;
        row.error = event.error ?? null;
      } else if (event.type === "approval_request") {
        row.tool_name = event.toolName;
        row.tool_input = event.input;
        row.event_type = "approval_request";
      }

      const { error } = await client.from("ki_tool_events").insert(row);
      if (error) {
        console.warn(`[broadcaster] ki_tool_events insert failed: ${error.message}`);
      }
    } catch (err) {
      console.warn(
        `[broadcaster] Failed to persist tool event:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/**
 * Initialize the broadcaster. Call once at startup to verify connectivity.
 */
export function initBroadcaster(): boolean {
  const client = getClient();
  return client !== null;
}
