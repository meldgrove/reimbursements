FROM ghcr.io/astral-sh/uv:0.13.8@sha256:5cc1805e2426484abca4ad46ea783bab281fdb225fd82d8ce6d66a81254bac85 AS uv
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
# The release workflow sets the version; images built from source have none.
ARG APP_VERSION=""
ENV APP_VERSION=${APP_VERSION}
USER portal
ENV PATH="/app/.venv/bin:$PATH"
EXPOSE 8000
CMD ["sh", "/app/scripts/start-web.sh"]
