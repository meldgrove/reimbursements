# One image for every process. The command selects the role:
#   all      web app and worker
#   web      web app and API (port 8000)
#   worker   jobs: upload checks, claim PDFs, email, retention
#   migrate  apply database migrations (taking over a database of the Django version), then exit
#   cli      operator commands, e.g. `cli settings list` (apps/server/src/commands); also on the PATH

FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS base
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

FROM base AS deps
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY . .
RUN npm run build
# Release builds upload the source maps of the server and the web app to
# Sentry, which finds them by the debug IDs the build wrote into the bundles
# (scripts/inject-debug-ids.mjs). Without the token, nothing is uploaded.
ARG SENTRY_ORG=""
ARG SENTRY_PROJECT=""
RUN --mount=type=secret,id=sentry_auth_token,env=SENTRY_AUTH_TOKEN \
    if [ -n "$SENTRY_AUTH_TOKEN" ]; then \
      export SENTRY_CLI_NO_TELEMETRY=1 SENTRY_CLI_NO_UPDATE_CHECK=1 \
      && node_modules/.bin/sentry sourcemap upload apps/server/dist \
      && node_modules/.bin/sentry sourcemap upload apps/web/dist; \
    fi
# The web app's source maps would be public under /assets: they stay out of
# the image. The server's are never served.
RUN find apps/web/dist -name '*.map' -delete

# The document sandbox (apps/server/native/sandbox): the launcher that applies
# the resource limits and Landlock before the document child starts, and the
# add-on with its seccomp filter. Built against this Node's headers; the
# add-on loads libseccomp.so.2 when it runs, so only the compiler is needed.
FROM base AS sandbox
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*
COPY apps/server/native/sandbox apps/server/native/sandbox
RUN node apps/server/native/sandbox/build.mjs

FROM base AS prod-deps
# npm keeps a package under apps/server/node_modules when the lock file puts it
# there; the folder exists either way, for the copy below.
RUN npm ci --omit=dev --workspace @reimbursements/server --include-workspace-root=false --no-audit --no-fund \
    && mkdir -p apps/server/node_modules

FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS runtime
# libseccomp2 for the document sandbox (the claim PDF's font comes with the
# app, apps/server/assets/fonts). The user of the Django version (uid 10001),
# which owns the private volume and which compose.yaml's backup agent runs as too.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libseccomp2 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 portal \
    && useradd --uid 10001 --gid portal --no-create-home --shell /usr/sbin/nologin portal \
    && mkdir -p /app/var/private \
    && chown portal:portal /app/var/private \
    && chmod 0700 /app/var/private
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8000 \
    PRIVATE_STORAGE_ROOT=/app/var/private
WORKDIR /app
COPY --from=prod-deps --chown=portal:portal /app/node_modules ./node_modules
COPY --from=prod-deps --chown=portal:portal /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build --chown=portal:portal /app/package.json ./package.json
COPY --from=build --chown=portal:portal /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=portal:portal /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=portal:portal /app/apps/server/drizzle ./apps/server/drizzle
COPY --from=build --chown=portal:portal /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/apps/server/assets ./apps/server/assets
# Owned by root: the app's user cannot change the sandbox it runs parsers in.
COPY --from=sandbox /app/apps/server/native/build ./apps/server/native/build
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# A server that the updater moves from the Django version (0.4) still has its
# compose.yaml, which runs `python manage.py ...` and Python health checks.
COPY --chmod=755 docker-django-compat.sh /usr/local/bin/python
# `cli <command>` in a running container: `docker compose exec web cli settings list`.
COPY --chmod=755 docker-cli.sh /usr/local/bin/cli
# The release workflow sets the version; images built from source have none.
ARG APP_VERSION=""
ENV APP_VERSION=${APP_VERSION}
USER portal
EXPOSE 8000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["web"]
