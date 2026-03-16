# meios sandbox image — pre-baked for fast cold start on Fly.io
#
# Includes: Node.js 20, meios server (pre-compiled), JuiceFS client, FUSE
# Cold start target: ~5s (machine start + JuiceFS mount + node start)

# ── Build stage: compile TS → JS ──
FROM node:20-slim AS build

RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends build-essential python3 && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci

COPY src/ ./src/
RUN npm run build

# ── Runtime stage: slim image ──
FROM node:20-slim

# Install FUSE (for JuiceFS) and curl (for health checks)
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends \
      fuse curl ca-certificates build-essential python3 && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install JuiceFS mount binary
RUN curl -sSL http://s.juicefs.com/static/Linux/mount -o /usr/local/bin/jfsmount && \
    chmod +x /usr/local/bin/jfsmount

WORKDIR /app

# Install production deps only (need build tools for better-sqlite3 native module)
COPY package.json package-lock.json ./
RUN npm ci --production && npm cache clean --force

# Remove build tools after native modules compiled
RUN apt-get purge -y build-essential python3 && apt-get autoremove -y

# Copy pre-compiled gateway
COPY --from=build /build/dist/ ./dist/

# Startup script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 18800

ENTRYPOINT ["/entrypoint.sh"]
