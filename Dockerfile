FROM node:20-bookworm-slim

# better-sqlite3 needs python+make+g++ at install time, plus tar at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      python3 \
      ca-certificates \
      tar \
      gosu \
      chromium \
      fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Puppeteer-core points at this Chromium for PDF generation.
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
RUN chmod +x /app/docker-entrypoint.sh

# Strip dev tools out of the final image footprint.
RUN apt-get purge -y build-essential python3 \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=4040
ENV BIND_HOST=0.0.0.0

# Coolify mounts a persistent volume here.
VOLUME ["/app/data"]

EXPOSE 4040

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:4040/healthz', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Entrypoint fixes data-volume ownership as root, then drops to the unprivileged 'node' user.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
