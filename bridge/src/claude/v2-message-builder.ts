import {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SeparatorSpacingSize,
  MessageFlags,
} from "discord.js";
import type { SessionStateData, SessionPhase, ToolEntry, TaskEntry, SystemEvent } from "./session-state.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TEXT_BUDGET = 3800; // leave headroom below 4000

const COLORS = {
  blue: 0x5865F2,
  green: 0x2ECC71,
  red: 0xE74C3C,
  orange: 0xE67E22,
  yellow: 0xF1C40F,
  purple: 0x9B59B6,
  grey: 0x95A5A6,
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatElapsed(startTime: number): string {
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  if (elapsed < 60) return `${elapsed}s`;
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  return `${mins}m ${secs}s`;
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

const CONTEXT_WINDOW = 1_000_000; // Opus 4.6 1M context window (GA March 2026)

/** Estimate total tokens from USD cost (blended Opus rate ~$20/M avg). */
function estimateTokensFromCost(costUsd: number): number {
  if (costUsd <= 0) return 0;
  return Math.round(costUsd / 20 * 1_000_000);
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 100_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${Math.round(tokens / 1000)}k`;
}

function contextPct(tokens: number): string {
  if (tokens <= 0) return "";
  const pct = Math.round((tokens / CONTEXT_WINDOW) * 100);
  return `${pct}%`;
}

function phaseColor(phase: SessionPhase): number {
  switch (phase) {
    case "thinking": return COLORS.blue;
    case "working": return COLORS.blue;
    case "streaming": return COLORS.green;
    case "completed": return COLORS.green;
    case "failed": return COLORS.red;
    case "stopped": return COLORS.orange;
  }
}

// ---------------------------------------------------------------------------
// Text budget tracker
// ---------------------------------------------------------------------------

class TextBudget {
  private used = 0;
  constructor(private readonly max = MAX_TEXT_BUDGET) {}

  allocate(text: string, maxLen?: number): string {
    const available = this.max - this.used;
    if (available <= 4) return "...";
    const limit = Math.min(available, maxLen ?? available);
    const result = text.length <= limit ? text : text.slice(0, limit - 3) + "...";
    this.used += result.length;
    return result;
  }

  remaining(): number {
    return this.max - this.used;
  }
}

// ---------------------------------------------------------------------------
// Compact tool line rendering
// ---------------------------------------------------------------------------

interface ToolLineGroup {
  label: string;
  count: number;
  status: "running" | "completed" | "failed" | "mixed";
  totalDurationMs: number;
  anyRunning: boolean;
}

/** Group consecutive identical tool labels into compact lines. */
function compactToolLines(tools: ToolEntry[]): ToolLineGroup[] {
  const mainTools = tools.filter(t => !t.isSubagent);
  if (mainTools.length === 0) return [];

  const groups: ToolLineGroup[] = [];
  let current: ToolLineGroup | null = null;

  for (const tool of mainTools) {
    const label = tool.displayLabel;

    if (current && current.label === label) {
      current.count++;
      if (tool.status === "running") {
        current.anyRunning = true;
        current.status = current.status === "running" ? "running" : "mixed";
      } else if (tool.status === "failed") {
        current.status = current.status === "completed" ? "mixed" : current.status;
      }
      if (tool.endTime) {
        current.totalDurationMs += (tool.endTime - tool.startTime);
      }
    } else {
      if (current) groups.push(current);
      current = {
        label,
        count: 1,
        status: tool.status,
        totalDurationMs: tool.endTime ? (tool.endTime - tool.startTime) : 0,
        anyRunning: tool.status === "running",
      };
    }
  }
  if (current) groups.push(current);

  return groups;
}

function toolLineStatusMark(group: ToolLineGroup): string {
  if (group.anyRunning) return "\u23f3";
  switch (group.status) {
    case "completed": return "\u2705";
    case "failed": return "\u274c";
    case "mixed": return "\u2705";
    default: return "\u23f3";
  }
}

function renderToolLine(group: ToolLineGroup): string {
  const mark = toolLineStatusMark(group);
  const countStr = group.count > 1 ? ` \u00d7${group.count}` : "";
  const dur = group.anyRunning
    ? ""
    : group.totalDurationMs > 0
      ? ` (${formatDuration(group.totalDurationMs)})`
      : "";
  return `${mark} ${group.label}${countStr}${dur}`;
}

// ---------------------------------------------------------------------------
// Component builders
// ---------------------------------------------------------------------------

function buildStatusContainer(state: SessionStateData, budget: TextBudget): ContainerBuilder {
  const elapsed = formatElapsed(state.startTime);
  const tools = `${state.totalToolCount} tools`;
  const container = new ContainerBuilder().setAccentColor(phaseColor(state.phase));

  let statusText: string;
  switch (state.phase) {
    case "thinking":
      statusText = budget.allocate(`\u23f3 **Thinking...** (${elapsed})`);
      break;
    case "working": {
      const lastTool = state.tools.filter(t => !t.isSubagent).at(-1);
      const activity = lastTool?.displayLabel ?? "Working...";
      const compactNote = state.isCompacting ? " | \u{1F4E6} Compacting..." : "";
      const rateLimitNote = state.rateLimitedUntil > Date.now()
        ? ` | \u23f8\ufe0f Rate limited ${Math.ceil((state.rateLimitedUntil - Date.now()) / 1000)}s`
        : "";
      const ctxNote = state.lastKnownContextTokens > 0
        ? ` | \u{1F4CA} ${contextPct(state.lastKnownContextTokens)}`
        : "";
      statusText = budget.allocate(
        `\u2699\ufe0f **${activity}**\n\u23f1\ufe0f ${elapsed} | \u{1F527} ${tools}${ctxNote}${compactNote}${rateLimitNote}`,
      );
      break;
    }
    case "streaming":
      statusText = budget.allocate(
        `\u2705 **Tools complete** | \u23f1\ufe0f ${elapsed} | \u{1F527} ${tools}\n\u{1F4DD} Generating response...`,
      );
      break;
    case "completed": {
      const dur = formatDuration(state.durationMs);
      const estTokens = estimateTokensFromCost(state.costUsd);
      const tokenStr = estTokens > 0 ? ` | ~${formatTokens(estTokens)} tokens` : "";
      // Use actual context tokens from compaction if available, otherwise estimate from cost
      const ctxTokens = state.lastKnownContextTokens > 0
        ? state.lastKnownContextTokens
        : estTokens;
      const ctxStr = ctxTokens > 0 ? ` | \u{1F4CA} ~${contextPct(ctxTokens)} context` : "";
      const compactStr = state.compactionCount > 0
        ? ` | \u{1F4E6} ${state.compactionCount}x compacted`
        : "";
      statusText = budget.allocate(
        `\u2705 **Task Complete** | \u23f1\ufe0f ${dur} | \u{1F527} ${tools}${tokenStr}${ctxStr}${compactStr}`,
      );
      break;
    }
    case "failed":
      statusText = budget.allocate(
        `\u274c **Task Failed** | \u23f1\ufe0f ${formatElapsed(state.startTime)} | \u{1F527} ${tools}`,
      );
      break;
    case "stopped":
      statusText = budget.allocate(
        `\u23f9\ufe0f **Stopped** | \u23f1\ufe0f ${formatElapsed(state.startTime)} | \u{1F527} ${tools}`,
      );
      break;
  }

  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(statusText));
  return container;
}

function buildToolLogContainer(tools: ToolEntry[], budget: TextBudget): ContainerBuilder {
  const container = new ContainerBuilder()
    .setAccentColor(COLORS.grey)
    .setSpoiler(true);

  const groups = compactToolLines(tools);
  if (groups.length === 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(budget.allocate("No tools yet")),
    );
    return container;
  }

  // Show most recent tool lines, cap at ~25 lines
  const maxLines = 25;
  const visible = groups.slice(-maxLines);
  const hidden = groups.length - visible.length;

  const lines: string[] = [];
  if (hidden > 0) {
    lines.push(`*...${hidden} earlier*`);
  }
  for (const group of visible) {
    lines.push(renderToolLine(group));
  }

  const allDone = tools.filter(t => !t.isSubagent).every(t => t.status !== "running");
  const headerEmoji = allDone ? "\u2705" : "\u23f3";
  const header = `${headerEmoji} **Tool Log** (${tools.filter(t => !t.isSubagent).length})`;

  const text = budget.allocate(`${header}\n${lines.join("\n")}`);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  return container;
}

function buildSystemEventsContainer(events: SystemEvent[], budget: TextBudget): ContainerBuilder {
  const container = new ContainerBuilder()
    .setAccentColor(COLORS.yellow)
    .setSpoiler(true);

  const eventEmojis: Record<string, string> = {
    compact: "\u{1F4E6}",
    retry: "\u{1F504}",
    rate_limit: "\u23f8\ufe0f",
    hook: "\u{1FA9D}",
    notification: "\u26a0\ufe0f",
    auth: "\u{1F511}",
    memory: "\u{1F9E0}",
    info: "\u{1F4DD}",
  };

  const lines = events.slice(-5).map(e => {
    const emoji = eventEmojis[e.type] ?? "\u2139\ufe0f";
    return `${emoji} ${e.label}`;
  });

  const prefix = events.length > 5 ? `...${events.length - 5} earlier events\n` : "";
  const text = budget.allocate(`**System Events**\n${prefix}${lines.join("\n")}`);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  return container;
}

function buildTaskContainer(task: TaskEntry, budget: TextBudget): ContainerBuilder {
  const statusEmoji = task.status === "running" ? "\u23f3"
    : task.status === "completed" ? "\u2705"
    : task.status === "failed" ? "\u274c"
    : "\u23f9\ufe0f";

  const container = new ContainerBuilder()
    .setAccentColor(COLORS.purple)
    .setSpoiler(true);

  const desc = task.description.length > 80 ? task.description.slice(0, 77) + "..." : task.description;
  const summaryLine = task.summary ? `\n${task.summary.slice(0, 100)}` : "";
  const text = budget.allocate(
    `${statusEmoji} **${task.taskType ?? "Agent"}**: ${desc}\nTools: ${task.toolUseCount} | Status: ${task.status}${summaryLine}`,
  );
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  return container;
}

function buildStopActionRow(channelId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`stop:${channelId}`)
      .setLabel("Stop")
      .setStyle(ButtonStyle.Danger),
  );
}

function buildCompletedActionRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("completed_noop")
      .setLabel("Completed")
      .setStyle(ButtonStyle.Success)
      .setDisabled(true),
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function buildV2Message(
  state: SessionStateData,
  channelId: string,
): {
  components: (ContainerBuilder | ActionRowBuilder<ButtonBuilder> | SeparatorBuilder)[];
  flags: number;
} {
  const budget = new TextBudget();
  const components: (ContainerBuilder | ActionRowBuilder<ButtonBuilder> | SeparatorBuilder)[] = [];

  // 1. Status container (always present, compact)
  components.push(buildStatusContainer(state, budget));

  // 2. Single tool log container (one spoiler box with all tools as compact lines)
  if (state.phase !== "thinking" && state.tools.length > 0) {
    components.push(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    components.push(buildToolLogContainer(state.tools, budget));
  }

  // 3. System events container (if any)
  if (state.systemEvents.length > 0 && budget.remaining() > 80) {
    components.push(buildSystemEventsContainer(state.systemEvents, budget));
  }

  // 4. Task containers (active subagents, max 2)
  const activeTasks = [...state.tasks.values()].filter(t => t.status === "running" || t.status === "pending");
  for (const task of activeTasks.slice(-2)) {
    if (budget.remaining() < 50) break;
    components.push(buildTaskContainer(task, budget));
  }

  // 5. Action row
  if (state.phase === "completed") {
    components.push(buildCompletedActionRow());
  } else if (state.phase !== "streaming") {
    components.push(buildStopActionRow(channelId));
  }

  return {
    components,
    flags: MessageFlags.IsComponentsV2 as number,
  };
}
