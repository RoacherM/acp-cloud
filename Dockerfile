FROM node:lts-bookworm

# Dev tools needed by coding agents (bash, git, python, curl, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl wget sudo \
    python3 python3-pip python3-venv \
    build-essential jq ripgrep fzf \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install ACP agents globally
RUN npm install -g \
    @mariozechner/pi-coding-agent pi-acp \
    @zed-industries/claude-agent-acp \
    @zed-industries/codex-acp @zed-industries/codex-acp-linux-arm64

# Non-root user with sudo
RUN useradd -m -s /bin/bash agent \
    && echo "agent ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Pre-create agent config dirs (mountable via docker-compose volumes)
RUN mkdir -p /home/agent/.pi/agent /home/agent/.pi/pi-acp \
    /home/agent/.codex \
    && chown -R agent:agent /home/agent/.pi /home/agent/.codex

# Default codex config — uses OpenRouter
COPY --chown=agent:agent config/codex/config.toml /home/agent/.codex/config.toml

USER agent
WORKDIR /home/agent

# Copy project and install dependencies
COPY --chown=agent:agent package.json package-lock.json ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

COPY --chown=agent:agent src/ ./src/
COPY --chown=agent:agent examples/ ./examples/
COPY --chown=agent:agent tsconfig.json ./

# Default port
ENV PORT=3000
ENV NODE_ENV=production
EXPOSE 3000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -sf http://localhost:${PORT}/health || exit 1

CMD ["node", "--import", "tsx", "examples/server.ts"]
