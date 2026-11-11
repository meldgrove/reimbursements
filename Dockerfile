FROM ghcr.io/astral-sh/uv:0.13.7@sha256:96f40d3904aad8d0bd010539001d36c8e2188b981e1334471a90c4a1d93bb490 AS uv
FROM python:3.13-slim-bookworm@sha256:e32be0e55814a08977501ca863271d9bd02443710db8f2afaf8372e2c4508530 AS base
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
# The stylesheet is built here with the pinned standalone Tailwind CLI; no Node.
COPY scripts/tailwind.py scripts/
COPY portal portal
RUN python scripts/tailwind.py build

FROM base AS runtime
RUN uv sync --locked --no-dev
COPY . .
COPY --from=assets /app/portal/static/portal/ui.css portal/static/portal/ui.css
# Coolify injects deployment variables as build arguments. Static assets need
# only development defaults, even when those arguments are empty or unresolved.
RUN env -i PATH="$PATH" PYTHONDONTWRITEBYTECODE=1 DJANGO_DEBUG=1 DEPLOYMENT_ENV=development \
    /app/.venv/bin/python manage.py collectstatic --noinput \
    && mkdir -p var/private && chown -R portal:portal /app
USER portal
ENV PATH="/app/.venv/bin:$PATH"
EXPOSE 8000
CMD ["sh", "/app/scripts/start-web.sh"]
