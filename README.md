# Reimbursements

Meldgrove Reimbursement is a self-hosted reimbursement app. Collect expense claims,
receipts and signatures, assemble one PDF, and send it to an approved accounting
inbox. Participants receive a separate confirmation without attachments. Participants
use it in German or English; the admin area is always in English.

The app includes configurable form templates, receipt and mileage expenses, private
uploads, malware scanning, PDF compression, role-based administration, delivery
tracking, retries, retention cleanup, and health checks.

## Run locally

Requires Docker with Compose. Local delivery captures private `.eml` files and
sends no external email. `compose.yaml` is the production setup; the
`COMPOSE_FILE` line in `.env` makes these commands use `compose.dev.yaml`.

```bash
cp .env.example .env
docker compose build
docker compose up -d database scanner
docker compose run --rm web python manage.py migrate
docker compose run --rm web python manage.py seed_demo
docker compose run --rm web python manage.py createsuperuser
docker compose up -d web worker
```

Open <http://localhost:8000/f/demo/>. The admin area is at
<http://localhost:8000/admin/>. The scanner's initial startup may take several minutes.
Use synthetic data only. Database passwords in the examples are local placeholders.

For development outside Docker, install Python 3.13, uv, the system libraries listed
in `Dockerfile`, and run:

```bash
uv sync --locked
uv run python scripts/tailwind.py build
export DJANGO_DEBUG=1 DEPLOYMENT_ENV=development
uv run python manage.py migrate
uv run python manage.py seed_demo
uv run python manage.py createsuperuser
uv run python manage.py runserver
# In a second terminal with the same environment:
uv run python manage.py run_jobs
```

This development mode uses SQLite, skips malware scanning, and captures email
locally. Document confinement requires Linux Landlock ABI 3+ and libseccomp2.
A local-only fallback is available with `DOCUMENT_SANDBOX_ENABLED=0`.

## Configure a deployment

Each operator supplies their own identity and infrastructure settings. No credentials,
production data, or external account identifiers are included. Configure:

- `PORTAL_OPERATOR`, `PORTAL_LEGAL_URL` for the footer of public pages.
- `KEYCLOAK_BASE_URL`, `KEYCLOAK_REALM`, client credentials and role groups for admin sign-in.
- `MAIL_FROM_ADDRESS`, `MAIL_REPLY_TO_ADDRESS`, MailerSend credentials and approved recipients.
- PostgreSQL, private storage, malware scanner, TLS proxy and health check settings.
- Optionally `SENTRY_DSN` for error reports without claim content.

In the admin area under Admin > General, choose the app language (German or
English), timezone and date format, and optionally upload a favicon. The app language
applies to public pages, emails to participants and Finance, and the claim PDF.
Replace the initial privacy setup notice in the admin area before opening forms.
Review the declaration and retention periods for your deployment. Texts written in the
admin area, such as the privacy notice, declarations and form descriptions, are shown
as written, so write them in the app language. Payment timing is left to the
operator's support process.

Production requires PostgreSQL, Keycloak, MailerSend, ClamAV, a bounded private
document workspace, and worker heartbeat checks. Password sign-in is available
only in development. See [deployment](docs/coolify.md) and [operations](docs/operations.md).

## Manage forms

Template admins manage templates, internal accounting fields, privacy notices and
all claims. Form editors manage their own forms and see their submissions. New
forms start as drafts and save automatically. Publish a valid form, then share
`/f/<slug>/`. A primary form can serve as the start page. Forms can open and close
on a schedule. Claims retain the form configuration and consent version used at
submission.

## Development checks

```bash
uv run ruff check .
uv run ruff format --check .
DJANGO_DEBUG=1 uv run python manage.py check
DJANGO_DEBUG=1 uv run python manage.py makemigrations --check --dry-run
uv run pytest -q
node --test tests/js/*.test.cjs
python3 scripts/check_public_repository.py
```

The [CI workflow](.github/workflows/ci.yaml) runs the server suite against disposable
PostgreSQL and builds the production image. A second job starts that image with a
worker and runs the participant smoke test in Chromium and the setup check.
`compose.ci.yaml` contains only inert test settings. [Browser checks](docs/browser-checks.md)
describes the browser scripts and how to run that job locally.

Interface templates use local components and inline geometric icons. Tailwind
builds the stylesheet from `portal/assets/ui.css`. No remote fonts or client-side
CDN resources are required. Rebuild styles with `python scripts/tailwind.py build`,
or use `watch` while editing templates.

See the [form contract](docs/form-contract.md) for validation and document behavior,
and [release checks](docs/production-readiness.md) for deployment verification.

## Releases

Releases bundle the changes merged since the previous one. A major version means
an upgrade needs operator action, a minor version adds features, and a patch
fixes problems. Each release publishes the production image for amd64 and arm64
as `ghcr.io/meldgrove/reimbursements:<version>` and lists its changes on the GitHub
Releases page. Maintainers cut releases from GitHub Actions; see
[releases](docs/releases.md).
