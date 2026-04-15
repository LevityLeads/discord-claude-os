import "dotenv/config";
import { loadConfig } from "./utils/config.js";
import { initDatabase } from "./db/database.js";
import { startBot } from "./bot/client.js";
import { flushAll } from "./memory/logger.js";
import { stopScheduler } from "./scheduled/scheduler.js";
import { startHttpServer } from "./api/server.js";
import { initBroadcaster } from "./events/broadcaster.js";

async function main() {
  process.on("SIGINT", async () => { stopScheduler(); await flushAll(); process.exit(0); });
  process.on("SIGTERM", async () => { stopScheduler(); await flushAll(); process.exit(0); });

  // Global error handlers — prevent silent hangs from unhandled errors
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled promise rejection:", reason);
  });
  process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
    // Don't exit — let the bot keep running for non-fatal errors
  });

  console.log("Starting Claude Code Discord Controller...");

  // Load and validate config
  loadConfig();
  console.log("Config loaded");

  // Initialize database
  initDatabase();
  console.log("Database initialized");

  // Initialize Supabase event broadcaster
  const broadcasterReady = initBroadcaster();
  console.log(`Broadcaster initialized: ${broadcasterReady}`);

  // Start HTTP API server
  await startHttpServer();
  console.log("HTTP API server running");

  // Start Discord bot
  await startBot();
  console.log("Bot is running!");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
