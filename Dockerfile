FROM node:22.12-bookworm-slim@sha256:35531c52ce27b6575d69755c73e65d4468dba93a25644eed56dc12879cae9213 AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json vitest.config.ts ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY config/cardano-sources.json ./config/cardano-sources.json
COPY samples/evaluation/cardano-rag.jsonl ./samples/evaluation/cardano-rag.jsonl
RUN npm ci
RUN npm run build

FROM node:22.12-bookworm-slim@sha256:35531c52ce27b6575d69755c73e65d4468dba93a25644eed56dc12879cae9213

WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps ./apps
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/config/cardano-sources.json ./config/cardano-sources.json
COPY --from=build --chown=node:node /app/samples/evaluation/cardano-rag.jsonl ./samples/evaluation/cardano-rag.jsonl
RUN install -d -o node -g node -m 700 /app/reports/evaluation
USER node
CMD ["node", "apps/telegram-bot/dist/main.js", "--health"]
