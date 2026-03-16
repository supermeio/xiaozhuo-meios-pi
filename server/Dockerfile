# meios sandbox image — pre-baked for fast cold start on Fly.io
#
# Includes: Node.js 20, meios server + deps, JuiceFS client, FUSE
# Cold start target: ~5s (machine start + JuiceFS mount + agent start)

FROM node:20-slim AS base

# Install system deps: FUSE for JuiceFS, curl for health checks, build tools for native modules
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends \
      fuse curl ca-certificates build-essential python3 && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install JuiceFS mount binary (cloud client)
RUN curl -sSL http://s.juicefs.com/static/Linux/mount -o /usr/local/bin/jfsmount && \
    chmod +x /usr/local/bin/jfsmount

# ── App setup ──
WORKDIR /app

# Install deps first (cache layer)
COPY package.json package-lock.json ./
RUN npm ci --production && npm cache clean --force

# Remove build tools (no longer needed after native modules compiled)
RUN apt-get purge -y build-essential python3 && apt-get autoremove -y

# Copy server source
COPY src/ ./src/

# ── Startup script ──
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 18800

ENTRYPOINT ["/entrypoint.sh"]
