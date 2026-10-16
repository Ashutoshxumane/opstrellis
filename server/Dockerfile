# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS model
# Self-hosted STT model. Build with --build-arg FETCH_MODEL=0 to skip and mount ./models instead.
ARG FETCH_MODEL=1
COPY scripts/fetch-model.sh /fetch-model.sh
RUN mkdir -p /models && if [ "$FETCH_MODEL" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends curl ca-certificates bzip2 \
      && sh /fetch-model.sh /models; \
    fi

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=8787 LOCAL_MODEL_DIR=/app/models
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY --from=model /models ./models
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Apply migrations (idempotent, also inserts missing default models), then serve.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
