FROM node:22.12-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json vitest.config.ts ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN npm ci
RUN npm run build

FROM node:22.12-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps ./apps
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/scripts ./scripts
USER node
CMD ["node", "apps/telegram-bot/dist/main.js", "--health"]
