#!/usr/bin/env bash
# The updater installs images, not files: a server of the Django version
# starts this version with its old compose.yaml. This starts 0.4.0 with that
# file and leaves queued work behind, installs the image under test the way
# the updater's deploy script does (version in .env, docker compose up
# --wait), checks it and that its worker took the work over, goes back to
# 0.4.0 (the deploy script's rollback), which reads and writes what this
# version wrote, installs the image again, and at last takes this version's
# compose.yaml with the same .env (the operator's `git pull`).
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
# MailerSend's token and signing secret of 0.4's .env, which this version ignores.
secret=$(random 24)
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
# Several https origins and one with a wildcard, as Django allowed: the first
# https origin is the app's address, and every one stays trusted.
CSRF_TRUSTED_ORIGINS=https://reimbursements.example.invalid,https://*.apps.example.invalid,https://other.example.invalid
TRUSTED_PROXY_CIDRS=172.16.0.0/12
OIDC_CLIENT_ID=reimbursements
OIDC_CLIENT_SECRET=upgrade-test
KEYCLOAK_BASE_URL=http://sso.example.invalid:8080
KEYCLOAK_REALM=reimbursements
MAILERSEND_API_TOKEN=$secret
MAILERSEND_WEBHOOK_SIGNING_SECRET=$secret
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
# What Caddy adds in front of the app.
proxied="X-Forwarded-Proto: https"
# Python in the running 0.4 image.
django() { compose exec -T web python manage.py shell -c "$1"; }

# Work 0.4 leaves behind at the switch, with its worker stopped: a receipt it
# stored, whose check is queued, and a Finance email whose worker died while
# sending it (its lease expired). The new worker must check the receipt (in
# its sandbox, from 0.4's file) and must not send the email again: the
# provider may hold it.
leave_work() {
  compose stop worker > /dev/null
  django '
import datetime, hashlib, io, uuid
from django.utils import timezone
from PIL import Image
from portal.models import Claim, Delivery, DeliveryAttempt, Draft, Form, FormTemplate, Job, Upload
from portal.services import storage
template = FormTemplate.objects.get(name="Externe Erstattung")
form = Form.objects.create(template=template, slug="upgrade", name="Upgrade test", field_values={"kst": "UP"}, recipient="finance@example.invalid", support_email="finance@example.invalid", status="published")
draft = Draft.objects.create(form=form, session_hash="0" * 64, token_hash="0" * 64, revision="upgrade")
buffer = io.BytesIO()
Image.new("RGB", (400, 300), "white").save(buffer, "PNG")
content = buffer.getvalue()
upload = Upload.objects.create(draft=draft, original_name="receipt.png", source_key="", size=len(content), checksum=hashlib.sha256(content).hexdigest())
upload.source_key = storage.upload_source_key(upload.pk, ".png")
storage.write_bytes(upload.source_key, content)
upload.save()
Job.objects.create(key=f"validate:{upload.pk}", kind="validate", upload=upload)
claim = Claim.objects.create(form=form, full_name="Upgrade Test", email="upgrade@example.invalid", street="Teststr. 1", postal_code="12345", city="Berlin", country="DE", account_holder="Upgrade Test", iban="DE89370400440532013000", purpose="Upgrade test", snapshot={}, total="1.00", state="ready")
delivery = Delivery.objects.create(claim=claim, recipient="finance@example.invalid", state="sending")
DeliveryAttempt.objects.create(delivery=delivery, state="sending")
Job.objects.create(key=f"send:{delivery.pk}", kind="send", delivery=delivery, state="running", attempts=1, lease_token=uuid.uuid4(), lease_until=timezone.now() - datetime.timedelta(minutes=5))
'
}

# The new worker took the work over: the receipt checked from 0.4's file, the
# interrupted email left alone (its outcome unknown, nothing sent again).
work_taken_over() {
  for _ in $(seq 60); do
    test "$(sql "select state from portal_job where kind = 'validate'")" = "done" && break
    sleep 2
  done
  test "$(sql "select state from portal_job where kind = 'validate'")" = "done"
  test "$(sql "select state from portal_upload")" = ready
  test "$(sql "select count(*) from portal_upload where normalized_key <> ''")" = 1
  test "$(sql "select state from portal_job where kind = 'send'")" = failed
  test "$(sql "select string_agg(state, ',') from portal_deliveryattempt")" = send_unknown
  test "$(sql "select count(*) from portal_job where kind = 'send'")" = 1
}

# The operator commands 0.4's guides told operators to run or schedule run as
# the cli commands of the same name; any other `manage.py` command is refused.
old_commands_run() {
  preview=$(compose exec -T web python manage.py purge_expired)
  grep -q '^{' <<< "$preview"
  compose exec -T web python manage.py claim_status --state ready > /dev/null
  # --option=value as argparse took it: an unknown state is refused, not ignored.
  status=0
  compose exec -T web python manage.py claim_status --state=unknown > /dev/null 2>&1 || status=$?
  test "$status" = 1
  compose exec -T web python manage.py verify_storage > /dev/null
  status=0
  compose exec -T web python manage.py shell -c 'print(1)' > /dev/null 2>&1 || status=$?
  test "$status" = 127
}

