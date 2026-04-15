import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { type TextChannel, type Message, MessageFlags } from "discord.js";
import {
  upsertSession,
  updateSessionStatus,
  getProject,
  getSession,
  deleteSession,
  setAutoApprove,
} from "../db/database.js";
import { getConfig } from "../utils/config.js";
import { L } from "../utils/i18n.js";
import {
  createToolApprovalEmbed,
  createAskUserQuestionEmbed,
  createResultEmbed,
  createStopButton,
  createCompletedButton,
  splitMessage,
  type AskQuestionData,
} from "./output-formatter.js";
import { SessionState } from "./session-state.js";
import { buildV2Message } from "./v2-message-builder.js";
import { bufferTranscript } from "../memory/logger.js";
import { saveCheckpoint } from "../memory/checkpoint.js";
import { broadcast } from "../events/broadcaster.js";
import {
  writeMessage as writeKiMessage,
  updateSession as updateKiSession,
} from "../db/supabase.js";

interface ActiveSession {
  queryInstance: Query;
  channelId: string;
  sessionId: string | null; // Claude Agent SDK session ID
  dbId: string;
}

// Pending approval requests: requestId -> resolve function
const pendingApprovals = new Map<
  string,
  {
    resolve: (decision: { behavior: "allow" | "deny"; message?: string }) => void;
    channelId: string;
  }
>();

// Pending AskUserQuestion requests: requestId -> resolve function
const pendingQuestions = new Map<
  string,
  {
    resolve: (answer: string | null) => void;
    channelId: string;
  }
>();

// Pending custom text inputs: channelId -> requestId
const pendingCustomInputs = new Map<string, { requestId: string }>();

// Build a readable log line for a tool call
function buildThreadLog(toolName: string, input: Record<string, unknown>): string {
  const str = (v: unknown, max = 80) => String(v ?? "").slice(0, max);
  const filePath = typeof input.file_path === "string"
    ? input.file_path.replace("/app/", "").replace("/root/", "~/")
    : null;

  // Smart bash summariser: strips heredocs and multiline noise, shows intent
  function summariseBash(cmd: unknown): string {
    const raw = String(cmd ?? "").trim();
    // Strip node/python heredoc bodies -- just show the invocation
    const heredocMatch = raw.match(/^(node|python3?|bash)\s*(-e\s*["'])?[^<\n]{0,40}<<\s*['"]?EOF/i);
    if (heredocMatch) return `${heredocMatch[1]} -e "..." (script)`;
    // Take first non-empty, non-comment line only
    const firstLine = raw.split("\n").map(l => l.trim()).find(l => l.length > 0 && !l.startsWith("#")) ?? raw;
    // Truncate
    return firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : firstLine;
  }

  switch (toolName) {
    case "Read":      return `📄 \`${filePath}\``;
    case "Write":     return `✏️ Write \`${filePath}\``;
    case "Edit":      return `✏️ Edit \`${filePath}\``;
    case "Glob":      return `🔍 Glob \`${str(input.pattern)}\``;
    case "Grep":      return `🔍 Grep \`${str(input.pattern, 50)}\`${input.path ? ` in \`${str(input.path, 30)}\`` : ""}`;
    case "Bash":      return `💻 \`${summariseBash(input.command)}\``;
    case "WebSearch": return `🌐 Search: "${str(input.query, 80)}"`;
    case "WebFetch":  return `🌐 Fetch: ${str(input.url, 80).replace("https://", "")}`;
    case "Agent":     return `🤖 Agent: ${str(input.description ?? input.prompt, 80)}`;
    case "TodoWrite": return `📋 Updated task list`;
    default: {
      if (toolName.startsWith("mcp__")) {
        const parts = toolName.split("__");
        const server = parts[1] ?? "";
        const tool = parts.slice(2).join("_").replace(/_/g, " ");
        const serverEmojis: Record<string, string> = {
          "railway": "🚂",
          "kern-google": "📧",
          "supabase-memory": "🧠",
          "github": "🐙",
          "kern-github": "🐙",
        };
        const emoji = serverEmojis[server] ?? "⚙️";
        const extra = input.account ? ` (${String(input.account)})`
          : input.query ? `: "${str(input.query, 40)}"`
          : input.serviceId ? " (Railway)"
          : "";
        return `${emoji} ${server}: ${tool}${extra}`;
      }
      return `🔧 ${toolName}`;
    }
  }
}

// H3: Shared allowlist of env vars agents are permitted to access (used by both Discord and HTTP paths)
// IMPORTANT: Do NOT add ANTHROPIC_API_KEY here. If Railway has a stale API key,
// it conflicts with CLAUDE_CODE_OAUTH_TOKEN and causes 401 errors.
// Claude Code must use OAuth (Max subscription) only.
const ALLOWED_ENV_KEYS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ACCESS_TOKEN',
  'SUPABASE_ANON_KEY',
  'OPENAI_API_KEY',
  'GITHUB_TOKEN',
  'MCP_API_KEY',
  'APOLLO_API_KEY',
  'INSTANTLY_API_KEY',
  'SENDGRID_API_KEY',
  'RAILWAY_API_TOKEN',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_API_PROXY_KEY',
  'GOOGLE_API_PROXY_URL',
  'GROQ_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'BROWSERBASE_API_KEY',
  'XERO_CLIENT_ID',
  'XERO_CLIENT_SECRET',
  'XERO_REFRESH_TOKEN',
  'REONIC_API_KEY',
  'LATE_API_KEY',
  'VERCEL_TOKEN',
];

// Shape of a globally-queued session (waiting for a concurrency slot)
interface GlobalQueueEntry {
  channel: TextChannel;
  prompt: string;
  queueMsg: Message;
}

class SessionManager {
  private sessions = new Map<string, ActiveSession>();
  private startingChannels = new Set<string>(); // C1: guard against concurrent session starts
  private static readonly MAX_QUEUE_SIZE = 5;
  private static readonly MAX_CONCURRENT_SESSIONS = 3; // global cap across all channels
  private messageQueue = new Map<string, { channel: TextChannel; prompt: string }[]>();
  private pendingQueuePrompts = new Map<string, { channel: TextChannel; prompt: string }>();
  private globalQueue: GlobalQueueEntry[] = []; // overflow when MAX_CONCURRENT_SESSIONS hit

