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
COPY build.mjs ./
RUN npm run build

# ── Runtime stage: slim image ──
FROM node:20-slim

# Install FUSE (for JuiceFS) and curl (for health checks)
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends \
      fuse curl ca-certificates build-essential python3 && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install JuiceFS open-source (self-hosted, no dependency on juicefs.com)
RUN curl -sSL https://d.juicefs.com/install | sh

WORKDIR /app

# Install only better-sqlite3 native module (everything else is bundled)
# Use a minimal package.json to avoid installing 290+ unnecessary packages
RUN echo '{"type":"module","dependencies":{"better-sqlite3":"^12.8.0"}}' > package.json
COPY package-lock.json ./
RUN npm install better-sqlite3 && npm cache clean --force

# Remove build tools after native module compiled
RUN apt-get purge -y build-essential python3 && apt-get autoremove -y

# Copy pre-compiled gateway (10MB single file, all JS deps bundled)
COPY --from=build /build/dist/ ./dist/

# Startup script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 18800

ENTRYPOINT ["/entrypoint.sh"]
