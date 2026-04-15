import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ToolEntry {
  id: string;
  toolUseId: string | null;
  toolName: string;
  displayLabel: string;
  startTime: number;
  endTime: number | null;
  status: "running" | "completed" | "failed";
  isSubagent: boolean;
  groupKey: string | null;
}

export interface TaskEntry {
  taskId: string;
  description: string;
  taskType: string | null;
  workflowName: string | null;
  status: "pending" | "running" | "completed" | "failed" | "killed";
  startTime: number;
  endTime: number | null;
  toolUseCount: number;
  lastToolName: string | null;
  summary: string | null;
  error: string | null;
}

export interface SystemEvent {
  timestamp: number;
  type:
    | "compact"
    | "retry"
    | "rate_limit"
    | "hook"
    | "notification"
    | "auth"
    | "memory"
    | "info";
  label: string;
  detail?: string;
}

export type SessionPhase =
  | "thinking"
  | "working"
  | "streaming"
  | "completed"
  | "failed"
  | "stopped";

export interface SessionStateData {
  phase: SessionPhase;
  startTime: number;

  // Tool tracking
  tools: ToolEntry[];
  totalToolCount: number;

  // Task / subagent tracking
  tasks: Map<string, TaskEntry>;

  // Text streaming
  streamBuffer: string;
  fullResponse: string;
  displayOffset: number;

  // System events (recent, for display)
  systemEvents: SystemEvent[];

  // Rate limiting
  rateLimitedUntil: number;

  // Compaction
  isCompacting: boolean;

  // Context tracking
  lastKnownContextTokens: number; // last pre_tokens from compact_boundary
  compactionCount: number;

  // Result
  resultText: string | null;
  costUsd: number;
  durationMs: number;
  numTurns: number;

