import { createClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Supabase client (lazy init, mirrors logger.ts pattern)
// ---------------------------------------------------------------------------

let supabase: ReturnType<typeof createClient> | null = null;
let envChecked = false;

function getClient() {
  if (supabase) return supabase;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    if (!envChecked) {
      console.warn("[checkpoint] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set, checkpointing disabled");
      envChecked = true;
    }
    return null;
  }

  supabase = createClient(url, key);
  envChecked = true;
  return supabase;
}

// ---------------------------------------------------------------------------
// Embedding helper (same as logger.ts)
// ---------------------------------------------------------------------------

async function embed(text: string): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

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

    if (!res.ok) return null;
    const data = await res.json();
    return data.data[0].embedding;
  } catch {
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
// saveCheckpoint -- fire-and-forget before context compaction
// ---------------------------------------------------------------------------

export interface CheckpointParams {
  channelId: string;
  prompt: string;
  fullResponse: string;
  toolUseCount: number;
  projectPath: string;
  compactionCount: number;
  sessionId: string | null;
}

export async function saveCheckpoint(params: CheckpointParams): Promise<void> {
  const client = getClient();
  if (!client) return;

  const project = projectFromPath(params.projectPath);

  // Build a concise checkpoint summary (under 2000 chars)
  const promptSnippet = params.prompt.slice(0, 400);
  const responseSnippet = params.fullResponse.slice(-600).trim();
  const responseLen = params.fullResponse.length;

  const content = [
    `[Auto-checkpoint before compaction #${params.compactionCount + 1}]`,
    "",
    `**Task:** ${promptSnippet}${params.prompt.length > 400 ? "..." : ""}`,
    "",
    `**Progress:** ${params.toolUseCount} tool calls, ${Math.round(responseLen / 1000)}k chars of response`,
    "",
    `**Recent output (tail):**`,
    responseSnippet.length > 0 ? responseSnippet : "(no response text yet)",
  ].join("\n").slice(0, 2000);

  try {
    const embedding = await embed(content);

    const { error } = await (client.from("memories") as unknown as {
      insert: (row: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
    }).insert({
      content,
      embedding: embedding ? JSON.stringify(embedding) : null,
      memory_type: "conversation",
      project,
      importance: 4,
      tags: ["auto-checkpoint", "compaction"],
      source: `discord:${params.channelId}`,
      metadata: {
        channel_id: params.channelId,
        session_id: params.sessionId,
        compaction_number: params.compactionCount + 1,
        tool_use_count: params.toolUseCount,
        response_length: responseLen,
      },
    });

    if (error) {
      console.warn(`[checkpoint] Supabase insert failed: ${error.message}`);
    } else {
      console.log(`[checkpoint] Saved before compaction #${params.compactionCount + 1} for ${project} (${content.length} chars)`);
    }
  } catch (err) {
    console.warn("[checkpoint] Failed:", err instanceof Error ? err.message : err);
  }
}