# The operator command runs in a one-off container of the compose file and in the running
# web container (`cli` on the PATH). The email variables of 0.4's .env are ignored.
operator_command_runs() {
  listed=$(compose run --rm -T migrate cli settings list 2> /dev/null)
  grep -q '^email  *not set' <<< "$listed"
  shown=$(compose exec -T web cli settings show email)
  grep -q '"provider": ""' <<< "$shown"
  if grep -q "$secret" <<< "$listed$shown"; then
    echo "cli settings printed a secret" >&2
    return 1
  fi
}

# A row this version writes with the database's sequences (a user, as the
# development command makes it), which 0.4 reads and changes after the
# rollback, and then adds a row of its own with the same sequence.
write_with_new_version() {
  compose exec -T -e DEPLOYMENT_ENV=development -e DJANGO_DEBUG=1 web docker-entrypoint.sh cli create-superuser --username upgrade-05 > /dev/null
}
django_reads_and_writes() {
  django '
from django.contrib.auth.models import User
from portal.models import Upload
from portal.services import storage
user = User.objects.get(username="upgrade-05")
user.first_name = "Rolled back"
user.save()
User.objects.create_user("upgrade-04")
upload = Upload.objects.get()
assert upload.state == "ready" and storage.path_for(upload.normalized_key).is_file()
'
  test "$(sql "select first_name from auth_user where username = 'upgrade-05'")" = "Rolled back"
  test "$(sql "select count(*) from auth_user where username in ('upgrade-05', 'upgrade-04')")" = 2
}
# A session of the Django version, which migrate ends.
django_session() {
  sql "insert into django_session (session_key, session_data, expire_date) values ('upgrade-test-$1', 'e30', now() + interval '1 day')" > /dev/null
}
# Django answers its start page, server-rendered in German (through the proxy, which sets
# X-Forwarded-Proto).
django_runs() {
  curl -fsS -H "X-Forwarded-Proto: https" "http://127.0.0.1:$port/" | grep -q "Auslagen einreichen"
}
# The answer to a change sent from the browser origin $1: its body, a space and its status.
origin_answer() {
  curl -sS -w ' %{http_code}' -X POST -H "$proxied" -H "Origin: $1" -H "content-type: application/json" \
    --data '{}' "http://127.0.0.1:$port/api/v1/public/forms/upgrade/validate"
}
checked() {
  # Healthy by the compose file's health checks (0.4's call Python).
  for service in web worker; do
    test "$(docker inspect --format '{{.State.Health.Status}}' "$(compose ps --quiet "$service")")" = healthy
  done
  # Plain HTTP goes to the HTTPS address, as with Django's SECURE_SSL_REDIRECT.
  test "$(curl -s -o /dev/null -w '%{redirect_url}' "http://127.0.0.1:$port/f/demo/")" = \
    "https://reimbursements.example.invalid/f/demo/"
  curl -fsS -H "$proxied" -H "accept: text/html" "http://127.0.0.1:$port/admin/login" | grep -q '<div id="root">'
  curl -fsS -H "$proxied" "http://127.0.0.1:$port/api/v1/meta" | grep -q '"user":null'
  # Sign-in sends the provider back to the app's own origin (CSRF_TRUSTED_ORIGINS).
  location=$(curl -s -o /dev/null -w '%{redirect_url}' -H "$proxied" "http://127.0.0.1:$port/oidc/authenticate/")
  case "$location" in
    http://sso.example.invalid:8080/realms/reimbursements/protocol/openid-connect/auth\?*redirect_uri=https%3A%2F%2Freimbursements.example.invalid%2Foidc%2Fcallback%2F*) ;;
    *) echo "Sign-in redirects to: $location" >&2 && return 1 ;;
  esac
  # Every origin of CSRF_TRUSTED_ORIGINS stays trusted for changes, as in 0.4: the request
  # reaches the form, which knows no draft without one (404). Other origins are refused (403).
  for origin in https://other.example.invalid https://forms.apps.example.invalid; do
    answer=$(origin_answer "$origin")
    case "$answer" in
      *'"code":"intake_error"'*' 404') ;;
      *) echo "The trusted origin $origin got: $answer" >&2 && return 1 ;;
    esac
  done
  answer=$(origin_answer https://attacker.example.invalid)
  case "$answer" in
    *'"Cross-site request rejected"'*' 403') ;;
    *) echo "The origin https://attacker.example.invalid got: $answer" >&2 && return 1 ;;
  esac
  test "$(sql "select count(*) from django_session")" = 0
  test "$(sql "select count(*) from drizzle.__drizzle_migrations")" -gt 0
  curl -fsS -H "X-Health-Token: $token" "http://127.0.0.1:$port/-/readyz" | grep -q '"status":"OK"'
}

install 0.4.0
django_runs
django_session 1
leave_work

install "${target#*:}"
checked
work_taken_over
old_commands_run
operator_command_runs
write_with_new_version
echo "The image runs with the compose file of 0.4 and took over its queued work."

# The deploy script's rollback, after a later failure.
install 0.4.0
django_runs
django_session 2
django_reads_and_writes
echo "0.4.0 runs again on the database, and reads and writes what this version wrote."

install "${target#*:}"
checked
echo "Installed again after the rollback."

# The operator's `git pull`: this version's compose.yaml, the same .env of 0.4.
cp "$root/compose.yaml" "$work/compose.yaml"
compose up --detach --wait --wait-timeout 300 --quiet-pull
checked
operator_command_runs
echo "Runs with its own compose.yaml and the .env of 0.4."