  // Dirty flag
  dirty: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SYSTEM_EVENTS = 20;

const BATCHABLE_TOOLS = new Set(["Read", "Glob", "Grep"]);

const MCP_SERVER_EMOJIS: Record<string, string> = {
  railway: "\u{1F682}",
  "kern-google": "\u{1F4E7}",
  "supabase-memory": "\u{1F9E0}",
  github: "\u{1F419}",
  "kern-github": "\u{1F419}",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function str(v: unknown, max = 80): string {
  return String(v ?? "").slice(0, max);
}

/** Shorten an absolute file path for display. Strips /app/ prefix and
 *  collapses to the last 2 segments when the path has more than 3 parts. */
function shortenPath(raw: string): string {
  const stripped = raw.replace(/^\/app\//, "");
  const segments = stripped.split("/");
  if (segments.length <= 3) return stripped;
  return segments.slice(-2).join("/");
}

/** Extract intent from a bash command, stripping heredocs and noise. */
function summariseBash(cmd: unknown): string {
  const raw = String(cmd ?? "").trim();
  const heredocMatch = raw.match(
    /^(node|python3?|bash)\s*(-e\s*["'])?[^<\n]{0,40}<<\s*['"]?EOF/i,
  );
  if (heredocMatch) return `${heredocMatch[1]} -e "..." (script)`;
  const firstLine = raw
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#")) ?? raw;
  return firstLine.length > 60 ? firstLine.slice(0, 57) + "..." : firstLine;
}

/** Build a short, human-readable label for a tool call. */
export function buildDisplayLabel(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const filePath =
    typeof input.file_path === "string" ? shortenPath(input.file_path) : null;

  switch (toolName) {
    case "Read":
      return `\u{1F4C4} ${filePath ?? "file"}`;
    case "Write":
      return `\u{270F}\u{FE0F} Write ${filePath ?? "file"}`;
    case "Edit":
      return `\u{270F}\u{FE0F} Edit ${filePath ?? "file"}`;
    case "Glob":
      return `\u{1F50D} Glob ${str(input.pattern)}`;
    case "Grep":
      return `\u{1F50D} Grep ${str(input.pattern, 50)}${input.path ? ` in ${str(input.path, 30)}` : ""}`;
    case "Bash":
      return `\u{1F4BB} ${summariseBash(input.command)}`;
    case "WebSearch":
      return `\u{1F310} ${str(input.query)}`;
    case "WebFetch":
      return `\u{1F310} ${str(input.url).replace("https://", "")}`;
    case "Agent":
      return `\u{1F916} ${str(input.description ?? input.prompt)}`;
    case "TodoWrite":
      return `\u{1F4CB} Update tasks`;
    default: {
      if (toolName.startsWith("mcp__")) {
        const parts = toolName.split("__");
        const server = parts[1] ?? "";
        const tool = parts.slice(2).join("_").replace(/_/g, " ");
        const emoji = MCP_SERVER_EMOJIS[server] ?? "\u{2699}\u{FE0F}";
        const extra = input.account
          ? ` (${String(input.account)})`
          : input.query
            ? `: "${str(input.query, 40)}"`
            : input.serviceId
              ? " (Railway)"
              : "";
        return `${emoji} ${server}: ${tool}${extra}`;
      }
      return `\u{1F527} ${toolName}`;
    }
  }
}

// ---------------------------------------------------------------------------
// SessionState
// ---------------------------------------------------------------------------

export class SessionState {
  private state: SessionStateData;

  constructor(startTime: number) {
    this.state = {
      phase: "thinking",
      startTime,
      tools: [],
      totalToolCount: 0,
      tasks: new Map(),
      streamBuffer: "",
      fullResponse: "",
      displayOffset: 0,
      systemEvents: [],
      rateLimitedUntil: 0,
      isCompacting: false,
      lastKnownContextTokens: 0,
      compactionCount: 0,
      resultText: null,
      costUsd: 0,
      durationMs: 0,
      numTurns: 0,
      dirty: true,
    };
  }

  // ---- Tool lifecycle ----------------------------------------------------

  handleToolStart(
    toolName: string,
    input: Record<string, unknown>,
    isSubagent: boolean,
  ): void {
    const id = randomUUID();
    const entry: ToolEntry = {
      id,
      toolUseId: null,
      toolName,
      displayLabel: buildDisplayLabel(toolName, input),
      startTime: Date.now(),
      endTime: null,
      status: "running",
      isSubagent,
      groupKey: BATCHABLE_TOOLS.has(toolName) ? toolName : null,
    };
    this.state.tools.push(entry);
    this.state.totalToolCount++;

    if (this.state.phase === "thinking") {
      this.state.phase = "working";
    }

    this.state.dirty = true;
  }

  handleToolEnd(toolId: string, durationMs?: number, error?: string): void {
    const entry = this.state.tools.find((t) => t.id === toolId);
    if (!entry) return;

    entry.endTime = durationMs != null ? entry.startTime + durationMs : Date.now();
    entry.status = error ? "failed" : "completed";

    this.state.dirty = true;
  }

  handleToolProgress(
    toolUseId: string,
    toolName: string,
    _elapsedSeconds: number,
  ): void {
    // Try to match a running tool by name and update its toolUseId
    const entry = this.state.tools.find(
      (t) => t.status === "running" && t.toolName === toolName,
    );
    if (entry) {
      entry.toolUseId = toolUseId;
    }
    this.state.dirty = true;
  }

  // ---- Task / subagent lifecycle -----------------------------------------

  handleTaskStarted(
    taskId: string,
    description: string,
    taskType?: string,
    workflowName?: string,
  ): void {
    const entry: TaskEntry = {
      taskId,
      description,
      taskType: taskType ?? null,
      workflowName: workflowName ?? null,
      status: "running",
      startTime: Date.now(),
      endTime: null,
      toolUseCount: 0,
      lastToolName: null,
      summary: null,
      error: null,
    };
    this.state.tasks.set(taskId, entry);
    this.state.dirty = true;
  }

  handleTaskProgress(
    taskId: string,
    description: string,
    _usage: unknown,
    lastToolName?: string,
    summary?: string,
  ): void {
    const entry = this.state.tasks.get(taskId);
    if (!entry) return;

    entry.description = description;
    if (lastToolName != null) entry.lastToolName = lastToolName;
    if (summary != null) entry.summary = summary;
    entry.toolUseCount++;

    this.state.dirty = true;
  }

  handleTaskUpdated(
    taskId: string,
    patch: Partial<
      Pick<TaskEntry, "status" | "description" | "error" | "summary">
    >,
  ): void {
    const entry = this.state.tasks.get(taskId);
    if (!entry) return;

    if (patch.status != null) {
      entry.status = patch.status;
      if (
        patch.status === "completed" ||
        patch.status === "failed" ||
        patch.status === "killed"
      ) {
        entry.endTime = Date.now();
      }
    }
    if (patch.description != null) entry.description = patch.description;
    if (patch.error != null) entry.error = patch.error;
    if (patch.summary != null) entry.summary = patch.summary;

    this.state.dirty = true;
  }

  handleTaskNotification(
    taskId: string,
    status: "completed" | "failed" | "killed",
    summary: string,
    _usage?: unknown,
  ): void {
    const entry = this.state.tasks.get(taskId);
    if (entry) {
      entry.status = status;
      entry.summary = summary;
      entry.endTime = Date.now();
    }
    this.state.dirty = true;
  }

  // ---- Text streaming ----------------------------------------------------

  handleTextDelta(text: string): void {
    this.state.streamBuffer += text;
    this.state.fullResponse += text;
    if (this.state.phase !== "streaming") {
      this.state.phase = "streaming";
    }
    this.state.dirty = true;
  }

  // ---- System events -----------------------------------------------------

  handleCompactBoundary(metadata: {
    trigger: string;
    pre_tokens: number;
    post_tokens?: number;
    duration_ms?: number;
  }): void {
    const saved =
      metadata.post_tokens != null
        ? metadata.pre_tokens - metadata.post_tokens
        : null;
    this.addSystemEvent(
      "compact",
      `Context compacted (${metadata.trigger})`,
      saved != null ? `Saved ~${saved} tokens in ${metadata.duration_ms ?? "?"}ms` : undefined,
    );
    this.state.isCompacting = false;
    this.state.lastKnownContextTokens = metadata.post_tokens ?? metadata.pre_tokens;
    this.state.compactionCount++;
    this.state.dirty = true;
  }

  handleStatusChange(status: string, _compactResult?: string): void {
    if (status === "compacting") {
      this.state.isCompacting = true;
      this.state.dirty = true;
    }
  }

  handleApiRetry(
    attempt: number,
    maxRetries: number,
    delayMs: number,
    errorStatus: number | null,
  ): void {
    this.addSystemEvent(
      "retry",
      `API retry ${attempt}/${maxRetries} in ${Math.round(delayMs / 1000)}s`,
      errorStatus != null ? `HTTP ${errorStatus}` : undefined,
    );
  }

  handleRateLimit(retryMs: number): void {
    this.state.rateLimitedUntil = Date.now() + retryMs;
    this.addSystemEvent(
      "rate_limit",
      `Rate limited, retrying in ${Math.round(retryMs / 1000)}s`,
    );
  }

  handleHookEvent(
    subtype: string,
    hookName: string,
    hookEvent: string,
    output?: string,
    outcome?: string,
  ): void {
    const label =
      subtype === "response"
        ? `Hook ${hookName} ${hookEvent}: ${outcome ?? "done"}`
        : `Hook ${hookName} ${subtype}`;
    this.addSystemEvent("hook", label, output);
  }

  handleNotification(key: string, text: string, _priority: string): void {
    this.addSystemEvent("notification", `[${key}] ${text}`);
  }

  handleMemoryRecall(mode: string, memories: unknown[]): void {
    this.addSystemEvent(
      "memory",
      `Memory ${mode}: ${memories.length} result${memories.length === 1 ? "" : "s"}`,
    );
  }

  handleSessionStateChanged(_state: string): void {
    // No-op for now
  }

  handleAuthStatus(
    _isAuthenticating: boolean,
    _output: string[],
    error?: string,
  ): void {
    if (error) {
      this.addSystemEvent("auth", `Auth error: ${error}`);
    }
  }

  handleToolUseSummary(summary: string): void {
    this.addSystemEvent("info", summary);
  }

  // ---- Result ------------------------------------------------------------

  handleResult(
    result: string | null,
    costUsd: number,
    durationMs: number,
    isError: boolean,
    numTurns?: number,
  ): void {
    this.state.phase = isError ? "failed" : "completed";
    this.state.resultText = result;
    this.state.costUsd = costUsd;
    this.state.durationMs = durationMs;
    this.state.numTurns = numTurns ?? 0;
    this.state.dirty = true;
  }

  // ---- Accessors ---------------------------------------------------------

  getData(): SessionStateData {
    return this.state;
  }

  isDirty(): boolean {
    return this.state.dirty;
  }

  markClean(): void {
    this.state.dirty = false;
  }

  getLastToolId(): string | null {
    const tools = this.state.tools;
    return tools.length > 0 ? tools[tools.length - 1].id : null;
  }

  // ---- Internal ----------------------------------------------------------

  private addSystemEvent(
    type: SystemEvent["type"],
    label: string,
    detail?: string,
  ): void {
    this.state.systemEvents.push({
      timestamp: Date.now(),
      type,
      label,
      detail,
    });
    // Keep only the most recent events
    if (this.state.systemEvents.length > MAX_SYSTEM_EVENTS) {
      this.state.systemEvents = this.state.systemEvents.slice(
        -MAX_SYSTEM_EVENTS,
      );
    }
    this.state.dirty = true;
  }
}
