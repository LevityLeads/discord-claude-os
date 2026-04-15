import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EMBEDDING_MODEL = "text-embedding-3-small";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables"
  );
  process.exit(1);
}
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY environment variable");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------------------------------------------------------------------------
// Default importance by memory type
// ---------------------------------------------------------------------------

const DEFAULT_IMPORTANCE = {
  correction: 9,
  preference: 8,
  decision: 7,
  pattern: 7,
  learning: 6,
  fact: 5,
  event: 4,
  conversation: 3,
  transcript: 1,
};

// ---------------------------------------------------------------------------
// Embedding helper
// ---------------------------------------------------------------------------

async function embed(text) {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI embeddings failed (${res.status}): ${err}`);
  }

  const data = await res.json();
  return data.data[0].embedding;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "memory_store",
    description:
      "Store a memory (fact, decision, event, preference, correction, conversation, pattern, learning, or transcript). " +
      "Automatically embeds for semantic search. Deduplicates against existing memories (>95% similarity updates instead of creating). " +
      "When storing a correction, pass the ID of the memory being corrected via `supersedes` to chain them.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The memory content to store",
        },
        memory_type: {
          type: "string",
          enum: [
            "fact",
            "decision",
            "event",
            "preference",
            "correction",
            "conversation",
            "pattern",
            "learning",
            "transcript",
          ],
          description: "Type of memory",
        },
        project: {
          type: "string",
          description:
            "Team/project tag (e.g. 'levity', 'thingiverse', 'general'). Omit for global memories.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags for categorisation",
        },
        importance: {
          type: "number",
          description:
            "1-10 importance scale. Defaults vary by type (correction=9, preference=8, decision=7, fact=5, event=4, conversation=3, transcript=1).",
        },
        source: {
          type: "string",
          description: "Where this memory came from (e.g. 'discord', 'session', 'manual')",
        },
        supersedes: {
          type: "string",
          description:
            "UUID of the memory this corrects/replaces. The old memory will be marked as superseded.",
        },
        metadata: {
          type: "object",
          description: "Any additional structured data to attach",
        },
        expires_at: {
          type: "string",
          description: "ISO 8601 timestamp for when this memory should expire (optional)",
        },
      },
      required: ["content", "memory_type"],
    },
  },
  {
    name: "memory_recall",
    description:
      "Semantic search across all memories. Returns the most relevant memories ranked by similarity. " +
      "Optionally filter by project, memory types, minimum importance, or date range.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language search query",
        },
        limit: {
          type: "number",
          description: "Max results to return (default 10)",
        },
        project: {
          type: "string",
          description: "Filter to a specific project/team",
        },
        types: {
          type: "array",
          items: { type: "string" },
          description:
            "Filter to specific memory types (e.g. ['fact', 'decision'])",
        },
        min_importance: {
          type: "number",
          description: "Minimum importance threshold (1-10)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_timeline",
    description:
      "Get recent memories in chronological order. Great for briefings, catch-ups, and 'what happened lately?' queries. " +
      "Optionally filter by project and/or memory types.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Filter to a specific project/team",
        },
        limit: {
          type: "number",
          description: "Max entries to return (default 20)",
        },
        types: {
          type: "array",
          items: { type: "string" },
          description: "Filter to specific memory types",
        },
      },
      required: [],
    },
  },
  {
    name: "memory_update",
    description:
      "Update an existing memory. Can change content (re-embeds automatically), importance, tags, or deactivate it.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "UUID of the memory to update",
        },
        content: {
          type: "string",
          description: "New content (triggers re-embedding)",
        },
        importance: {
          type: "number",
          description: "New importance value (1-10)",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "New tags (replaces existing)",
        },
        active: {
          type: "boolean",
          description: "Set to false to soft-delete",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "memory_log_conversation",
    description:
      "Log a conversation summary AND extract individual facts from it. " +
      "Stores the summary as a 'conversation' type memory, then stores each extracted fact separately. " +
      "This gives you both narrative recall AND atomic fact retrieval.",
    inputSchema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "Summary of the conversation",
        },
        facts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              memory_type: {
                type: "string",
                enum: [
                  "fact",
                  "decision",
                  "event",
                  "preference",
                  "correction",
                  "pattern",
                  "learning",
                ],
              },
              importance: { type: "number" },
            },
            required: ["content"],
          },
          description:
            "Individual facts/decisions/events extracted from the conversation",
        },
        project: {
          type: "string",
          description: "Which project/team this conversation was about",
        },
        source: {
          type: "string",
          description: "Source channel or session identifier",
        },
      },
      required: ["summary", "project"],
    },
  },
  {
    name: "schedule_create",
    description:
      "Create a scheduled task. The bridge picks these up automatically and fires them on the cron schedule. " +
      "The prompt is sent to the specified Discord channel as if Rees typed it.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Human-readable name (e.g. 'daily-briefing', 'monday-xero-check')",
        },
        cron_expression: {
          type: "string",
          description: "Standard 5-field cron expression (e.g. '0 8 * * *' for 8am daily, '0 9 * * 1' for Monday 9am). Timezone defaults to UTC.",
        },
        channel_id: {
          type: "string",
          description: "Discord channel ID where the prompt will be sent",
        },
        project: {
          type: "string",
          description: "Team/project tag (e.g. 'levity', 'general')",
        },
        prompt: {
          type: "string",
          description: "The prompt to send to Claude when the schedule fires",
        },
        timezone: {
          type: "string",
          description: "IANA timezone (default: UTC)",
        },
        run_once: {
          type: "boolean",
          description: "If true, task auto-disables after first execution. Use for reminders and one-time tasks.",
        },
      },
      required: ["name", "cron_expression", "channel_id", "prompt"],
    },
  },
  {
    name: "schedule_list",
    description: "List all scheduled tasks, showing name, cron, channel, status, and last run time.",
    inputSchema: {
      type: "object",
      properties: {
        enabled_only: {
          type: "boolean",
          description: "Only show enabled tasks (default: true)",
        },
      },
      required: [],
    },
  },
  {
    name: "schedule_delete",
    description: "Delete or disable a scheduled task by ID or name.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "UUID of the task to delete",
        },
        name: {
          type: "string",
          description: "Name of the task to delete (alternative to ID)",
        },
        hard_delete: {
          type: "boolean",
          description: "If true, permanently deletes. If false (default), just disables.",
        },
      },
      required: [],
    },
  },
  {
    name: "skill_search",
    description:
      "Search for relevant skills by describing what you need to do. Returns matching skills ranked by relevance. " +
      "Use this before starting complex tasks to find proven workflows and methodologies.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language description of what you need (e.g. 'build a landing page', 'write a cold email sequence')",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tag filter (e.g. ['marketing', 'dev'])",
        },
        limit: {
          type: "number",
          description: "Max results (default 5)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "skill_get",
    description: "Retrieve a specific skill by name. Returns full prompt template and instructions.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Skill name (slug format, e.g. 'competitor-analysis')",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "skill_create",
    description:
      "Save a reusable workflow as a skill. Include a clear description (for discovery), " +
      "detailed prompt template (the instructions), and tags for categorisation.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Skill name in slug format (e.g. 'competitor-analysis', 'cold-email-sequence')",
        },
        description: {
          type: "string",
          description: "What this skill does and when to use it (used for semantic discovery)",
        },
        prompt_template: {
          type: "string",
          description: "The full instructions/methodology. This is what Claude follows when the skill is invoked.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Category tags (e.g. ['marketing', 'outreach'])",
        },
        input_params: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              description: { type: "string" },
              required: { type: "boolean" },
            },
          },
          description: "What inputs the skill needs from the user",
        },
        examples: {
          type: "array",
          items: { type: "string" },
          description: "Example invocations to help Claude understand usage",
        },
        project: {
          type: "string",
          description: "Team-specific skill (null for global)",
        },
      },
      required: ["name", "description", "prompt_template"],
    },
  },
];

// ---------------------------------------------------------------------------
// Auto-TTL: set expires_at based on memory type
// Facts, preferences, decisions, corrections, patterns never expire.
// Transient types get a TTL so they naturally fade via nightly decay.
// ---------------------------------------------------------------------------

const AUTO_TTL_DAYS = {
  transcript: 90,
  event: 180,
  conversation: 120,
};

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function handleMemoryStore(args) {
  const {
    content,
    memory_type,
    project,
    tags = [],
    importance,
    source,
    supersedes,
    metadata = {},
    expires_at,
  } = args;

  // Generate embedding
  const embedding = await embed(content);

  // Check for near-duplicates (>95% similarity = same content, just update)
  const { data: duplicate } = await supabase.rpc("find_similar_memory", {
    query_embedding: JSON.stringify(embedding),
    similarity_threshold: 0.95,
    filter_project: project || null,
  });

  if (duplicate && duplicate.length > 0) {
    const existing = duplicate[0];
    const updates = {
      content,
      embedding: JSON.stringify(embedding),
      memory_type,
      tags,
      importance:
        importance ?? DEFAULT_IMPORTANCE[memory_type] ?? 5,
      source: source || existing.source,
      metadata,
    };
    if (expires_at) updates.expires_at = expires_at;

    const { data, error } = await supabase
      .from("memories")
      .update(updates)
      .eq("id", existing.id)
      .select("id, content, memory_type, project, importance")
      .single();

    if (error) throw new Error(`Update failed: ${error.message}`);
    return {
      action: "updated_existing",
      message: `Updated existing memory (${Math.round(existing.similarity * 100)}% similar)`,
      memory: data,
    };
  }

  // For corrections: auto-find and supersede the outdated memory
  // Uses a lower threshold (80%) to catch "same topic, changed details"
  let autoSuperseded = null;
  if (memory_type === "correction" && !supersedes) {
    const { data: related } = await supabase.rpc("find_similar_memory", {
      query_embedding: JSON.stringify(embedding),
      similarity_threshold: 0.80,
      filter_project: project || null,
    });

    if (related && related.length > 0) {
      autoSuperseded = related[0];
    }
  }

  // Auto-TTL for transient memory types
  const ttlDays = AUTO_TTL_DAYS[memory_type];
  const effectiveExpiry = expires_at
    ? expires_at
    : ttlDays
      ? new Date(Date.now() + ttlDays * 86400000).toISOString()
      : null;

  // Find related memories for linking (top 3 at >60% similarity, excluding near-dupes)
  let relatedIds = [];
  const { data: relatedMemories } = await supabase.rpc("search_memories", {
    query_embedding: JSON.stringify(embedding),
    match_count: 3,
    filter_project: project || null,
    filter_types: null,
    min_importance: 0,
  });
  if (relatedMemories && relatedMemories.length > 0) {
    relatedIds = relatedMemories
      .filter((m) => m.similarity >= 0.6 && m.similarity < 0.95)
      .map((m) => m.id);
  }

  // Store new memory
  const record = {
    content,
    embedding: JSON.stringify(embedding),
    memory_type,
    project: project || null,
    tags,
    importance: importance ?? DEFAULT_IMPORTANCE[memory_type] ?? 5,
    source: source || null,
    metadata,
    related_ids: relatedIds,
  };
  if (effectiveExpiry) record.expires_at = effectiveExpiry;

  const { data, error } = await supabase
    .from("memories")
    .insert(record)
    .select("id, content, memory_type, project, importance")
    .single();

  if (error) throw new Error(`Insert failed: ${error.message}`);

  // Supersede the old memory (explicit ID or auto-detected)
  const supersedeId = supersedes || autoSuperseded?.id;
  if (supersedeId) {
    await supabase
      .from("memories")
      .update({ superseded_by: data.id, active: false })
      .eq("id", supersedeId);
  }

  // Update related memories to link back (bidirectional linking)
  if (relatedIds.length > 0 && data?.id) {
    for (const relId of relatedIds) {
      try {
        await supabase.rpc("exec_sql", {
          sql: `UPDATE memories SET related_ids = array_append(
            COALESCE(related_ids, '{}'), '${data.id}'::uuid
          ) WHERE id = '${relId}' AND NOT ('${data.id}'::uuid = ANY(COALESCE(related_ids, '{}')))`,
        });
      } catch (_) {} // best-effort, don't fail the store
    }
  }

  const result = { action: "created", memory: data };
  if (relatedIds.length > 0) {
    result.linked_to = relatedIds.length;
  }
  if (autoSuperseded) {
    result.auto_superseded = {
      id: autoSuperseded.id,
      old_content: autoSuperseded.content,
      similarity: Math.round(autoSuperseded.similarity * 100) + "%",
    };
    result.message = `Stored correction and auto-superseded related memory (${Math.round(autoSuperseded.similarity * 100)}% similar)`;
  }

  return result;
}

async function handleMemoryRecall(args) {
  const {
    query,
    limit = 10,
    project,
    types,
    min_importance = 0,
  } = args;

  const embedding = await embed(query);

  const { data, error } = await supabase.rpc("search_memories", {
    query_embedding: JSON.stringify(embedding),
    match_count: limit,
    filter_project: project || null,
    filter_types: types || null,
    min_importance: min_importance,
  });

  if (error) throw new Error(`Search failed: ${error.message}`);

  return {
    count: data.length,
    memories: data.map((m) => ({
      ...m,
      similarity: Math.round(m.similarity * 1000) / 1000,
    })),
  };
}

async function handleMemoryTimeline(args) {
  const { project, limit = 20, types } = args;

  const { data, error } = await supabase.rpc("memory_timeline", {
    filter_project: project || null,
    entry_limit: limit,
    filter_types: types || null,
  });

  if (error) throw new Error(`Timeline failed: ${error.message}`);

  return { count: data.length, memories: data };
}

async function handleMemoryUpdate(args) {
  const { id, content, importance, tags, active } = args;

  const updates = {};
  if (content !== undefined) {
    updates.content = content;
    updates.embedding = JSON.stringify(await embed(content));
  }
  if (importance !== undefined) updates.importance = importance;
  if (tags !== undefined) updates.tags = tags;
  if (active !== undefined) updates.active = active;

  if (Object.keys(updates).length === 0) {
    return { message: "No updates provided" };
  }

  const { data, error } = await supabase
    .from("memories")
    .update(updates)
    .eq("id", id)
    .select("id, content, memory_type, project, importance, active")
    .single();

  if (error) throw new Error(`Update failed: ${error.message}`);

  return { action: "updated", memory: data };
}

async function handleMemoryLogConversation(args) {
  const { summary, facts = [], project, source } = args;

  const results = [];

  // Store the conversation summary
  const summaryResult = await handleMemoryStore({
    content: summary,
    memory_type: "conversation",
    project,
    source,
    importance: 3,
  });
  results.push({ type: "conversation_summary", ...summaryResult });

  // Store each extracted fact individually
  for (const fact of facts) {
    const factResult = await handleMemoryStore({
      content: fact.content,
      memory_type: fact.memory_type || "fact",
      project,
      source,
      importance: fact.importance,
    });
    results.push({ type: "extracted_fact", ...factResult });
  }

  return {
    message: `Logged conversation + ${facts.length} extracted facts`,
    results,
  };
}

// ---------------------------------------------------------------------------
// Skill handlers
// ---------------------------------------------------------------------------

async function handleSkillSearch(args) {
  const { query, tags, limit = 5 } = args;

  const embedding = await embed(query);

  const { data, error } = await supabase.rpc("search_skills", {
    query_embedding: JSON.stringify(embedding),
    match_count: limit,
    filter_tags: tags || null,
  });

  if (error) throw new Error(`Skill search failed: ${error.message}`);

  return {
    count: data.length,
    skills: data.map((s) => ({
      ...s,
      similarity: Math.round(s.similarity * 1000) / 1000,
    })),
  };
}

async function handleSkillGet(args) {
  const { name } = args;

  const { data, error } = await supabase
    .from("skills")
    .select("*")
    .eq("name", name)
    .eq("active", true)
    .single();

  if (error) throw new Error(`Skill not found: ${error.message}`);
  return data;
}

async function handleSkillCreate(args) {
  const {
    name,
    description,
    prompt_template,
    tags = [],
    input_params = [],
    examples = [],
    project,
  } = args;

  // Generate embedding from description for semantic discovery
  const embedding = await embed(`${name}: ${description}`);

  const { data, error } = await supabase
    .from("skills")
    .insert({
      name,
      description,
      prompt_template,
      tags,
      embedding: JSON.stringify(embedding),
      input_params,
      examples,
      project: project || null,
    })
    .select("id, name, description, tags")
    .single();

  if (error) throw new Error(`Failed to create skill: ${error.message}`);

  return {
    action: "created",
    message: `Skill "${name}" created and indexed for semantic discovery.`,
    skill: data,
  };
}

// ---------------------------------------------------------------------------
// Schedule handlers
// ---------------------------------------------------------------------------

async function handleScheduleCreate(args) {
  const {
    name,
    cron_expression,
    channel_id,
    project,
    prompt,
    timezone = "UTC",
    run_once = false,
  } = args;

  const { data, error } = await supabase
    .from("scheduled_tasks")
    .insert({
      name,
      cron_expression,
      channel_id,
      project: project || null,
      prompt,
      timezone,
      metadata: run_once ? { run_once: true } : {},
    })
    .select("id, name, cron_expression, channel_id, project, timezone, enabled")
    .single();

  if (error) throw new Error(`Failed to create schedule: ${error.message}`);

  return {
    action: "created",
    message: `Scheduled task "${name}" created. Bridge will pick it up within 5 minutes.`,
    task: data,
  };
}

async function handleScheduleList(args) {
  const { enabled_only = true } = args;

  let query = supabase
    .from("scheduled_tasks")
    .select("id, name, cron_expression, timezone, channel_id, project, prompt, enabled, last_run_at, last_run_status, created_at")
    .order("created_at", { ascending: true });

  if (enabled_only) {
    query = query.eq("enabled", true);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Failed to list schedules: ${error.message}`);

  return {
    count: data.length,
    tasks: data,
  };
}

