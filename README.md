# discord-claude-os

An AI assistant that runs Claude Code sessions from Discord. You message it, it thinks, uses tools, writes code, searches the web, and remembers things across conversations.

Built on [chadingTV/claudecode-discord](https://github.com/chadingTV/claudecode-discord), extended with persistent semantic memory, specialist agent routing, scheduled tasks, and a team/project system.

## What You Get

- **Discord bot** that spawns Claude Code sessions per channel
- **Persistent semantic memory** via Supabase + pgvector (remembers facts, decisions, conversations)
- **Skill registry** for reusable workflows
- **Scheduled tasks** (cron-based, stored in Supabase)
- **Agent system** with specialist subagents (researcher, writer, analyst, dev, verifier)
- **Team-based project isolation** (each Discord channel maps to a team directory with its own context)

## Prerequisites

- Claude Pro or Max subscription (for the OAuth token)
- Discord account + bot token
- Supabase project (free tier works)
- OpenAI API key (for memory embeddings only, costs pennies)
- Railway account (or any Docker host)

## Quick Start

### 1. Fork and clone

\`\`\`bash
gh repo fork LevityLeads/discord-claude-os --clone
cd discord-claude-os
\`\`\`

### 2. Set up Supabase

Create a free project at [supabase.com](https://supabase.com). Enable the \`vector\` extension (Database > Extensions). Then run the 4 SQL files in order in the SQL Editor:

\`\`\`
mcp-servers/supabase-memory/setup.sql
mcp-servers/supabase-memory/setup-enhancements.sql
mcp-servers/supabase-memory/setup-skills.sql
mcp-servers/supabase-memory/setup-scheduled-tasks.sql
\`\`\`

### 3. Get your Claude Code token

\`\`\`bash
claude setup-token
\`\`\`

This opens a browser, you log in, and it prints a token starting with \`sk-ant-oat01-...\`. This is a 1-year headless token for running Claude Code on servers.

**Important:** Do NOT set \`ANTHROPIC_API_KEY\` alongside this token. The OAuth token uses your subscription. An API key switches to pay-per-token billing.

### 4. Create a Discord bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. New Application, give it a name
3. Go to Bot, click Reset Token, copy it
4. Turn on **Message Content Intent** under Privileged Gateway Intents
5. Go to OAuth2 > URL Generator, select \`bot\` + \`applications.commands\` scopes
6. Under Bot Permissions: Send Messages, Embed Links, Read Message History, Create Public Threads, Use Slash Commands
7. Copy the generated URL, open it, invite the bot to your server

### 5. Deploy on Railway

1. Create a new project on [railway.app](https://railway.app)
2. Deploy from GitHub Repo, select your fork
3. Add a Volume mounted at \`/app/data\`
4. Set environment variables (see below)
5. Deploy

### 6. Register a channel

In any Discord text channel, type:

\`\`\`
/register general
\`\`\`

This maps that channel to \`teams/general/\`. Now message the bot.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| \`DISCORD_BOT_TOKEN\` | Yes | From Discord Developer Portal |
| \`DISCORD_GUILD_ID\` | Yes | Right-click server > Copy Server ID |
| \`ALLOWED_USER_IDS\` | Yes | Right-click yourself > Copy User ID |
| \`CLAUDE_CODE_OAUTH_TOKEN\` | Yes | From \`claude setup-token\` |
| \`SUPABASE_URL\` | Yes | From Supabase Settings > API |
| \`SUPABASE_SERVICE_ROLE_KEY\` | Yes | From Supabase Settings > API (service_role, secret) |
| \`OPENAI_API_KEY\` | Yes | From platform.openai.com (for memory embeddings) |
| \`BASE_PROJECT_DIR\` | Yes | Set to \`/app/teams\` |
| \`RATE_LIMIT_PER_MINUTE\` | No | Default: 10 |
| \`SHOW_COST\` | No | Default: false |

## Customization

### Personality

Edit \`CLAUDE.md\` at the repo root. This is the system prompt. Change the \`## Identity\` and \`## About You\` sections to match your personality and context.

### Teams

Create a new directory at \`teams/my-project/\` with its own \`CLAUDE.md\` (use \`teams/_template/\` as a starting point). Register a Discord channel with \`/register my-project\`.

### Agents

Agent definitions live in \`.claude/agents/\`. Each file defines a specialist subagent with specific tools and workflow. Included agents:

- **researcher** -- web research, competitive intel, data gathering
- **writer** -- drafting content, emails, docs
- **analyst** -- strategic analysis, recommendations
- **dev** -- code, debugging, deployments
- **verifier** -- checks other agents' work

Create your own by copying an existing agent file and customizing it.

### Adding MCP Servers

Edit \`.mcp.json\` to add more MCP servers. Example adding Railway:

\`\`\`json
{
  "mcpServers": {
    "supabase-memory": { "..." : "..." },
    "railway": {
      "command": "npx",
      "args": ["-y", "@jasontanswe/railway-mcp"],
      "env": {
        "RAILWAY_API_TOKEN": "${RAILWAY_API_TOKEN}"
      }
    }
  }
}
\`\`\`

### Skills

Save reusable workflows as skills via \`skill_create\`. They become searchable via \`skill_search\` and any agent can use them.

## Architecture

\`\`\`
Discord message
  -> Bridge (discord.js + Fastify HTTP API)
    -> Claude Code Agent SDK (spawns Claude session)
      -> MCP Servers (supabase-memory, etc.)
      -> Subagents (researcher, writer, dev, etc.)
    -> Memory Logger (transcripts to Supabase)
    -> Scheduler (cron tasks from Supabase)
\`\`\`

The bridge manages Claude Code sessions per Discord channel. Each session gets the team's \`CLAUDE.md\` as context, plus access to MCP tools. Memory persists in Supabase across sessions and deploys.

## Self-Hosted (Mac/Linux)

You can run this on your own hardware instead of Railway:

\`\`\`bash
# Install Claude Code CLI
npm install -g @anthropic-ai/claude-code

# Install dependencies
cd bridge && npm install && npm run build && cd ..
cd mcp-servers/supabase-memory && npm install && cd ../..

# Set env vars (create bridge/.env from .env.example)

# Symlink MCP config
for dir in teams/*/; do ln -sf "$(pwd)/.mcp.json" "$dir.mcp.json"; done

# Run
node bridge/dist/index.js
\`\`\`

Use PM2 (\`pm2 start bridge/dist/index.js\`) to keep it running and auto-restart on crash.

## License

MIT (bridge is forked from [chadingTV/claudecode-discord](https://github.com/chadingTV/claudecode-discord))
