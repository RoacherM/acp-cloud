FROM node:22-bookworm

# Dev tools needed by coding agents (bash, git, python, curl, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl wget sudo \
    python3 python3-pip python3-venv \
    build-essential jq ripgrep fzf \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install pi coding agent + ACP adapter globally
RUN npm install -g @mariozechner/pi-coding-agent pi-acp

# Non-root user with sudo
RUN useradd -m -s /bin/bash agent \
    && echo "agent ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers
USER agent
WORKDIR /home/agent

# Copy project and install dependencies
COPY --chown=agent:agent package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=agent:agent src/ ./src/
COPY --chown=agent:agent examples/ ./examples/
COPY --chown=agent:agent tsconfig.json ./

# Default port
ENV PORT=3000
ENV NODE_ENV=production
EXPOSE 3000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -sf http://localhost:${PORT}/agents || exit 1

CMD ["node", "--import", "tsx", "examples/server.ts"]
