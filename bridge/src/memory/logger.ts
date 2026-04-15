import { createClient } from "@supabase/supabase-js";


// ---------------------------------------------------------------------------
// Supabase client (lazy init)
// ---------------------------------------------------------------------------

let supabase: ReturnType<typeof createClient> | null = null;
let envChecked = false;

function getClient() {
  if (supabase) return supabase;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    if (!envChecked) {
      console.warn("[memory] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set, transcript logging disabled");
      console.warn(`[memory] SUPABASE_URL=${url ? "set" : "missing"}, KEY=${key ? "set" : "missing"}`);
      envChecked = true;
    }
    return null;
  }

  console.log("[memory] Supabase client initialized for transcript logging");
  supabase = createClient(url, key);
  envChecked = true;
  return supabase;
}

// ---------------------------------------------------------------------------
// Embedding helper
// ---------------------------------------------------------------------------

async function embed(text: string): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn("[memory] OPENAI_API_KEY not set, skipping embedding");
    return null;
  }

  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: text.slice(0, 8000),
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn(`[memory] Embedding failed (${res.status}): ${errText.slice(0, 200)}`);
      return null;
    }

    const data = await res.json();
    return data.data[0].embedding;
  } catch (err) {
    console.warn("[memory] Embedding error:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Extract project name from path
// ---------------------------------------------------------------------------

function projectFromPath(projectPath: string): string {
  const parts = projectPath.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "unknown";
}

// ---------------------------------------------------------------------------
// Per-channel transcript buffer with idle timeout
//
// Exchanges accumulate during a conversation. After 5 minutes of no new
// exchanges, the buffer flushes to Supabase as one transcript row.
// This naturally groups conversations without relying on queue state.
// ---------------------------------------------------------------------------

const FLUSH_IDLE_MS = 10 * 60 * 1000; // 10 minutes

interface Exchange {
  user: string;
  assistant: string;
}

interface TranscriptBuffer {
  project: string;
  channelId: string;
  sessionId: string | null;
  exchanges: Exchange[];
}

const buffers = new Map<string, TranscriptBuffer>();
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Add an exchange to the buffer for a channel.
 * Resets the 5-minute idle flush timer.
 */
export function bufferTranscript(params: {
  userMessage: string;
  assistantResponse: string;
  projectPath: string;
  channelId: string;
  sessionId?: string | null;
}): void {
  const project = projectFromPath(params.projectPath);
  let buffer = buffers.get(params.channelId);

  if (!buffer) {
    buffer = { project, channelId: params.channelId, sessionId: null, exchanges: [] };
    buffers.set(params.channelId, buffer);
  }

  buffer.sessionId = params.sessionId ?? buffer.sessionId;
  buffer.exchanges.push({
    user: params.userMessage,
    assistant: params.assistantResponse,
  });

  console.log(`[memory] Buffered exchange #${buffer.exchanges.length} for ${project}`);

  // Reset idle flush timer
  const existingTimer = flushTimers.get(params.channelId);
  if (existingTimer) clearTimeout(existingTimer);

  const channelId = params.channelId;
  flushTimers.set(
    channelId,
    setTimeout(() => {
      flushTimers.delete(channelId);
      console.log(`[memory] Idle timeout reached for ${channelId}, flushing`);
      flushTranscript(channelId).catch((err) => {
        console.warn("[memory] Idle flush error:", err instanceof Error ? err.message : err);
      });
    }, FLUSH_IDLE_MS),
  );
}

/**
 * Flush the transcript buffer for a channel to Supabase.
 * Combines all buffered exchanges into one transcript row.
 */
export async function flushTranscript(channelId: string): Promise<void> {
  const buffer = buffers.get(channelId);
  if (!buffer || buffer.exchanges.length === 0) return;

  // Take and clear immediately to prevent double-flush
  const { project, exchanges, sessionId } = buffer;
  buffers.delete(channelId);

  // Clear any pending timer
  const timer = flushTimers.get(channelId);
  if (timer) {
    clearTimeout(timer);
    flushTimers.delete(channelId);
  }

  try {
    const client = getClient();
    if (!client) return;

    const content =
      exchanges.length === 1
        ? `User: ${exchanges[0].user}\n\nAssistant: ${exchanges[0].assistant}`
        : exchanges
            .map((ex, i) => `[${i + 1}] User: ${ex.user}\n\nAssistant: ${ex.assistant}`)
            .join("\n\n---\n\n");

    console.log(
      `[memory] Flushing transcript: ${exchanges.length} exchange(s), ${content.length} chars, project=${project}`,
    );

    const embedding = await embed(content);

    // Cast to any: the Supabase client is created without a generated Database
    // type, so insert payloads are inferred as never. Runtime is fine.
    const { error } = await (client.from("memories") as unknown as {
      insert: (row: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
    }).insert({
      content,
      embedding: embedding ? JSON.stringify(embedding) : null,
      memory_type: "transcript",
      project,
      importance: 1,
      source: `discord:${channelId}`,
      metadata: {
        channel_id: channelId,
        session_id: sessionId,
        exchange_count: exchanges.length,
      },
    });

    if (error) {
      console.warn(`[memory] Supabase insert failed: ${error.message}`);
    } else {
      console.log(`[memory] Transcript stored: ${exchanges.length} exchange(s) for ${project}`);
    }
  } catch (err) {
    console.warn("[memory] Failed to flush transcript:", err instanceof Error ? err.message : err);
  }
}

/**
 * Flush ALL buffers. Called on process shutdown to avoid losing data.
 */
export async function flushAll(): Promise<void> {
  const channelIds = [...buffers.keys()];
  if (channelIds.length === 0) return;

  console.log(`[memory] Shutting down, flushing ${channelIds.length} transcript buffer(s)`);
  await Promise.allSettled(channelIds.map((id) => flushTranscript(id)));
}
