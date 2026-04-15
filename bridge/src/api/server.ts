import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { sessionManager } from "../claude/session-manager.js";
import {
  getThread,
  createThread,
  writeMessage,
  createSession,
  updateSession,
  getChannel,
  touchThread,
} from "../db/supabase.js";
import { getSession } from "../db/database.js";

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

function authenticate(request: FastifyRequest, reply: FastifyReply): boolean {
  const apiKey = process.env.BRIDGE_API_KEY;
  if (!apiKey) {
    reply.code(500).send({ error: "BRIDGE_API_KEY not configured" });
    return false;
  }

  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    reply.code(401).send({ error: "Missing or invalid Authorization header" });
    return false;
  }

  const token = authHeader.slice(7);
  const tokenBuf = Buffer.from(token);
  const keyBuf = Buffer.from(apiKey);
  if (tokenBuf.length !== keyBuf.length || !timingSafeEqual(tokenBuf, keyBuf)) {
    reply.code(401).send({ error: "Invalid API key" });
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

interface MessageBody {
  content: string;
  threadId?: string;
}

interface ChannelParams {
  channelId: string;
}

// ---------------------------------------------------------------------------
// Build and start the HTTP API server
// ---------------------------------------------------------------------------

export async function startHttpServer(): Promise<FastifyInstance> {
  const port = parseInt(process.env.BRIDGE_HTTP_PORT ?? "3001", 10);

  const app = Fastify({
    logger: {
      level: "info",
    },
  });

  // ---- Health check (no auth) ----
  app.get("/api/health", async () => {
    return { ok: true, timestamp: new Date().toISOString() };
  });

  // ---- POST /api/channels/:channelId/messages ----
  app.post<{ Params: ChannelParams; Body: MessageBody }>(
    "/api/channels/:channelId/messages",
    async (request, reply) => {
      if (!authenticate(request, reply)) return;

      const { channelId } = request.params;
      const { content, threadId: requestThreadId } = request.body ?? {};

      if (!content || typeof content !== "string" || content.trim().length === 0) {
        return reply.code(400).send({ error: "content is required and must be a non-empty string" });
      }

      // Resolve channel from Supabase ki_channels
      const channel = await getChannel(channelId);
      if (!channel) {
        return reply.code(404).send({ error: `Channel not found: ${channelId}` });
      }

      // Resolve or create thread
      let threadId = requestThreadId ?? null;
      if (threadId) {
        const existing = await getThread(threadId);
        if (!existing) {
          return reply.code(404).send({ error: `Thread not found: ${threadId}` });
        }
      } else {
        // Create a new thread
        const thread = await createThread({
          channelId: channel.id,
          title: content.slice(0, 100),
        });
        if (!thread) {
          return reply.code(500).send({ error: "Failed to create thread" });
        }
        threadId = thread.id;
      }

      // Write the human message to ki_messages
      await writeMessage({
        threadId,
        role: "human",
        content: content.trim(),
      });

      // Create a ki_session record
      const kiSession = await createSession({ threadId });
      if (!kiSession) {
        return reply.code(500).send({ error: "Failed to create session" });
      }

      // Start the Claude session via the session manager (async, non-blocking)
      // The session manager will broadcast events as it runs.
      // We use the HTTP-specific method that takes a channelId + threadId
      // instead of a Discord TextChannel.
      sessionManager
        .sendHttpMessage({
          channelId: channel.id,
          channelSlug: channel.slug,
          projectPath: channel.project_path,
          threadId,
          kiSessionId: kiSession.id,
          prompt: content.trim(),
        })
        .catch((err) => {
          console.error(`[api] Session error for thread ${threadId}:`, err);
          // Update ki_session status to failed
          updateSession(kiSession.id, { status: "failed", ended: true }).catch(() => {});
        });

      // Touch thread activity
      await touchThread(threadId);

      // Return immediately -- client subscribes to Realtime for updates
      return reply.code(202).send({
        sessionId: kiSession.id,
        threadId,
      });
    },
  );

  // ---- POST /api/channels/:channelId/stop ----
  app.post<{ Params: ChannelParams; Body: { threadId?: string } }>(
    "/api/channels/:channelId/stop",
    async (request, reply) => {
      if (!authenticate(request, reply)) return;

      const { channelId } = request.params;
      const { threadId } = request.body ?? {};

      // HTTP sessions are keyed as `http:${threadId}`, so try that first
      let stopped = false;
      if (threadId) {
        stopped = await sessionManager.stopSession(`http:${threadId}`);
      }
      if (!stopped) {
        stopped = await sessionManager.stopSession(channelId);
      }
      return { stopped };
    },
  );

  // ---- GET /api/channels/:channelId/status ----
  app.get<{ Params: ChannelParams }>(
    "/api/channels/:channelId/status",
    async (request, reply) => {
      if (!authenticate(request, reply)) return;

      const { channelId } = request.params;

      // Check in-memory active session
      const isActive = sessionManager.isActive(channelId);

      // Check SQLite DB for stored session state
      const dbSession = getSession(channelId);

      return {
        channelId,
        active: isActive,
        dbStatus: dbSession?.status ?? null,
        lastActivity: dbSession?.last_activity ?? null,
      };
    },
  );

  // ---- POST /api/upload (stub for Phase 5) ----
  app.post("/api/upload", async (request, reply) => {
    if (!authenticate(request, reply)) return;
    return reply.code(501).send({ error: "File upload not yet implemented (Phase 5)" });
  });

  // Start listening
  try {
    await app.listen({ port, host: "0.0.0.0" });
    console.log(`[api] HTTP server listening on port ${port}`);
  } catch (err) {
    console.error("[api] Failed to start HTTP server:", err);
    throw err;
  }

  return app;
}
