FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8080
WORKDIR /app
RUN groupadd --system --gid 10001 bfg && useradd --system --uid 10001 --gid bfg --home-dir /app bfg
COPY --from=dependencies /app/node_modules ./node_modules
COPY --chown=bfg:bfg . .
USER bfg
EXPOSE 8080
HEALTHCHECK --interval=20s --timeout=5s --start-period=60s --retries=5 CMD ["node","-e","fetch('http://127.0.0.1:8080/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["sh","-c","node scripts/company-bootstrap.js && exec node server.js"]