async function handleScheduleDelete(args) {
  const { id, name, hard_delete = false } = args;

  if (!id && !name) {
    throw new Error("Provide either id or name to identify the task");
  }

  let query = supabase.from("scheduled_tasks");

  if (hard_delete) {
    query = query.delete();
  } else {
    query = query.update({ enabled: false });
  }

  if (id) {
    query = query.eq("id", id);
  } else {
    query = query.eq("name", name);
  }

  const { error } = await query;
  if (error) throw new Error(`Failed to ${hard_delete ? "delete" : "disable"} schedule: ${error.message}`);

  return {
    action: hard_delete ? "deleted" : "disabled",
    message: `Task ${id || name} ${hard_delete ? "permanently deleted" : "disabled"}.`,
  };
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "supabase-memory", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;

    switch (name) {
      case "memory_store":
        result = await handleMemoryStore(args);
        break;
      case "memory_recall":
        result = await handleMemoryRecall(args);
        break;
      case "memory_timeline":
        result = await handleMemoryTimeline(args);
        break;
      case "memory_update":
        result = await handleMemoryUpdate(args);
        break;
      case "memory_log_conversation":
        result = await handleMemoryLogConversation(args);
        break;
      case "skill_search":
        result = await handleSkillSearch(args);
        break;
      case "skill_get":
        result = await handleSkillGet(args);
        break;
      case "skill_create":
        result = await handleSkillCreate(args);
        break;
      case "schedule_create":
        result = await handleScheduleCreate(args);
        break;
      case "schedule_list":
        result = await handleScheduleList(args);
        break;
      case "schedule_delete":
        result = await handleScheduleDelete(args);
        break;
      default:
        return {
          content: [
            { type: "text", text: `Unknown tool: ${name}` },
          ],
          isError: true,
        };
    }

    return {
      content: [
        { type: "text", text: JSON.stringify(result, null, 2) },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Error in ${name}: ${err.message}`,
        },
      ],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
