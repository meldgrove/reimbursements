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

For development outside Docker, install Python 3.13, uv, Node.js 26, the system
libraries listed in `Dockerfile`, and run:

```bash
uv sync --locked
npm ci
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
English), timezone, date format and number format (European 12,50 by default, or US
12.50). The app language applies to public pages, emails to participants and Finance,
and the claim PDF. Under Admin > Appearance, optionally
set an accent color as a hex code and upload a favicon; both apply to public pages
and the admin area. Without an accent color, the app uses the colors every Meldgrove
app shares.
Replace the initial privacy setup notice in the admin area before opening forms.
Review the declaration and retention periods for your deployment. Texts written in the
admin area, such as the privacy notice, declarations and form descriptions, are shown
as written, so write them in the app language. Payment timing is left to the
operator's support process.

Production requires PostgreSQL, Keycloak, MailerSend, ClamAV, a bounded private
document workspace, and worker heartbeat checks. Password sign-in is available
only in development. See [deployment](docs/deployment.md) on a Linux server (Debian,
Ubuntu), or [with Coolify](docs/coolify.md), and [operations](docs/operations.md).

## Manage forms

Template admins manage templates, internal accounting fields, privacy notices and
all claims. Form editors manage their own forms and see their submissions. New
forms start as drafts and save automatically. Publish a valid form, then share
`/f/<slug>/`. A primary form can serve as the start page. Forms can open and close
on a schedule. A form takes claims while it is published, within its opening times,
its internal values fit its template, its receiving inbox is one of
`APPROVED_DELIVERY_RECIPIENTS` and a privacy notice exists. The start page redirects
only then, and the forms list's Open now column shows it, naming what keeps an open
form from taking claims. Claims retain the form configuration and consent version used at
submission. Archive forms and claims you are done with to keep the lists short; the
Status filter's Archived option lists them again.

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

The admin area looks like every other Meldgrove app. Their React interface package,
`@meldgrove/ui`, cannot render Django's pages, so the app rebuilds its parts on the
server with the same class names: the app frame (`admin/base.html`, `frame.css` and
`frame.js`: the sidebar with the search and the person's menu, the header with the
breadcrumbs, the keyboard shortcuts), the page header, the sign-in page and the
person's Settings page, and the components in `ui.css` (buttons, badges, cards,
alerts, fields). A change of these in the package belongs here too. The keys are the
package's: ⌘K or Ctrl+K and "/" search, "G then O" opens Claims and "G then F" Forms,
Ctrl+/ lists the shortcuts and ⌘B or Ctrl+B hides the sidebar. Appearance (light, dark
or the device's setting) and the single-letter keys are kept in the browser, under the
same names as in the other apps.

The colors, the update button and the eye button of the password field come from
`@meldgrove/ui` itself. `npm ci` copies three of its files to
`portal/static/portal/vendor/` (ignored by git): `tokens.css`, the colors light and dark,
which `ui.css` imports, `meldgrove-updates.js`, the custom elements
`<meldgrove-update-button>` and `<meldgrove-updates-settings>`, and
`meldgrove-secret-input.js` for the local development sign-in. Run `npm ci` again after
an update of the package, then rebuild the styles; the Docker image does both. `ui.css`
adds the status colors the package does not have. Dark mode is the class `dark` on
`<html>`, which `portal/static/portal/theme.js` sets before the page shows.

See the [form contract](docs/form-contract.md) for validation and document behavior,
and [release checks](docs/production-readiness.md) for deployment verification.

## Releases

Releases bundle the changes merged since the previous one. Below 1.0.0, a patch brings
fixes and features that need no operator action, and a minor version is a release that
operators must act on (its notes say how). Each release publishes the production image for amd64 and arm64
as `ghcr.io/meldgrove/reimbursements:<version>` and lists its changes on the GitHub
Releases page. Maintainers cut releases from GitHub Actions; see
[releases](docs/releases.md). Deployments can install new releases automatically with
the `updater` service, or previews of unreleased changes. Template admins see new
versions in the admin header, install them from there, and choose the channel under
Admin > Updates; see [automatic updates](docs/updates.md).

## License

Copyright 2026 Meldgrove

Licensed under the [Apache License 2.0](LICENSE).
