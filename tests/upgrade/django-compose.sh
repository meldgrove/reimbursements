#!/usr/bin/env bash
# The updater installs images, not files: a server of the Django version
# starts this version with its old compose.yaml. This starts 0.4.0 with that
# file, installs the image under test the way the updater's deploy script
# does (version in .env, docker compose up --wait), checks it, goes back to
# 0.4.0 (the deploy script's rollback), and installs the image again.
#
#   tests/upgrade/django-compose.sh <image>     e.g. reimbursements:ci
#
# Needs Docker with Compose 2.20 or later, Node.js, curl, and the host port
# UPGRADE_TEST_PORT (default 18000).
set -euo pipefail

image=${1:?Usage: tests/upgrade/django-compose.sh <image>}
port=${UPGRADE_TEST_PORT:-18000}
root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d)
target=ghcr.io/meldgrove/reimbursements:0.0.0-upgrade-test
project=reimbursements-upgrade-test

cp "$root/tests/upgrade/compose.django.yaml" "$work/compose.yaml"
cp "$root/compose.postgres.yaml" "$work/compose.postgres.yaml"
cp "$root/tests/upgrade/compose.fakes.yaml" "$work/compose.fakes.yaml"
random() { node -e "process.stdout.write(require('crypto').randomBytes($1).toString('hex'))"; }
password=$(random 24)
token=$(random 24)
# A .env of 0.4 (.env.production.example of 0.4.0), with the bundled PostgreSQL.
cat > "$work/.env" << ENV
COMPOSE_FILE=compose.yaml:compose.postgres.yaml:compose.fakes.yaml
REIMBURSEMENTS_VERSION=0.4.0
REIMBURSEMENTS_PORT=$port
DEPLOYMENT_ENV=production
DJANGO_SECRET_KEY=$(random 40)
POSTGRES_PASSWORD=$password
DATABASE_URL=postgresql://reimbursements:$password@postgres:5432/reimbursements
HEALTHCHECK_TOKEN=$token
ALLOWED_HOSTS=reimbursements.example.invalid,localhost,127.0.0.1
CSRF_TRUSTED_ORIGINS=https://reimbursements.example.invalid
TRUSTED_PROXY_CIDRS=172.16.0.0/12
OIDC_CLIENT_ID=reimbursements
OIDC_CLIENT_SECRET=upgrade-test
KEYCLOAK_BASE_URL=http://sso.example.invalid:8080
KEYCLOAK_REALM=reimbursements
MAILERSEND_API_TOKEN=upgrade-test
MAILERSEND_WEBHOOK_SIGNING_SECRET=upgrade-test
APPROVED_DELIVERY_RECIPIENTS=finance@example.invalid
MAIL_FROM_ADDRESS=no-reply@example.invalid
MAIL_REPLY_TO_ADDRESS=finance@example.invalid
UPDATE_COOLDOWN=3d
ENV

# In the app's folder, as on a server: compose.yaml and .env from there.
compose() { (cd "$work" && docker compose --ansi never --project-name "$project" "$@"); }
finish() {
  status=$?
  if [ "$status" -ne 0 ]; then compose logs --no-color --tail 80 migrate web worker || true; fi
  compose down --volumes --remove-orphans > /dev/null 2>&1 || true
  docker image rm "$target" > /dev/null 2>&1 || true
  rm -rf "$work"
  exit "$status"
}
trap finish EXIT
docker tag "$image" "$target"

# install <version>: what the deploy script does for a request.
install() {
  echo "Installing $1"
  sed -i "s/^REIMBURSEMENTS_VERSION=.*/REIMBURSEMENTS_VERSION=$1/" "$work/.env"
  compose up --detach --wait --wait-timeout 300 --quiet-pull
}
sql() { compose exec -T postgres psql -U reimbursements -d reimbursements -tAc "$1"; }
# A session of the Django version, which migrate ends.
django_session() {
  sql "insert into django_session (session_key, session_data, expire_date) values ('upgrade-test-$1', 'e30', now() + interval '1 day')" > /dev/null
}
# Django answers its start page, server-rendered in German (through the proxy, which sets
# X-Forwarded-Proto).
django_runs() {
  curl -fsS -H "X-Forwarded-Proto: https" "http://127.0.0.1:$port/" | grep -q "Auslagen einreichen"
}
checked() {
  # Healthy by the old file's Python health checks.
  for service in web worker; do
    test "$(docker inspect --format '{{.State.Health.Status}}' "$(compose ps --quiet "$service")")" = healthy
  done
  curl -fsS -H "accept: text/html" "http://127.0.0.1:$port/admin/login" | grep -q '<div id="root">'
  curl -fsS "http://127.0.0.1:$port/api/v1/meta" | grep -q '"user":null'
  # Sign-in sends the provider back to the app's own origin (CSRF_TRUSTED_ORIGINS).
  location=$(curl -s -o /dev/null -w '%{redirect_url}' "http://127.0.0.1:$port/oidc/authenticate/")
  case "$location" in
    http://sso.example.invalid:8080/realms/reimbursements/protocol/openid-connect/auth\?*redirect_uri=https%3A%2F%2Freimbursements.example.invalid%2Foidc%2Fcallback%2F*) ;;
    *) echo "Sign-in redirects to: $location" >&2 && return 1 ;;
  esac
  test "$(sql "select count(*) from django_session")" = 0
  test "$(sql "select count(*) from drizzle.__drizzle_migrations")" -gt 0
  curl -fsS -H "X-Health-Token: $token" "http://127.0.0.1:$port/-/readyz" | grep -q '"status":"OK"'
}

install 0.4.0
django_runs
django_session 1

install "${target#*:}"
checked
echo "The image runs with the compose file of 0.4."

# The deploy script's rollback, after a later failure.
install 0.4.0
django_runs
django_session 2
echo "0.4.0 runs again on the database."

install "${target#*:}"
checked
echo "Installed again after the rollback."