  async sendMessage(
    channel: TextChannel,
    prompt: string,
  ): Promise<void> {
    const channelId = channel.id;

    // C1: Prevent concurrent session starts on the same channel
    if (this.startingChannels.has(channelId)) {
      console.warn(`[session] Session already starting for ${channelId}, skipping`);
      return;
    }
    this.startingChannels.add(channelId);

    let project = getProject(channelId);

    // Threads inherit parent channel's project
    if (!project && channel.isThread && channel.isThread()) {
      const parentId = (channel as unknown as { parentId?: string }).parentId;
      if (parentId) {
        project = getProject(parentId);
      }
    }

    if (!project) {
      this.startingChannels.delete(channelId); // C1: release guard on early exit
      return;
    }

    const existingSession = this.sessions.get(channelId);
    // If no in-memory session, check DB for previous session_id (for bot restart resume)
    const dbSession = !existingSession ? getSession(channelId) : undefined;
    const dbId = existingSession?.dbId ?? dbSession?.id ?? randomUUID();
    const resumeSessionId = existingSession?.sessionId ?? dbSession?.session_id ?? undefined;

    // Update status to online
    upsertSession(dbId, channelId, resumeSessionId ?? null, "online");

    // Streaming state
    let responseBuffer = "";
    let fullResponse = ""; // Never cleared -- accumulates entire response for transcript logging
    let displayOffset = 0; // chars in responseBuffer already committed to previous (non-editable) Discord messages
    let lastEditTime = 0;
    const stopRow = createStopButton(channelId);
    const EDIT_INTERVAL = 1500; // ms between edits (Discord rate limit friendly)

    // Session timing (must be declared before SessionState construction)
    const startTime = Date.now();

    // V2 Components state tracking
    const sessionState = new SessionState(startTime);
    let isV2Mode = false; // set to true after V2 message is created (post-queue check)
    let lastV2ToolId: string | null = null;
    let v2Message: typeof currentMessage | null = null;

    // Throttled V2 render
    let lastV2RenderTime = 0;
    async function renderV2(): Promise<void> {
      if (!v2Message || !sessionState.isDirty()) return;
      const now = Date.now();
      if (now - lastV2RenderTime < EDIT_INTERVAL) return;
      lastV2RenderTime = now;
      sessionState.markClean();
      try {
        const { components } = buildV2Message(sessionState.getData(), channelId);
        await v2Message.edit({
          components: components.map((c: any) => typeof c.toJSON === "function" ? c.toJSON() : c),
          flags: MessageFlags.IsComponentsV2,
        } as any);
      } catch (e) {
        console.warn(`[v2-render] Failed:`, e instanceof Error ? e.message : e);
      }
    }

    let currentMessage = await channel.send({
      content: L("\u23f3 Thinking...", "\u23f3 \uc0dd\uac01 \uc911..."),
      components: [stopRow],
    });

    // Global concurrency cap -- hold if too many sessions are already running
    if (this.sessions.size >= SessionManager.MAX_CONCURRENT_SESSIONS) {
      const position = this.globalQueue.length + 1;
      this.globalQueue.push({ channel, prompt, queueMsg: currentMessage });
      const activeSessions = this.sessions.size;
      await currentMessage.edit({
        content: `🕐 Queued (position ${position}, ${activeSessions} sessions active) -- will start automatically when a slot opens.`,
        components: [],
      });
      console.log(`[concurrency] Queued ${channelId} (position ${position}, ${activeSessions} active)`);
      this.startingChannels.delete(channelId); // C1: release guard when queued (will re-enter via sendMessage later)
      return;
    }

    // Initialize V2 Components display (after queue check)
    try {
      const initialV2 = buildV2Message(sessionState.getData(), channelId);
      v2Message = await channel.send({
        components: initialV2.components.map((c: any) => typeof c.toJSON === "function" ? c.toJSON() : c),
        flags: MessageFlags.IsComponentsV2,
      } as any);
      isV2Mode = true;
      // Hide the old "Thinking..." message
      await currentMessage.edit({ content: "\u200b", components: [] }).catch(() => {});
      currentMessage = v2Message;
    } catch (e) {
      console.warn(`[v2-init] Failed to create V2 message, falling back to legacy:`, e instanceof Error ? e.message : e);
      // isV2Mode stays false, legacy path works
    }

    // Create task log thread for real-time visibility
    // Skip if already inside a thread (Discord doesn't allow nested threads)
    type ThreadLike = { send: (content: string) => Promise<unknown>; setArchived: (v: boolean) => Promise<unknown> };
    let taskThread: ThreadLike | null = null;
    if (!(channel.isThread && channel.isThread())) {
      try {
        const rawName = prompt.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
        const threadName = `🔧 ${rawName}`.slice(0, 100);
        taskThread = await (currentMessage as unknown as {
          startThread: (opts: { name: string; autoArchiveDuration: number }) => Promise<ThreadLike>;
        }).startThread({ name: threadName, autoArchiveDuration: 60 });
      } catch (e) {
        console.warn("[thread] Failed to create task thread:", e instanceof Error ? e.message : e);
      }
    }

    async function logToThread(line: string): Promise<void> {
      if (!taskThread) return;
      try { await taskThread.send(line); } catch { /* thread may be unavailable, ignore */ }
    }

    // Batching state: collapse consecutive Read/Glob/Grep into a single summary line
    const BATCHED_TOOLS = new Set(["Read", "Glob", "Grep"]);
    let batchTool = "";
    let batchCount = 0;
    let batchFlushTimeout: ReturnType<typeof setTimeout> | null = null;

    async function flushBatch(): Promise<void> {
      if (!batchTool || batchCount === 0) return;
      const emoji = batchTool === "Read" ? "📄" : "🔍";
      const label = batchTool === "Read" ? "Read" : "Searched";
      await logToThread(`${emoji} ${label} ${batchCount} file${batchCount > 1 ? "s" : ""}`);
      batchTool = "";
      batchCount = 0;
    }

    async function threadLog(toolName: string, input: Record<string, unknown>): Promise<void> {
      if (BATCHED_TOOLS.has(toolName)) {
        // Flush if switching tool type within the batch group
        if (batchTool && batchTool !== toolName) await flushBatch();
        batchTool = toolName;
        batchCount++;
        // Auto-flush after 2s of no further batched calls
        if (batchFlushTimeout) clearTimeout(batchFlushTimeout);
        batchFlushTimeout = setTimeout(() => { void flushBatch(); }, 2000);
      } else {
        // Flush any pending batch first
        if (batchFlushTimeout) { clearTimeout(batchFlushTimeout); batchFlushTimeout = null; }
        await flushBatch();
        // Log significant action immediately
        await logToThread(`\`${toolUseCount}\` ${buildThreadLog(toolName, input)}`);
      }
    }

    // Activity tracking for progress display
    let lastActivity = L("Thinking...", "생각 중...");
    let toolUseCount = 0;
    let hasTextOutput = false;
    let hasResult = false;
    let lastStreamTime = 0; // tracks last time text was actively streaming
    let isAgentRunning = false; // true when a top-level Agent tool is in flight (suppresses subagent status)

    // Track pending tool calls so we can emit tool_call_end when the next event arrives
    let pendingToolCall: { toolName: string; startTime: number } | null = null;
    let streamedTextForCurrentTurn = false; // true when stream_events delivered text for current turn (skip assistant text dupe)
    let needsNewMessage = false; // lazy new message creation after announcements (BUG 4)
    let lastCheckpointTime = startTime; // tracks last checkpoint message sent
    let rateLimitedUntil = 0; // epoch ms -- stall detector suspends while rate limited
    let toolApprovedAt = 0; // epoch ms -- set when canUseTool returns allow, cleared on next iterator message
    const MAX_TOOL_EXECUTION_MS = 10 * 60 * 1000; // 10 min -- hard cap for single tool execution before we consider it a hang

    // Heartbeat timer - updates status every 15s throughout entire task
    const heartbeatInterval = setInterval(async () => {
      if (hasResult) return;

      // V2 mode: just trigger a re-render (state already has timing info)
      if (isV2Mode) { void renderV2(); return; }

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

      // If text is actively streaming right now, skip to avoid edit conflicts
      const isActivelyStreaming = hasTextOutput && (Date.now() - lastStreamTime < 3000);
      if (isActivelyStreaming) return;

      // After 3 minutes: send NEW checkpoint messages every 2 minutes so the user gets pinged
      if (mins >= 3 && (Date.now() - lastCheckpointTime) >= 2 * 60 * 1000) {
        lastCheckpointTime = Date.now();
        try {
          const checkpointExtra = rateLimitedUntil > Date.now() ? " (rate limited, waiting)" : "";
          await channel.send(`⏳ Still working (${timeStr}, ${toolUseCount} tools used${checkpointExtra}) -- ${lastActivity}`);
        } catch (e) {
          console.warn(`[checkpoint] Failed to send checkpoint for ${channelId}:`, e instanceof Error ? e.message : e);
        }
        return;
      }

      // Under 3 minutes or between checkpoints: edit the status message
      // Show rate limit state so the user knows it's waiting, not dead
      const rateLimitLabel = rateLimitedUntil > Date.now()
        ? ` | ⏸️ rate limited, ${Math.ceil((rateLimitedUntil - Date.now()) / 1000)}s`
        : "";
      const toolInFlightLabel = toolApprovedAt > 0
        ? " | running tool..."
        : "";
      try {
        await currentMessage.edit({
          content: `⏳ ${lastActivity} (${timeStr}) [${toolUseCount} tools used${rateLimitLabel}${toolInFlightLabel}]`,
          components: [stopRow],
        });
      } catch (e) {
        console.warn(`[heartbeat] Failed to edit message for ${channelId}:`, e instanceof Error ? e.message : e);
      }
    }, 15_000);

    // Stall detector: hard-kill + notify if no activity for 300s
    let lastActivityTime = Date.now();
    const STALL_THRESHOLD_MS = 300 * 1000; // 300s (5 min) -- subagents, rate-limit recovery, and API retries need room
    let stalledQueryInstance: Query | null = null;
    let stallDetected = false; // prevents repeated stall messages
    const abortController = new AbortController();
    const overallTimeout = setInterval(async () => {
      if (hasResult || stallDetected) return;
      // Don't stall-detect while rate limited -- SDK is waiting to retry
      if (Date.now() < rateLimitedUntil) return;
      // Don't stall-detect while a tool is actively executing (e.g. npm install, build commands can take 5-10 min)
      // Exception: if the tool has been executing for >10 min, treat it as a hang and stall-detect anyway
      if (toolApprovedAt > 0 && (Date.now() - toolApprovedAt) < MAX_TOOL_EXECUTION_MS) {
        lastActivityTime = Date.now(); // keep the timer alive so stall doesn't fire right after tool finishes
        return;
      }
      // After a rate limit, start the countdown from when the limit EXPIRED,
      // not from when the event arrived. Prevents false stalls post-rate-limit.
      const effectiveLastActivity = Math.max(lastActivityTime, rateLimitedUntil);
      const timeSinceActivity = Date.now() - effectiveLastActivity;
      // Before any activity (0 tools, no text), use a longer threshold -- MCP server init + first API
      // response on large context can legitimately take several minutes on cold start.
      const activeThreshold = (toolUseCount === 0 && !hasTextOutput)
        ? 5 * 60 * 1000  // 5 min grace on cold start
        : STALL_THRESHOLD_MS; // 300s once active
      if (timeSinceActivity >= activeThreshold) {
        stallDetected = true;
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        const thresholdLabel = toolUseCount === 0 && !hasTextOutput ? "300s cold-start" : "300s";
        console.warn(`[stall] Session stalled for ${channelId}: ${mins}m ${secs}s elapsed, ${toolUseCount} tools used, threshold=${thresholdLabel}`);
        // Hard-kill the session: close() forcefully terminates the subprocess
        if (stalledQueryInstance) {
          try { stalledQueryInstance.close(); } catch { /* ignore */ }
        }
        // Also signal the abort controller as a backup kill mechanism
        abortController.abort();
        // Clean up session from in-memory map so retries don't get queued
        this.sessions.delete(channelId);
        updateSessionStatus(channelId, "idle");
        await channel.send(
          `\u26a0\ufe0f **Session stalled** (${mins}m ${secs}s, no activity for ${thresholdLabel}, ${toolUseCount} tools used). Stopped automatically -- just send your message again to retry.`
        ).catch(() => {});
      }
    }, 15_000); // check every 15s so stalls are caught promptly

    // For new sessions, inject memory context loading instruction
    const effectivePrompt = resumeSessionId
      ? prompt
      : `[New session. Before responding, call memory_timeline for this project to load recent context.]\n\n${prompt}`;

    // Log which auth method is available so we can debug auth issues
    const authMethod = process.env.CLAUDE_CODE_OAUTH_TOKEN
      ? `OAuth (set, len=${process.env.CLAUDE_CODE_OAUTH_TOKEN.length})`
      : "NONE";
    console.log(`[auth] Spawning Claude Code with auth: ${authMethod}`);

    try {
      const queryInstance = query({
        prompt: effectivePrompt,
        options: {
          model: "claude-opus-4-6",
          effort: "max" as any,
          cwd: project.project_path,
          permissionMode: "default",
          env: {
            ...Object.fromEntries(
              ALLOWED_ENV_KEYS
                .filter(k => process.env[k] !== undefined)
                // Strip ALL control characters (0x00-0x1F, 0x7F) and trim whitespace.
                // Railway dashboard sometimes embeds invisible chars on paste, which
                // breaks HTTP header values (e.g. in 'Authorization: Bearer ...').
                // trim() alone isn't enough -- embedded control chars persist.
                .map(k => {
                  const raw = process.env[k]!;
                  const sanitized = raw.replace(/[\x00-\x1F\x7F]/g, "").trim();
                  if (raw !== sanitized && k.includes("TOKEN")) {
                    console.warn(`[auth] ${k} had ${raw.length - sanitized.length} invalid chars stripped (raw len=${raw.length}, clean len=${sanitized.length})`);
                  }
                  return [k, sanitized];
                })
            ),
            PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
            CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: "600", // 10 minutes -- prevents silent stream close on long tools
          },
          abortController,
          ...(resumeSessionId ? { resume: resumeSessionId } : {}),

          canUseTool: async (
            toolName: string,
            input: Record<string, unknown>,
          ) => {
            toolUseCount++;
            lastActivityTime = Date.now(); // reset stall timer on every tool call

            // Track Agent tool depth for subagent status suppression
            if (toolName === "Agent") {
              isAgentRunning = true;
            }

            // Close previous tool call (emit tool_call_end) before starting a new one
            if (pendingToolCall) {
              broadcast(channelId, {
                type: "tool_call_end",
                sessionId: dbId,
                toolName: pendingToolCall.toolName,
                durationMs: Date.now() - pendingToolCall.startTime,
              }).catch(() => {});
            }
            pendingToolCall = { toolName, startTime: Date.now() };

            // Broadcast tool_call_start event
            broadcast(channelId, {
              type: "tool_call_start",
              sessionId: dbId,
              toolName,
              input,
            }).catch(() => {});

            // Tool activity labels for Discord display
            const toolLabels: Record<string, string> = {
              Read: L("Reading files", "파일 읽는 중"),
              Glob: L("Searching files", "파일 검색 중"),
              Grep: L("Searching code", "코드 검색 중"),
              Write: L("Writing file", "파일 작성 중"),
              Edit: L("Editing file", "파일 편집 중"),
              Bash: L("Running command", "명령어 실행 중"),
              WebSearch: L("Searching web", "웹 검색 중"),
              WebFetch: L("Fetching URL", "URL 가져오는 중"),
              TodoWrite: L("Updating tasks", "작업 업데이트 중"),
            };

            // When an Agent tool is running and this is a subagent tool, skip status display update
            // but still count the tool and log to thread
            const isSubagentTool = isAgentRunning && toolName !== "Agent";
            if (!isSubagentTool) {
              const filePath = typeof input.file_path === "string"
                ? ` \`${(input.file_path as string).split(/[\\/]/).pop()}\``
                : "";
              lastActivity = `${toolLabels[toolName] ?? `Using ${toolName}`}${filePath}`;
            }

            // Log to task thread with smart batching
            void threadLog(toolName, input);

            // V2 state tracking: close previous tool, open new one
            if (lastV2ToolId) sessionState.handleToolEnd(lastV2ToolId);
            sessionState.handleToolStart(toolName, input, isSubagentTool);
            lastV2ToolId = sessionState.getLastToolId();
            void renderV2();

            // Update status message -- but only if text isn't actively streaming (avoid edit conflicts)
            // Skip status update for subagent tools (keep showing parent-level status)
            // Skip when V2 mode is active (V2 message handles status display)
            const isStreaming = hasTextOutput && (Date.now() - lastStreamTime < 3000);
            if (!isV2Mode && !isStreaming && !isSubagentTool) {
              const elapsed = Math.round((Date.now() - startTime) / 1000);
              const timeStr = elapsed > 60
                ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
                : `${elapsed}s`;
              try {
                await currentMessage.edit({
                  content: `\u23f3 ${lastActivity} (${timeStr}) [${toolUseCount} tools used]`,
                  components: [stopRow],
                });
              } catch (e) {
                console.warn(`[tool-status] Failed to edit message for ${channelId}:`, e instanceof Error ? e.message : e);
              }
            }

            // Handle AskUserQuestion with interactive Discord UI
            if (toolName === "AskUserQuestion") {
              const questions = (input.questions as AskQuestionData[]) ?? [];
              if (questions.length === 0) {
                return { behavior: "allow" as const, updatedInput: input };
              }

              const answers: Record<string, string> = {};

              for (let qi = 0; qi < questions.length; qi++) {
                const q = questions[qi];
                const qRequestId = randomUUID();
                const { embed, components } = createAskUserQuestionEmbed(
                  q,
                  qRequestId,
                  qi,
                  questions.length,
                );

                updateSessionStatus(channelId, "waiting");
                await channel.send({ embeds: [embed], components });

                const answer = await new Promise<string | null>((resolve) => {
                  const timeout = setTimeout(() => {
                    pendingQuestions.delete(qRequestId);
                    // Clean up custom input if pending
                    const ci = pendingCustomInputs.get(channelId);
                    if (ci?.requestId === qRequestId) {
                      pendingCustomInputs.delete(channelId);
                    }
                    resolve(null);
                  }, 5 * 60 * 1000);

                  pendingQuestions.set(qRequestId, {
                    resolve: (ans) => {
                      clearTimeout(timeout);
                      pendingQuestions.delete(qRequestId);
                      resolve(ans);
                    },
                    channelId,
                  });
                });

                if (answer === null) {
                  updateSessionStatus(channelId, "online");
                  return {
                    behavior: "deny" as const,
                    message: L("Question timed out", "질문 시간 초과"),
                  };
                }

                answers[q.header] = answer;
              }

              updateSessionStatus(channelId, "online");
              toolApprovedAt = Date.now();
              return {
                behavior: "allow" as const,
                updatedInput: { ...input, answers },
              };
            }

            // Auto-approve read-only tools
            const readOnlyTools = ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite"];
            if (readOnlyTools.includes(toolName)) {
              toolApprovedAt = Date.now();
              return { behavior: "allow" as const, updatedInput: input };
            }

            // Check auto-approve setting
            const currentProject = getProject(channelId);
            if (currentProject?.auto_approve) {
              toolApprovedAt = Date.now();
              return { behavior: "allow" as const, updatedInput: input };
            }

            // Ask user via Discord buttons
            const requestId = randomUUID();
            const { embed, row } = createToolApprovalEmbed(
              toolName,
              input,
              requestId,
            );

            updateSessionStatus(channelId, "waiting");
            await channel.send({
              embeds: [embed],
              components: [row],
            });

            // Wait for user decision (timeout 5 min)
            return new Promise((resolve) => {
              const timeout = setTimeout(() => {
                pendingApprovals.delete(requestId);
                updateSessionStatus(channelId, "online");
                resolve({ behavior: "deny" as const, message: "Approval timed out" });
              }, 5 * 60 * 1000);

              pendingApprovals.set(requestId, {
                resolve: (decision) => {
                  clearTimeout(timeout);
                  pendingApprovals.delete(requestId);
                  updateSessionStatus(channelId, "online");
                  if (decision.behavior === "allow") toolApprovedAt = Date.now();
                  resolve(
                    decision.behavior === "allow"
                      ? { behavior: "allow" as const, updatedInput: input }
                      : { behavior: "deny" as const, message: decision.message ?? "Denied by user" },
                  );
                },
                channelId,
              });
            });
          },
        },
      });

      // Store the active session + wire stall detector
      stalledQueryInstance = queryInstance;
      this.sessions.set(channelId, {
        queryInstance,
        channelId,
        sessionId: resumeSessionId ?? null,
        dbId,
      });
      console.log(`[session] Query created for ${channelId}, entering message loop`);

      for await (const message of queryInstance) {
        // First message from iterator -- subprocess is alive and producing output
        if (!hasTextOutput && toolUseCount === 0) {
          console.log(`[session] First message received for ${channelId} (type=${message.type}, ${Date.now() - startTime}ms since start)`);
        }
        // Clear in-flight flag ONLY if no Agent subagent is running.
        // When an Agent tool is executing, the parent stream emits sporadic system messages
        // (task_progress, notifications) but the tool hasn't actually finished. Clearing
        // toolApprovedAt on those messages removes stall suppression, causing false stalls
        // during the inevitable gaps between sporadic system events.
        if (!isAgentRunning) {
          toolApprovedAt = 0;
        }
        lastActivityTime = Date.now(); // reset stall timer on ANY message from the iterator

        // Handle rate limit events -- suspend stall detector so we don't kill legitimate waits
        if (message.type === "rate_limit_event") {
          const retryMs = (message as { retry_after_ms?: number }).retry_after_ms;
          const waitMs = retryMs ?? 60_000; // default 60s if not specified
          rateLimitedUntil = Date.now() + waitMs + 10_000; // +10s buffer
          console.warn(`[rate-limit] Rate limited for ${channelId}, retry in ${Math.ceil(waitMs / 1000)}s (explicit=${retryMs != null})`);
          // Only notify in Discord if the wait is explicitly specified and significant (>10s)
          // The event fires even for non-blocking "soft" rate limit warnings
          if (retryMs != null && retryMs > 10_000) {
            const retryS = Math.ceil(retryMs / 1000);
            try {
              await channel.send(`⏸️ Rate limited -- waiting ${retryS}s before retrying. Will resume automatically.`);
            } catch { /* ignore */ }
          }
        }

        // Clear rate limit flag on any assistant activity (text or tool_use blocks)
        // or stream events -- the SDK has no top-level "tool_use" message type;
        // tool uses arrive as content blocks inside assistant messages.
        if (
          message.type === "assistant" ||
          message.type === "stream_event" ||
          message.type === "tool_progress"
        ) {
          if (rateLimitedUntil > 0) {
            console.log(`[rate-limit] Rate limit cleared for ${channelId}, resuming`);
            rateLimitedUntil = 0;
          }
        }

        // Capture session ID
        if (
          message.type === "system" &&
          "subtype" in message &&
          message.subtype === "init"
        ) {
          const sdkSessionId = (message as { session_id?: string }).session_id;
          if (sdkSessionId) {
            const active = this.sessions.get(channelId);
            if (active) active.sessionId = sdkSessionId;
            upsertSession(dbId, channelId, sdkSessionId, "online");
          }
          // Broadcast session_start (threadId is channelId for Discord sessions)
          broadcast(channelId, { type: "session_start", sessionId: dbId, threadId: channelId }).catch(() => {});
        }

        // Route all system subtypes to V2 state tracker + thread log
        if (message.type === "system" && "subtype" in message) {
          const sysMsg = message as Record<string, unknown>;
          const subtype = sysMsg.subtype as string;
          switch (subtype) {
            case "task_started":
              sessionState.handleTaskStarted(sysMsg.task_id as string, sysMsg.description as string, (sysMsg.task_type as string) ?? undefined, (sysMsg.workflow_name as string) ?? undefined);
              void logToThread(`\u{1F916} Task started: ${(sysMsg.description as string).slice(0, 80)}`);
              void renderV2();
              break;
            case "task_progress":
              sessionState.handleTaskProgress(sysMsg.task_id as string, sysMsg.description as string, sysMsg.usage ?? {}, (sysMsg.last_tool_name as string) ?? undefined, (sysMsg.summary as string) ?? undefined);
              void renderV2();
              break;
            case "task_updated":
              sessionState.handleTaskUpdated(sysMsg.task_id as string, (sysMsg.patch as Record<string, unknown>) ?? {});
              void renderV2();
              break;
            case "task_notification": {
              const tnStatus = sysMsg.status as string;
              const tnSummary = (sysMsg.summary as string) ?? "";
              sessionState.handleTaskNotification(sysMsg.task_id as string, tnStatus as any, tnSummary, sysMsg.usage ?? undefined);
              const tnEmoji = tnStatus === "completed" ? "\u2705" : tnStatus === "failed" ? "\u274c" : "\u23f9\ufe0f";
              void logToThread(`${tnEmoji} Task ${tnStatus}: ${tnSummary.slice(0, 100)}`);
              void renderV2();
              break;
            }
            case "compact_boundary": {
              const cm = (sysMsg.compact_metadata as Record<string, unknown>) ?? {};
              sessionState.handleCompactBoundary(cm as any);
              const pre = Math.round(((cm.pre_tokens as number) ?? 0) / 1000);
              const post = Math.round(((cm.post_tokens as number) ?? 0) / 1000);
              void logToThread(`\u{1F4E6} Compacted: ${pre}k \u2192 ${post}k tokens (checkpoint saved)`);
              void renderV2();
              break;
            }
            case "status":
              sessionState.handleStatusChange(sysMsg.status as string, (sysMsg.compact_result as string) ?? undefined);
              if (sysMsg.status === "compacting") {
                void saveCheckpoint({
                  channelId,
                  prompt,
                  fullResponse,
                  toolUseCount,
                  projectPath: project.project_path,
                  compactionCount: sessionState.getData().compactionCount,
                  sessionId: this.sessions.get(channelId)?.sessionId ?? null,
                }).catch(err => console.error("[checkpoint] Error:", err instanceof Error ? err.message : err));
                void logToThread("\u{1F4BE} Auto-checkpoint saved before compaction");
              }
              void renderV2();
              break;
            case "api_retry":
              sessionState.handleApiRetry(sysMsg.attempt as number, sysMsg.max_retries as number, sysMsg.retry_delay_ms as number, (sysMsg.error_status as number) ?? null);
              void logToThread(`\u{1F504} API retry ${sysMsg.attempt}/${sysMsg.max_retries} (${sysMsg.retry_delay_ms}ms delay)`);
              void renderV2();
              break;
            case "hook_started":
            case "hook_progress":
            case "hook_response":
              sessionState.handleHookEvent(subtype.replace("hook_", ""), sysMsg.hook_name as string, sysMsg.hook_event as string, (sysMsg.output as string) ?? undefined, (sysMsg as any).outcome ?? undefined);
              if (subtype === "hook_response") void logToThread(`\u{1FA9D} Hook ${sysMsg.hook_name}: ${(sysMsg as any).outcome ?? "done"}`);
              void renderV2();
              break;
            case "notification": {
              const nText = sysMsg.text as string;
              const nPriority = sysMsg.priority as string;
              sessionState.handleNotification(sysMsg.key as string, nText, nPriority);
              if (nPriority === "high" || nPriority === "immediate") void logToThread(`\u26a0\ufe0f ${nText}`);
              void renderV2();
              break;
            }
            case "session_state_changed":
              sessionState.handleSessionStateChanged(sysMsg.state as string);
              break;
            case "memory_recall": {
              const mrMemories = (sysMsg.memories as unknown[]) ?? [];
              sessionState.handleMemoryRecall(sysMsg.mode as string, mrMemories);
              void logToThread(`\u{1F9E0} Loaded ${mrMemories.length} memories (${sysMsg.mode})`);
              break;
            }
            case "files_persisted":
              void logToThread(`\u{1F4BE} ${((sysMsg.files as unknown[]) ?? []).length} files persisted`);
              break;
            case "local_command_output":
              void logToThread(`\u{1F4DF} ${(sysMsg.content as string).slice(0, 200)}`);
              break;
            case "elicitation_complete":
              break;
            // "init" is handled above
          }
        }

        // Handle non-system SDK message types for V2 state tracking
        if (message.type === "tool_progress") {
          const tp = message as Record<string, unknown>;
          sessionState.handleToolProgress(tp.tool_use_id as string, tp.tool_name as string, tp.elapsed_time_seconds as number);
          void renderV2();
        }
        if (message.type === "tool_use_summary") {
          const ts = message as Record<string, unknown>;
          sessionState.handleToolUseSummary(ts.summary as string);
          void logToThread(`\u{1F4DD} ${(ts.summary as string).slice(0, 200)}`);
          void renderV2();
        }
        if (message.type === "auth_status") {
          const authMsg = message as Record<string, unknown>;
          sessionState.handleAuthStatus(authMsg.isAuthenticating as boolean, (authMsg.output as string[]) ?? [], (authMsg.error as string) ?? undefined);
          if (authMsg.error) void logToThread(`\u{1F511} Auth error: ${authMsg.error}`);
          void renderV2();
        }
        if (message.type === "prompt_suggestion") {
          void logToThread(`\u{1F4A1} Suggestion: ${((message as Record<string, unknown>).suggestion as string).slice(0, 100)}`);
        }

        // Handle stream_event for real-time text streaming (BUG 1)
        // stream_event arrives BEFORE the complete assistant message and contains incremental text deltas.
        // Only process main-thread events (parent_tool_use_id is null/undefined) to avoid subagent text noise.
        if (message.type === "stream_event") {
          const streamMsg = message as unknown as { event?: Record<string, unknown>; parent_tool_use_id?: string };
          if (!streamMsg.parent_tool_use_id && streamMsg.event) {
            const evt = streamMsg.event;
            // content_block_delta with text_delta contains incremental text
            if (evt.type === "content_block_delta") {
              const delta = evt.delta as { type?: string; text?: string } | undefined;
              if (delta?.type === "text_delta" && typeof delta.text === "string") {
                // V2 -> legacy transition: freeze V2 status, create legacy message for streaming
                if (isV2Mode && !hasTextOutput && v2Message) {
                  if (lastV2ToolId) { sessionState.handleToolEnd(lastV2ToolId); lastV2ToolId = null; }
                  sessionState.handleTextDelta("");
                  try {
                    const { components: v2Comps } = buildV2Message(sessionState.getData(), channelId);
                    await v2Message.edit({
                      components: v2Comps.map((c: any) => typeof c.toJSON === "function" ? c.toJSON() : c),
                      flags: MessageFlags.IsComponentsV2,
                    } as any);
                  } catch (e) { console.warn(`[v2-transition] Failed:`, e instanceof Error ? e.message : e); }
                  currentMessage = await channel.send({ content: "...", components: [stopRow] });
                  isV2Mode = false;
                }
                responseBuffer += delta.text;
                fullResponse += delta.text;
                hasTextOutput = true;
                streamedTextForCurrentTurn = true;
                lastStreamTime = Date.now();
                lastActivityTime = Date.now();
                // Broadcast text chunk for Bot Interface
                broadcast(channelId, {
                  type: "text_chunk",
                  sessionId: dbId,
                  content: delta.text,
                }).catch(() => {});
              }
            }
          }
        }

        // Handle complete assistant turn messages
        // The Claude Agent SDK yields assistant messages as:
        //   { type: "assistant", message: { content: [...] }, session_id, uuid }
        // NOT as { type: "assistant", content: [...] }
        // We need to extract text from message.message.content
        if (message.type === "assistant") {
          // Clear isAgentRunning when a main-thread assistant message arrives (agent returned)
          const assistantMsg = message as { parent_tool_use_id?: string };
          if (!assistantMsg.parent_tool_use_id) {
            isAgentRunning = false;
          }

          // Only extract text from assistant messages if stream_events didn't already deliver it.
          // stream_events provide incremental text; assistant messages contain the complete turn.
          // Processing both would double the text in the buffer.
          if (!streamedTextForCurrentTurn) {
            const msg = message as Record<string, unknown>;
            // Try both paths: direct content (legacy) and nested message.content (SDK format)
            const innerMsg = msg.message as Record<string, unknown> | undefined;
            const content = (msg.content ?? innerMsg?.content) as unknown[] | undefined;

            if (Array.isArray(content)) {
              for (const block of content as Record<string, unknown>[]) {
                if ("text" in block && typeof block.text === "string") {
                  responseBuffer += block.text;
                  fullResponse += block.text;
                  hasTextOutput = true;
                  lastStreamTime = Date.now();
                  lastActivityTime = Date.now(); // reset stall timer on text output
                  // Broadcast text chunk for Bot Interface
                  broadcast(channelId, {
                    type: "text_chunk",
                    sessionId: dbId,
                    content: block.text,
                  }).catch(() => {});
                }
              }
            }
          }
          // Reset for the next turn
          streamedTextForCurrentTurn = false;
        }

        // Announcement detection and throttled edit -- runs for BOTH stream_event and assistant messages
        // whenever there's text in the buffer to display.
        if (hasTextOutput && responseBuffer.length > 0) {
          // Extract and post agent announcement lines as standalone messages.
          // Match lines starting with 🤖 (or bold-wrapped **🤖...**).
          // Uses $ (end of line) with m flag to match complete lines during streaming.
          // The hasPendingAnnouncement guard below prevents incomplete announcements from
          // leaking into throttled edits, so we don't need (?=\n) lookahead.
          const announcementRegex = /^\*{0,2}🤖.+$/gm;
          const announcements = responseBuffer.match(announcementRegex);
          let announcementsProcessed = false;
          if (announcements) {
            announcementsProcessed = true;
            // Split buffer precisely around announcements (BUG 7):
            //   preText  -> freeze in old message
            //   announcement lines -> send as standalone messages
            //   postText -> buffer for next message (created lazily)
            const robotIdx = responseBuffer.search(/^\*{0,2}🤖/m);
            // For multiple announcements, find end of last one
            const lastAnnouncement = announcements[announcements.length - 1];
            const lastIdx = responseBuffer.lastIndexOf(lastAnnouncement);
            const afterLastIdx = lastIdx + lastAnnouncement.length;
            // Find the newline after the last announcement
            const newlineAfterLast = responseBuffer.indexOf("\n", afterLastIdx);
            const preText = robotIdx > displayOffset ? responseBuffer.slice(displayOffset, robotIdx).trim() : "";
            const postText = newlineAfterLast >= 0 ? responseBuffer.slice(newlineAfterLast + 1).replace(/^\n+/, "") : "";

            // Freeze old message with pre-announcement text (BUG 3: keep stop button)
            try {
              if (preText) {
                const preChunks = splitMessage(preText);
                await currentMessage.edit({ content: preChunks[0], components: [stopRow] });
              } else {
                await currentMessage.edit({ content: L("⏳ Working...", "⏳ 작업 중..."), components: [stopRow] });
              }
            } catch { /* ignore edit failure */ }

            // Send each announcement as a standalone message (BUG 9: only strip bold wrapping)
            for (const announcement of announcements) {
              try {
                const cleaned = announcement.replace(/^\*{2}(🤖.+)\*{2}$/, "$1").trim();
                await channel.send(cleaned);
              } catch (e) {
                console.warn(`[announcement] Failed to send for ${channelId}:`, e instanceof Error ? e.message : e);
              }
            }

            // Set buffer to ONLY post-announcement text (BUG 7: clean split)
            responseBuffer = postText;
            displayOffset = 0; // reset since buffer was reset

            // BUG 4: Don't create a new message immediately with "..." placeholder.
            // Instead, set a flag so the next text chunk creates the message lazily.
            if (postText) {
              try {
                currentMessage = await channel.send({ content: postText, components: [stopRow] });
                lastEditTime = Date.now();
                needsNewMessage = false;
              } catch (e) {
                console.warn(`[announcement] Failed to create post-announcement message for ${channelId}:`, e instanceof Error ? e.message : e);
              }
            } else {
              needsNewMessage = true;
            }
          }

          // Throttled message edit (BUG 10: skip if announcements were just processed)
          // Block the edit while a 🤖 announcement line is pending in the buffer.
          // This prevents the announcement from appearing in the main message body
          // before the announcement regex (above) can catch and send it standalone.
          if (!announcementsProcessed) {
            const pendingText = responseBuffer.slice(displayOffset);
            const hasPendingAnnouncement = /^\*{0,2}🤖/m.test(pendingText);
            const now = Date.now();
            if (now - lastEditTime >= EDIT_INTERVAL && pendingText.length > 0 && !hasPendingAnnouncement) {
              // BUG 4: If we need a new message (post-announcement), create it now with real content
              if (needsNewMessage) {
                try {
                  currentMessage = await channel.send({ content: pendingText.slice(0, 1990), components: [stopRow] });
                  lastEditTime = Date.now();
                  needsNewMessage = false;
                } catch (e) {
                  console.warn(`[stream] Failed to create deferred post-announcement message for ${channelId}:`, e instanceof Error ? e.message : e);
                }
              } else {
                lastEditTime = now;
                const chunks = splitMessage(pendingText);
                try {
                  // BUG 3: keep stop button during streaming
                  await currentMessage.edit({ content: chunks[0] || "...", components: [stopRow] });
                  // For overflow chunks: commit current message and send overflow as new messages
                  if (chunks.length > 1) {
                    displayOffset += chunks[0].length;
                    for (let i = 1; i < chunks.length - 1; i++) {
                      await channel.send(chunks[i]);
                      displayOffset += chunks[i].length;
                    }
                    // Last chunk becomes the new editable message
                    currentMessage = await channel.send({ content: chunks[chunks.length - 1], components: [stopRow] });
                  }
                  // Buffer is NOT cleared -- responseBuffer always holds full accumulated text
                } catch (e) {
                  console.warn(`[stream] Failed to edit message for ${channelId}, sending new:`, e instanceof Error ? e.message : e);
                  currentMessage = await channel.send(
                    chunks[chunks.length - 1] || "...",
                  );
                }
              }
            }
          }
        }

        // Handle result
        if ("result" in message) {
          const resultMsg = message as {
            result?: string;
            total_cost_usd?: number;
            duration_ms?: number;
          };

          // Close any running V2 tool and update V2 status message
          if (lastV2ToolId) { sessionState.handleToolEnd(lastV2ToolId); lastV2ToolId = null; }
          sessionState.handleResult(
            resultMsg.result ?? null,
            resultMsg.total_cost_usd ?? 0,
            resultMsg.duration_ms ?? 0,
            "subtype" in message && String((message as any).subtype).startsWith("error"),
            (resultMsg as any).num_turns,
          );
          if (v2Message) {
            try {
              const { components: v2ResultComps } = buildV2Message(sessionState.getData(), channelId);
              await v2Message.edit({
                components: v2ResultComps.map((c: any) => typeof c.toJSON === "function" ? c.toJSON() : c),
                flags: MessageFlags.IsComponentsV2,
              } as any);
            } catch (e) { console.warn(`[v2-result] Failed:`, e instanceof Error ? e.message : e); }
          }

          // Flush remaining buffer -- strip any 🤖 announcement lines still in the
          // buffer (e.g. if the final text chunk arrived without a throttled edit cycle
          // processing it before the result message arrived).
          const pendingFlush = responseBuffer.slice(displayOffset);
          if (pendingFlush.length > 0 || needsNewMessage) {
            const finalAnnouncementRegex = /^\*{0,2}🤖.+$/gm;
            const finalAnnouncements = pendingFlush.match(finalAnnouncementRegex);
            let flushText = pendingFlush;
            if (finalAnnouncements) {
              for (const ann of finalAnnouncements) {
                try {
                  // BUG 9: only strip bold wrapping, not all asterisks
                  await channel.send(ann.replace(/^\*{2}(🤖.+)\*{2}$/, "$1").trim());
                } catch (e) {
                  console.warn(`[announcement-flush] Failed to send for ${channelId}:`, e instanceof Error ? e.message : e);
                }
              }
              flushText = pendingFlush.replace(finalAnnouncementRegex, "").replace(/^\n+/, "");
            }
            if (flushText.length > 0) {
              // BUG 4: If we need a new message, create it for the final content
              if (needsNewMessage) {
                try {
                  currentMessage = await channel.send({ content: flushText.slice(0, 1990), components: [createCompletedButton()] });
                  needsNewMessage = false;
                } catch (e) {
                  console.warn(`[flush] Failed to create deferred message for ${channelId}:`, e instanceof Error ? e.message : e);
                }
              } else {
                const chunks = splitMessage(flushText);
                try {
                  // Merge flush + completed button into one edit to avoid flash
                  await currentMessage.edit({ content: chunks[0] || L("Done.", "완료."), components: [createCompletedButton()] });
                  for (let i = 1; i < chunks.length; i++) {
                    currentMessage = await channel.send(chunks[i]);
                  }
                } catch (e) {
                  console.warn(`[flush] Failed to edit final message for ${channelId}:`, e instanceof Error ? e.message : e);
                }
              }
            } else {
              // No text to flush, just swap stop button for completed
              try {
                await currentMessage.edit({ components: [createCompletedButton()] });
              } catch (e) {
                console.warn(`[complete] Failed to update completed button for ${channelId}:`, e instanceof Error ? e.message : e);
              }
            }
          } else {
            // Nothing pending -- just replace stop button with completed button
            try {
              await currentMessage.edit({ components: [createCompletedButton()] });
            } catch (e) {
              console.warn(`[complete] Failed to update completed button for ${channelId}:`, e instanceof Error ? e.message : e);
            }
          }

          // Send result embed
          // If text was already streamed live, don't repeat it in the embed --
          // just show metadata (cost, duration). Otherwise show full result text.
          const resultText = resultMsg.result ?? L("Task completed", "작업 완료");
          const embedText = hasTextOutput
            ? L("Task completed", "작업 완료")
            : resultText;
          const resultEmbed = createResultEmbed(
            embedText,
            resultMsg.total_cost_usd ?? 0,
            resultMsg.duration_ms ?? 0,
            getConfig().SHOW_COST,
          );
          await channel.send({ embeds: [resultEmbed] });

          // Detect auth/credit errors in result and suggest re-login
          const resultAuthKeywords = ["credit balance", "not authenticated", "unauthorized", "authentication", "login required", "auth token", "expired", "not logged in", "please run /login"];
          const lowerResult = resultText.toLowerCase();
          if (resultAuthKeywords.some((kw) => lowerResult.includes(kw))) {
            await channel.send(L(
              "🔑 Claude Code OAuth token expired or invalid. Update CLAUDE_CODE_OAUTH_TOKEN in Railway env vars. Do NOT run `claude login` locally -- it rotates the token.",
              "🔑 Claude Code OAuth 토큰이 만료되었거나 유효하지 않습니다. Railway 환경 변수에서 CLAUDE_CODE_OAUTH_TOKEN을 업데이트하세요.",
            ));
          }

          updateSessionStatus(channelId, "idle");
          hasResult = true;

          // Close the last pending tool call before session ends
          if (pendingToolCall) {
            broadcast(channelId, {
              type: "tool_call_end",
              sessionId: dbId,
              toolName: pendingToolCall.toolName,
              durationMs: Date.now() - pendingToolCall.startTime,
            }).catch(() => {});
            pendingToolCall = null;
          }

          // Broadcast text_complete and session_end for Bot Interface
          if (fullResponse.length > 0) {
            broadcast(channelId, {
              type: "text_complete",
              sessionId: dbId,
              fullContent: fullResponse,
            }).catch(() => {});
          }
          broadcast(channelId, {
            type: "session_end",
            sessionId: dbId,
            totalCostUsd: resultMsg.total_cost_usd ?? 0,
            durationMs: resultMsg.duration_ms ?? 0,
          }).catch(() => {});

          // Flush any pending batch, then archive thread
          if (batchFlushTimeout) { clearTimeout(batchFlushTimeout); batchFlushTimeout = null; }
          await flushBatch();
          if (taskThread) {
            try { await taskThread.setArchived(true); } catch { /* ignore */ }
          }

          // Capture response for transcript: prefer streamed text, fall back to result text
          const transcriptResponse = fullResponse.length > 0
            ? fullResponse
            : (resultMsg.result ?? "");

          // Buffer transcript exchange (flushes to Supabase after 10min idle)
          if (transcriptResponse.length > 0) {
            bufferTranscript({
              userMessage: prompt,
              assistantResponse: transcriptResponse,
              projectPath: project.project_path,
              channelId,
              sessionId: this.sessions.get(channelId)?.sessionId,
            });
          }
        }
      }

      // Detect silent iterator exit: loop ended but no result was delivered
      // This happens when the SDK stream closes unexpectedly without throwing
      if (!hasResult && !stallDetected) {
        console.warn(`[session] Iterator exited without result for ${channelId} (${toolUseCount} tools used)`);
        await channel.send(
          `\u26a0\ufe0f **Session ended unexpectedly** (no response received, ${toolUseCount} tools used). This is usually a temporary SDK issue -- just send your message again and it'll pick up where it left off.`
        ).catch(() => {});
        updateSessionStatus(channelId, "idle");
      }
    } catch (error) {
      isAgentRunning = false; // H5: defensive reset so stale flag doesn't leak
      // Skip error if stall detector already handled this (prevent duplicate error messages)
      if (stallDetected) {
        console.warn(`[session] Ignoring post-stall error for ${channelId}:`, error instanceof Error ? error.message : error);
        return;
      }
      // Skip error if result was already delivered (e.g., "Credit balance is too low" + exit code 1)
      if (hasResult) {
        console.warn(`[session] Ignoring post-result error for ${channelId}:`, error instanceof Error ? error.message : error);
        return;
      }
      const rawMsg =
        error instanceof Error ? error.message : "Unknown error occurred";

      // Parse API error JSON to show clean message
      let errMsg = rawMsg;
      const jsonMatch = rawMsg.match(
        /API Error: (\d+)\s*(\{.*\})/s,
      );
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[2]);
          const statusCode = jsonMatch[1];
          const message =
            parsed?.error?.message ?? parsed?.message ?? "Unknown error";
          errMsg = `API Error ${statusCode}: ${message}. Please try again later.`;
        } catch (parseErr) {
          console.warn(`[error-parse] Failed to parse API error JSON for ${channelId}:`, parseErr instanceof Error ? parseErr.message : parseErr);
          // Fall back to extracting just the status code
          errMsg = `API Error ${jsonMatch[1]}. Please try again later.`;
        }
      } else if (rawMsg.includes("process exited with code")) {
        errMsg = `${rawMsg}. The server may be temporarily unavailable — please try again later.`;
      }

      // Auto-recover from stale session: clear the dead session and retry fresh
      if (rawMsg.includes("No conversation found with session ID")) {
        console.log(`[session] Stale session for ${channelId}, clearing and retrying fresh`);
        deleteSession(channelId);
        // Retry without resume by re-calling sendMessage
        try {
          await currentMessage.edit({ content: "🔄 Session expired, starting fresh...", components: [] });
        } catch { /* ignore edit error */ }
        clearInterval(heartbeatInterval);
        clearInterval(overallTimeout);
        this.sessions.delete(channelId);
        // Clean up pending state before retry
        for (const [id, entry] of pendingApprovals) {
          if (entry.channelId === channelId) pendingApprovals.delete(id);
        }
        for (const [id, entry] of pendingQuestions) {
          if (entry.channelId === channelId) pendingQuestions.delete(id);
        }
        pendingCustomInputs.delete(channelId);
        return this.sendMessage(channel, prompt);
      }

      // Detect auth/credit errors and suggest re-login
      const authKeywords = ["credit balance", "not authenticated", "unauthorized", "authentication", "login required", "auth token", "expired", "not logged in", "please run /login"];
      const lowerMsg = rawMsg.toLowerCase();
      if (authKeywords.some((kw) => lowerMsg.includes(kw))) {
        errMsg += L(
          "\n\n🔑 Claude Code OAuth token expired or invalid. Update CLAUDE_CODE_OAUTH_TOKEN in Railway env vars. Do NOT run `claude login` locally -- it rotates the token.",
          "\n\n🔑 Claude Code OAuth 토큰이 만료되었거나 유효하지 않습니다. Railway 환경 변수에서 CLAUDE_CODE_OAUTH_TOKEN을 업데이트하세요.",
        );
      }

      await channel.send(`❌ ${errMsg}`);
      updateSessionStatus(channelId, "offline");

      // On error: leave thread open for 60s so you can see what went wrong, then archive
      if (taskThread) {
        const t = taskThread;
        setTimeout(() => { t.setArchived(true).catch(() => {}); }, 60_000);
      }
    } finally {
      clearInterval(heartbeatInterval);
      clearInterval(overallTimeout);
      if (batchFlushTimeout) clearTimeout(batchFlushTimeout); // C2: prevent stale batch flush firing after session ends
      this.startingChannels.delete(channelId); // C1: release concurrent start guard
      this.sessions.delete(channelId);

      // Clean up any pending approvals/questions for this channel
      for (const [id, entry] of pendingApprovals) {
        if (entry.channelId === channelId) pendingApprovals.delete(id);
      }
      for (const [id, entry] of pendingQuestions) {
        if (entry.channelId === channelId) pendingQuestions.delete(id);
      }
      pendingCustomInputs.delete(channelId);

      // Process next queued message if any
      const queue = this.messageQueue.get(channelId);
      if (queue && queue.length > 0) {
        const next = queue.shift()!;
        if (queue.length === 0) this.messageQueue.delete(channelId);
        const remaining = queue.length;
        const preview = next.prompt.length > 40 ? next.prompt.slice(0, 40) + "…" : next.prompt;
        const msg = remaining > 0
          ? L(`📨 Processing queued message... (remaining: ${remaining})\n> ${preview}`, `📨 대기 중이던 메시지를 처리합니다... (남은 큐: ${remaining}개)\n> ${preview}`)
          : L(`📨 Processing queued message...\n> ${preview}`, `📨 대기 중이던 메시지를 처리합니다...\n> ${preview}`);
        channel.send(msg).catch(() => {});
        this.sendMessage(next.channel, next.prompt).catch((err) => {
          console.error("Queue sendMessage error:", err);
        });
      }

      // Dequeue from global queue if a concurrency slot just opened
      if (this.globalQueue.length > 0 && this.sessions.size < SessionManager.MAX_CONCURRENT_SESSIONS) {
        const next = this.globalQueue.shift()!;
        console.log(`[concurrency] Dequeuing global entry for ${next.channel.id} (${this.globalQueue.length} remaining)`);
        // Update queue position labels for remaining entries
        for (let i = 0; i < this.globalQueue.length; i++) {
          this.globalQueue[i].queueMsg.edit({
            content: `🕐 Queued (position ${i + 1}) -- will start automatically when a slot opens.`,
            components: [],
          }).catch(() => {});
        }
        // Signal that this entry is now starting
        next.queueMsg.edit({
          content: "▶️ Slot opened -- starting now...",
          components: [],
        }).catch(() => {});
        this.sendMessage(next.channel, next.prompt).catch((err) => {
          console.error("[concurrency] Global queue sendMessage error:", err);
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP-based session (for Bot Interface -- no Discord dependency)
  // ---------------------------------------------------------------------------

  async sendHttpMessage(params: {
    channelId: string;
    channelSlug: string;
    projectPath: string;
    threadId: string;
    kiSessionId: string;
    prompt: string;
  }): Promise<void> {
    const { projectPath, threadId, kiSessionId, prompt } = params;

    // Use threadId as the session key (unique per HTTP conversation)
    const sessionKey = `http:${threadId}`;

    // Wait for a concurrency slot (poll every 3s, timeout after 2 minutes)
    const SLOT_POLL_MS = 3_000;
    const SLOT_TIMEOUT_MS = 2 * 60 * 1000;
    const slotWaitStart = Date.now();

    if (this.sessions.size >= SessionManager.MAX_CONCURRENT_SESSIONS) {
      console.log(`[http-session] Concurrency limit hit (${this.sessions.size}/${SessionManager.MAX_CONCURRENT_SESSIONS}), queuing thread ${threadId}`);
      await updateKiSession(kiSessionId, { status: "queued" });
      await broadcast(threadId, {
        type: "session_blocked",
        sessionId: kiSessionId,
        reason: `Too many concurrent sessions (max ${SessionManager.MAX_CONCURRENT_SESSIONS}). Waiting for a slot...`,
      });

      // Poll for an open slot
      while (this.sessions.size >= SessionManager.MAX_CONCURRENT_SESSIONS) {
        if (Date.now() - slotWaitStart > SLOT_TIMEOUT_MS) {
          console.error(`[http-session] Timed out waiting for concurrency slot (thread ${threadId})`);
          await updateKiSession(kiSessionId, { status: "failed", ended: true });
          broadcast(threadId, {
            type: "session_end",
            sessionId: kiSessionId,
            totalCostUsd: 0,
            durationMs: Date.now() - slotWaitStart,
          }).catch(() => {});
          return;
        }
        await new Promise((r) => setTimeout(r, SLOT_POLL_MS));
      }
      console.log(`[http-session] Slot opened for thread ${threadId} after ${Math.round((Date.now() - slotWaitStart) / 1000)}s`);
    }

    const dbId = kiSessionId;
    let fullResponse = "";
    let toolUseCount = 0;
    let hasResult = false;
    let httpStreamedText = false; // tracks if stream_events delivered text for current turn
    const startTime = Date.now();

    // Track pending tool calls so we can emit tool_call_end when the next event arrives
    let pendingToolCall: { toolName: string; startTime: number } | null = null;

    // Update status to active
    await updateKiSession(kiSessionId, { status: "active" });

    // Broadcast session start
    await broadcast(threadId, { type: "session_start", sessionId: kiSessionId, threadId });

    const abortController = new AbortController();

    // Log auth method for debugging
    const authMethod = process.env.CLAUDE_CODE_OAUTH_TOKEN
      ? `OAuth (set, len=${process.env.CLAUDE_CODE_OAUTH_TOKEN.length})`
      : "NONE";
    console.log(`[http-session] Auth: ${authMethod}, cwd: ${projectPath}, thread: ${threadId}`);

    const effectivePrompt = `[New session. Before responding, call memory_timeline for this project to load recent context.]\n\n${prompt}`;

    // Stall detector: kill session if no activity for 300s (5 min on cold start)
    let lastActivityTime = Date.now();
    let hasTextOutput = false;
    let stallDetected = false;
    const STALL_THRESHOLD_MS = 300 * 1000; // 300s -- match Discord path
    const COLD_START_THRESHOLD_MS = 5 * 60 * 1000;

    const stallInterval = setInterval(async () => {
      if (hasResult || stallDetected) return;
      const timeSinceActivity = Date.now() - lastActivityTime;
      const threshold = (toolUseCount === 0 && !hasTextOutput)
        ? COLD_START_THRESHOLD_MS
        : STALL_THRESHOLD_MS;
      if (timeSinceActivity >= threshold) {
        stallDetected = true;
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.warn(`[http-session] Stall detected for thread ${threadId}: ${elapsed}s elapsed, ${toolUseCount} tools used`);
        abortController.abort();
        this.sessions.delete(sessionKey);
        await updateKiSession(kiSessionId, { status: "failed", ended: true });
        broadcast(threadId, {
          type: "session_end",
          sessionId: kiSessionId,
          totalCostUsd: 0,
          durationMs: Date.now() - startTime,
        }).catch(() => {});
      }
    }, 15_000);

    try {
      const queryInstance = query({
        prompt: effectivePrompt,
        options: {
          model: "claude-opus-4-6",
          effort: "max" as any,
          cwd: projectPath,
          permissionMode: "default",
          env: {
            ...Object.fromEntries(
              ALLOWED_ENV_KEYS
                .filter(k => process.env[k] !== undefined)
                .map(k => {
                  const raw = process.env[k]!;
                  const sanitized = raw.replace(/[\x00-\x1F\x7F]/g, "").trim();
                  return [k, sanitized];
                })
            ),
            PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
            CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: "600",
          },
          abortController,

          canUseTool: async (
            toolName: string,
            input: Record<string, unknown>,
          ) => {
            toolUseCount++;
            lastActivityTime = Date.now(); // reset stall timer

            // Close previous tool call (emit tool_call_end) before starting a new one
            if (pendingToolCall) {
              broadcast(threadId, {
                type: "tool_call_end",
                sessionId: kiSessionId,
                toolName: pendingToolCall.toolName,
                durationMs: Date.now() - pendingToolCall.startTime,
              }).catch(() => {});
            }
            pendingToolCall = { toolName, startTime: Date.now() };

            // Broadcast tool_call_start
            broadcast(threadId, {
              type: "tool_call_start",
              sessionId: kiSessionId,
              toolName,
              input,
            }).catch(() => {});

            // Auto-approve read-only tools
            const readOnlyTools = ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite"];
            if (readOnlyTools.includes(toolName)) {
              return { behavior: "allow" as const, updatedInput: input };
            }

            // For HTTP sessions, auto-approve everything for now
            // (Phase 5 will add approval UI in the web interface)
            // TODO: Implement approval_request flow via Supabase Realtime
            return { behavior: "allow" as const, updatedInput: input };
          },
        },
      });

      // Store active session
      this.sessions.set(sessionKey, {
        queryInstance,
        channelId: sessionKey,
        sessionId: null,
        dbId,
      });

      console.log(`[http-session] Query created for thread ${threadId}, entering message loop`);

      for await (const message of queryInstance) {
        lastActivityTime = Date.now(); // reset stall timer on every message

        // First message -- subprocess is alive
        if (!hasTextOutput && toolUseCount === 0) {
          console.log(`[http-session] First message received for thread ${threadId} (type=${message.type}, ${Date.now() - startTime}ms since start)`);
        }

        // Capture session ID from init
        if (
          message.type === "system" &&
          "subtype" in message &&
          message.subtype === "init"
        ) {
          const sdkSessionId = (message as { session_id?: string }).session_id;
          if (sdkSessionId) {
            const active = this.sessions.get(sessionKey);
            if (active) active.sessionId = sdkSessionId;
            await updateKiSession(kiSessionId, { sdkSessionId });
          }
        }

        // Handle stream_event for real-time text streaming (BUG 1 + HTTP path)
        if (message.type === "stream_event") {
          const streamMsg = message as unknown as { event?: Record<string, unknown>; parent_tool_use_id?: string };
          if (!streamMsg.parent_tool_use_id && streamMsg.event) {
            const evt = streamMsg.event;
            if (evt.type === "content_block_delta") {
              const delta = evt.delta as { type?: string; text?: string } | undefined;
              if (delta?.type === "text_delta" && typeof delta.text === "string") {
                fullResponse += delta.text;
                hasTextOutput = true;
                httpStreamedText = true;
                broadcast(threadId, {
                  type: "text_chunk",
                  sessionId: kiSessionId,
                  content: delta.text,
                }).catch(() => {});
              }
            }
          }
        }

        // Handle complete assistant turn (BUG 6: fix text extraction to use nested msg.message.content)
        if (message.type === "assistant") {
          // Skip text extraction if stream_events already delivered it (prevent doubling)
          if (!httpStreamedText) {
            const msg = message as Record<string, unknown>;
            const innerMsg = msg.message as Record<string, unknown> | undefined;
            const content = (msg.content ?? innerMsg?.content) as unknown[] | undefined;
            if (Array.isArray(content)) {
              for (const block of content as Record<string, unknown>[]) {
                if ("text" in block && typeof block.text === "string") {
                  fullResponse += block.text;
                  hasTextOutput = true;
                  broadcast(threadId, {
                    type: "text_chunk",
                    sessionId: kiSessionId,
                    content: block.text,
                  }).catch(() => {});
                }
              }
            }
          }
          // Reset for next turn
          httpStreamedText = false;
        }

        // Handle result
        if ("result" in message) {
          const resultMsg = message as {
            result?: string;
            total_cost_usd?: number;
            duration_ms?: number;
          };

          hasResult = true;

          // Write the assistant's response to ki_messages
          const responseText = fullResponse.length > 0
            ? fullResponse
            : (resultMsg.result ?? "Task completed");

          await writeKiMessage({
            threadId,
            sessionId: kiSessionId,
            role: "assistant",
            content: responseText,
          });

          // Close the last pending tool call before session ends.
          if (pendingToolCall !== null) {
            const { toolName: endingToolName, startTime: toolStartTime } = pendingToolCall;
            broadcast(threadId, {
              type: "tool_call_end",
              sessionId: kiSessionId,
              toolName: endingToolName,
              durationMs: Date.now() - toolStartTime,
            }).catch(() => {});
            pendingToolCall = null;
          }

          // Broadcast text_complete and session_end
          if (fullResponse.length > 0) {
            broadcast(threadId, {
              type: "text_complete",
              sessionId: kiSessionId,
              fullContent: fullResponse,
            }).catch(() => {});
          }

          broadcast(threadId, {
            type: "session_end",
            sessionId: kiSessionId,
            totalCostUsd: resultMsg.total_cost_usd ?? 0,
            durationMs: resultMsg.duration_ms ?? 0,
          }).catch(() => {});

          // Update ki_session
          await updateKiSession(kiSessionId, {
            status: "completed",
            totalCostUsd: resultMsg.total_cost_usd ?? 0,
            durationMs: resultMsg.duration_ms ?? 0,
            ended: true,
          });
        }
      }

      // Silent iterator exit without result
      if (!hasResult && !stallDetected) {
        console.warn(`[http-session] Iterator exited without result for thread ${threadId}`);
        await updateKiSession(kiSessionId, { status: "failed", ended: true });
        broadcast(threadId, {
          type: "session_end",
          sessionId: kiSessionId,
          totalCostUsd: 0,
          durationMs: Date.now() - startTime,
        }).catch(() => {});
      }
    } catch (error) {
      if (hasResult || stallDetected) return; // Ignore post-result and post-stall errors

      const errMsg = error instanceof Error ? error.message : "Unknown error";
      console.error(`[http-session] Error for thread ${threadId}:`, errMsg);
      if (error instanceof Error && error.stack) {
        console.error(`[http-session] Stack trace:`, error.stack);
      }

      await updateKiSession(kiSessionId, { status: "failed", ended: true });
      broadcast(threadId, {
        type: "session_end",
        sessionId: kiSessionId,
        totalCostUsd: 0,
        durationMs: Date.now() - startTime,
      }).catch(() => {});
    } finally {
      clearInterval(stallInterval);
      this.sessions.delete(sessionKey);

      // Dequeue from global queue if a concurrency slot opened (same as Discord path)
      if (this.globalQueue.length > 0 && this.sessions.size < SessionManager.MAX_CONCURRENT_SESSIONS) {
        const next = this.globalQueue.shift()!;
        console.log(`[concurrency] Dequeuing global entry for ${next.channel.id} from HTTP finally (${this.globalQueue.length} remaining)`);
        for (let i = 0; i < this.globalQueue.length; i++) {
          this.globalQueue[i].queueMsg.edit({
            content: `\ud83d\udd70\ufe0f Queued (position ${i + 1}) -- will start automatically when a slot opens.`,
            components: [],
          }).catch(() => {});
        }
        next.queueMsg.edit({
          content: "\u25b6\ufe0f Slot opened -- starting now...",
          components: [],
        }).catch(() => {});
        this.sendMessage(next.channel, next.prompt).catch((err) => {
          console.error("[concurrency] Global queue sendMessage error (from HTTP finally):", err);
        });
      }
    }
  }

  async stopSession(channelId: string): Promise<boolean> {
    const session = this.sessions.get(channelId);
    if (!session) return false;

    try {
      await session.queryInstance.interrupt();
    } catch {
      // already stopped
    }

    this.sessions.delete(channelId);

    // Clean up any pending approvals/questions for this channel
    for (const [id, entry] of pendingApprovals) {
      if (entry.channelId === channelId) pendingApprovals.delete(id);
    }
    for (const [id, entry] of pendingQuestions) {
      if (entry.channelId === channelId) pendingQuestions.delete(id);
    }
    pendingCustomInputs.delete(channelId);

    updateSessionStatus(channelId, "offline");
    return true;
  }

  isActive(channelId: string): boolean {
    return this.sessions.has(channelId);
  }

  resolveApproval(
    requestId: string,
    decision: "approve" | "deny" | "approve-all",
  ): boolean {
    const pending = pendingApprovals.get(requestId);
    if (!pending) return false;

    if (decision === "approve-all") {
      // Enable auto-approve for this channel
      setAutoApprove(pending.channelId, true);
      pending.resolve({ behavior: "allow" });
    } else if (decision === "approve") {
      pending.resolve({ behavior: "allow" });
    } else {
      pending.resolve({ behavior: "deny", message: "Denied by user" });
    }

    return true;
  }

  resolveQuestion(requestId: string, answer: string): boolean {
    const pending = pendingQuestions.get(requestId);
    if (!pending) return false;
    pending.resolve(answer);
    return true;
  }

  enableCustomInput(requestId: string, channelId: string): void {
    pendingCustomInputs.set(channelId, { requestId });
  }

  resolveCustomInput(channelId: string, text: string): boolean {
    const ci = pendingCustomInputs.get(channelId);
    if (!ci) return false;
    pendingCustomInputs.delete(channelId);

    const pending = pendingQuestions.get(ci.requestId);
    if (!pending) return false;
    pending.resolve(text);
    return true;
  }

  hasPendingCustomInput(channelId: string): boolean {
    return pendingCustomInputs.has(channelId);
  }

  // --- Message queue ---

  setPendingQueue(channelId: string, channel: TextChannel, prompt: string): void {
    this.pendingQueuePrompts.set(channelId, { channel, prompt });
  }

  confirmQueue(channelId: string): boolean {
    const pending = this.pendingQueuePrompts.get(channelId);
    if (!pending) return false;
    this.pendingQueuePrompts.delete(channelId);
    const queue = this.messageQueue.get(channelId) ?? [];
    queue.push(pending);
    this.messageQueue.set(channelId, queue);
    return true;
  }

  cancelQueue(channelId: string): void {
    this.pendingQueuePrompts.delete(channelId);
  }

  isQueueFull(channelId: string): boolean {
    const queue = this.messageQueue.get(channelId) ?? [];
    return queue.length >= SessionManager.MAX_QUEUE_SIZE;
  }

  getQueueSize(channelId: string): number {
    return (this.messageQueue.get(channelId) ?? []).length;
  }

  hasQueue(channelId: string): boolean {
    return this.pendingQueuePrompts.has(channelId);
  }

  getQueue(channelId: string): { channel: TextChannel; prompt: string }[] {
    return this.messageQueue.get(channelId) ?? [];
  }

  clearQueue(channelId: string): number {
    const queue = this.messageQueue.get(channelId) ?? [];
    const count = queue.length;
    this.messageQueue.delete(channelId);
    this.pendingQueuePrompts.delete(channelId);
    return count;
  }

  removeFromQueue(channelId: string, index: number): string | null {
    const queue = this.messageQueue.get(channelId);
    if (!queue || index < 0 || index >= queue.length) return null;
    const [removed] = queue.splice(index, 1);
    if (queue.length === 0) {
      this.messageQueue.delete(channelId);
      this.pendingQueuePrompts.delete(channelId);
    }
    return removed.prompt;
  }
}

export const sessionManager = new SessionManager();
