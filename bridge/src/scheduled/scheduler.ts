import { Cron } from "croner";
import { createClient } from "@supabase/supabase-js";
import type { TextChannel, Client } from "discord.js";
import { sessionManager } from "../claude/session-manager.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScheduledTask {
  id: string;
  name: string;
  cron_expression: string;
  timezone: string;
  channel_id: string;
  project: string | null;
  prompt: string;
  enabled: boolean;
  last_run_at: string | null;
  last_run_status: string | null;
  metadata?: Record<string, unknown> | null;
}

interface ActiveCron {
  task: ScheduledTask;
  cron: Cron;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const activeCrons = new Map<string, ActiveCron>();
let supabase: ReturnType<typeof createClient> | null = null;
let discordClient: Client | null = null;
let reloadInterval: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function getClient() {
  if (supabase) return supabase;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.warn("[scheduler] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set, scheduler disabled");
    return null;
  }

  supabase = createClient(url, key);
  return supabase;
}

// ---------------------------------------------------------------------------
// Load tasks from Supabase and sync Croner instances
// ---------------------------------------------------------------------------

async function syncTasks(): Promise<void> {
  const client = getClient();
  if (!client || !discordClient) return;

  const { data: tasks, error } = await client
    .from("scheduled_tasks")
    .select("*")
    .eq("enabled", true);

  if (error) {
    console.warn("[scheduler] Failed to load tasks:", error.message);
    return;
  }

  const currentIds = new Set(tasks.map((t: ScheduledTask) => t.id));

  // Remove crons for tasks that no longer exist or are disabled
  for (const [id, active] of activeCrons) {
    if (!currentIds.has(id)) {
      active.cron.stop();
      activeCrons.delete(id);
      console.log(`[scheduler] Removed: ${active.task.name}`);
    }
  }

  // Add or update crons for active tasks
  for (const task of tasks as ScheduledTask[]) {
    const existing = activeCrons.get(task.id);

    // Skip if already registered with same cron expression
    if (existing && existing.task.cron_expression === task.cron_expression) {
      existing.task = task; // update prompt/metadata in case they changed
      continue;
    }

    // Stop old cron if expression changed
    if (existing) {
      existing.cron.stop();
    }

    // Register new cron
    const cron = new Cron(task.cron_expression, {
      timezone: task.timezone || "Africa/Johannesburg",
    }, () => {
      fireTask(task).catch((err) => {
        console.warn(`[scheduler] Error firing ${task.name}:`, err instanceof Error ? err.message : err);
      });
    });

    activeCrons.set(task.id, { task, cron });
    console.log(`[scheduler] Registered: ${task.name} (${task.cron_expression} ${task.timezone})`);
  }
}

// ---------------------------------------------------------------------------
// Fire a scheduled task
// ---------------------------------------------------------------------------

async function fireTask(task: ScheduledTask): Promise<void> {
  if (!discordClient) return;

  const channel = await discordClient.channels.fetch(task.channel_id).catch(() => null);
  if (!channel || !("send" in channel)) {
    console.warn(`[scheduler] Channel ${task.channel_id} not found for task ${task.name}`);
    await updateLastRun(task.id, "failed");
    return;
  }

  console.log(`[scheduler] Firing: ${task.name} -> #${(channel as TextChannel).name}`);

  // Check if session is already active on this channel
  if (sessionManager.isActive(task.channel_id)) {
    console.log(`[scheduler] Channel ${task.channel_id} has active session, skipping ${task.name}`);
    await updateLastRun(task.id, "skipped");
    return;
  }

  try {
    const prefix = `[Scheduled: ${task.name}]\n\n`;
    await sessionManager.sendMessage(channel as TextChannel, prefix + task.prompt);
    await updateLastRun(task.id, "success");

    // One-time tasks: disable after successful execution
    const meta = (task.metadata as Record<string, unknown>) ?? {};
    if (meta.run_once) {
      const client = getClient();
      if (client) {
        await (client.from("scheduled_tasks") as unknown as {
          update: (row: Record<string, unknown>) => { eq: (col: string, val: string) => Promise<unknown> };
        }).update({ enabled: false }).eq("id", task.id);
        const active = activeCrons.get(task.id);
        if (active) {
          active.cron.stop();
          activeCrons.delete(task.id);
        }
        console.log(`[scheduler] One-time task "${task.name}" completed and disabled`);
      }
    }
  } catch (err) {
    console.warn(`[scheduler] Task ${task.name} failed:`, err instanceof Error ? err.message : err);
    await updateLastRun(task.id, "failed");
  }
}

// ---------------------------------------------------------------------------
// Update last_run tracking
// ---------------------------------------------------------------------------

async function updateLastRun(taskId: string, status: string): Promise<void> {
  const client = getClient();
  if (!client) return;

  await (client.from("scheduled_tasks") as unknown as {
    update: (row: Record<string, unknown>) => { eq: (col: string, val: string) => Promise<unknown> };
  })
    .update({ last_run_at: new Date().toISOString(), last_run_status: status })
    .eq("id", taskId);
}

// ---------------------------------------------------------------------------
// Catch-up: check for tasks that should have run while bridge was down
// ---------------------------------------------------------------------------

async function catchUpMissedTasks(): Promise<void> {
  const client = getClient();
  if (!client || !discordClient) return;

  const { data: tasks, error } = await client
    .from("scheduled_tasks")
    .select("*")
    .eq("enabled", true);

  if (error || !tasks) return;

  for (const task of tasks as ScheduledTask[]) {
    if (!task.last_run_at) continue; // never run before, skip catch-up

    const lastRun = new Date(task.last_run_at);
    const now = new Date();

    // Use Croner to check what the previous fire time should have been
    const cron = new Cron(task.cron_expression, {
      timezone: task.timezone || "Africa/Johannesburg",
    });
    const prevRun = cron.previousRun();
    cron.stop();

    if (prevRun && prevRun > lastRun) {
      // A scheduled run was missed
      const missedMinutesAgo = Math.round((now.getTime() - prevRun.getTime()) / 60000);
      console.log(`[scheduler] Catch-up: ${task.name} missed ${missedMinutesAgo}min ago, firing now`);
      await fireTask(task);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the scheduler. Call once after Discord client is ready.
 */
export async function startScheduler(client: Client): Promise<void> {
  discordClient = client;

  console.log("[scheduler] Starting...");

  // Initial load
  await syncTasks();

  // Catch up on anything missed during downtime
  await catchUpMissedTasks();

  // Reload tasks from Supabase every 5 minutes (picks up new/changed tasks)
  reloadInterval = setInterval(() => {
    syncTasks().catch((err) => {
      console.warn("[scheduler] Reload failed:", err instanceof Error ? err.message : err);
    });
  }, 5 * 60 * 1000);

  const count = activeCrons.size;
  console.log(`[scheduler] Running with ${count} task(s)`);
}

/**
 * Stop all scheduled tasks. Call on shutdown.
 */
export function stopScheduler(): void {
  if (reloadInterval) {
    clearInterval(reloadInterval);
    reloadInterval = null;
  }

  for (const [, active] of activeCrons) {
    active.cron.stop();
  }
  activeCrons.clear();

  console.log("[scheduler] Stopped");
}
