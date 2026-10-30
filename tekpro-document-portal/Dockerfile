# syntax=docker/dockerfile:1.7
# Tekpro Document Portal - one image serving the API and the web app on port 3000.
#
#   docker build --platform linux/amd64 -t tekpro-portal .
#   docker run -p 3000:3000 --env-file .env tekpro-portal
#
# Build: full Debian Node image (has OpenSSL and certificates, so no package downloads).
# Runtime: distroless Node 22 (no shell or package manager), non-root user 65532.
# On start the container applies pending database migrations (RUN_MIGRATIONS=true).
# Admin tasks run the same image with another command, e.g.
#   docker run --rm -it --env-file .env tekpro-portal bootstrap-superadmin --email a@b.com --name "A B"

ARG BUILD_IMAGE=node:22-bookworm
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs22-debian12:nonroot

# ---------------------------------------------------------------- build stage
FROM ${BUILD_IMAGE} AS build
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false

# Dependencies first, for layer caching.
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY backend/prisma backend/prisma
RUN npm ci

COPY backend backend
COPY frontend frontend
# Optional approved logo, e.g. --build-arg VITE_PUBLIC_BRAND_LOGO_URL=/branding/logo.svg
ARG VITE_PUBLIC_BRAND_LOGO_URL=""
ENV VITE_PUBLIC_BRAND_LOGO_URL=${VITE_PUBLIC_BRAND_LOGO_URL}
# Then reinstall only the backend's production dependencies (the web app is static
# files by now); the backend postinstall regenerates the Prisma client.
RUN npm run build \
 && rm -rf node_modules backend/node_modules frontend/node_modules \
 && npm ci --omit=dev --workspace backend \
 && npm cache clean --force

# -------------------------------------------------------------- runtime stage
FROM ${RUNTIME_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    SERVE_FRONTEND_DIR=/app/frontend/dist \
    RUN_MIGRATIONS=true \
    PRISMA_HIDE_UPDATE_MESSAGE=1 \
    PRISMA_QUERY_ENGINE_LIBRARY=/app/node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node \
    PRISMA_SCHEMA_ENGINE_BINARY=/app/node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x

# Files are owned by root, so the runtime user (65532) cannot modify the application.
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/backend/package.json ./backend/
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/backend/prisma ./backend/prisma
COPY --from=build /app/frontend/dist ./frontend/dist
COPY docker/entrypoint.mjs ./docker/entrypoint.mjs

USER 65532:65532
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/nodejs/bin/node", "/app/docker/entrypoint.mjs"]
CMD ["serve"]
