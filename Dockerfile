FROM node:22-slim

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Copy the full repo so teams/ and CLAUDE.md are accessible
COPY . /app

# Install bridge dependencies and build
WORKDIR /app/bridge
RUN npm install && npm run build

# Install supabase-memory MCP server dependencies
WORKDIR /app/mcp-servers/supabase-memory
RUN npm install

# Back to repo root
WORKDIR /app

# Symlink .mcp.json into every team directory so Claude Code finds MCP config
# regardless of which team dir the session starts in
RUN for dir in /app/teams/*/; do ln -sf /app/.mcp.json "\$dir.mcp.json"; done

# Persist Claude Code sessions across deploys by symlinking config to volume
CMD ["sh", "-c", "mkdir -p /app/data/claude-config && ln -sfn /app/data/claude-config /root/.claude && node bridge/dist/index.js"]
