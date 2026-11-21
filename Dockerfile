FROM ghcr.io/astral-sh/uv:0.13.7@sha256:96f40d3904aad8d0bd010539001d36c8e2188b981e1334471a90c4a1d93bb490 AS uv

# The update button, the secret field and the shared colors from @meldgrove/ui (package.json).
FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS ui
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund && npm run static

FROM python:3.13-slim-bookworm@sha256:a5a7017efc5969e00ae2b91c8eb0631049a569652aa4ffc4501769049ae45c72 AS base
COPY --from=uv /uv /usr/local/bin/uv
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0 fonts-dejavu-core libseccomp2 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 portal && useradd --uid 10001 --gid portal --create-home portal
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
COPY pyproject.toml uv.lock ./

FROM base AS test
RUN uv sync --locked
COPY . .
RUN mkdir -p var/private && chown -R portal:portal /app
USER portal
ENV PATH="/app/.venv/bin:$PATH"
CMD ["pytest", "-q"]

FROM base AS assets
# The stylesheet is built here with the pinned standalone Tailwind CLI and the shared
# colors from the ui stage.
COPY scripts/tailwind.py scripts/
COPY portal portal
COPY --from=ui /app/portal/static/portal/vendor/ portal/static/portal/vendor/
RUN python scripts/tailwind.py build

FROM base AS runtime
RUN uv sync --locked --no-dev
COPY . .
COPY --from=assets /app/portal/static/portal/ui.css portal/static/portal/ui.css
COPY --from=ui /app/portal/static/portal/vendor/meldgrove-updates.js /app/portal/static/portal/vendor/meldgrove-secret-input.js portal/static/portal/vendor/
# Coolify injects deployment variables as build arguments. Static assets need
# only development defaults, even when those arguments are empty or unresolved.
RUN env -i PATH="$PATH" PYTHONDONTWRITEBYTECODE=1 DJANGO_DEBUG=1 DEPLOYMENT_ENV=development \
    /app/.venv/bin/python manage.py collectstatic --noinput \
    && mkdir -p var/private && chown -R portal:portal /app
# The release workflow sets the version; images built from source have none.
ARG APP_VERSION=""
ENV APP_VERSION=${APP_VERSION}
USER portal
ENV PATH="/app/.venv/bin:$PATH"
EXPOSE 8000
CMD ["sh", "/app/scripts/start-web.sh"]
