# Reimbursements

Meldgrove Reimbursement is a self-hosted reimbursement app. Collect expense claims,
receipts and signatures, assemble one PDF, and send it to an approved accounting
inbox. Participants receive a separate confirmation without attachments. Participants
use it in German or English; the admin area is always in English.

The app includes configurable form templates, receipt and mileage expenses, private
uploads, malware scanning, PDF compression, role-based administration, delivery
tracking, retries, retention cleanup, and health checks. Since 0.5 it is written in
TypeScript on the stack of the other Meldgrove apps: a Hono server with Drizzle on
PostgreSQL, and a React web app (Vite, TanStack Router and Query) built from
`@meldgrove/ui`. Up to 0.4 it was a Django app; 0.5 takes over its database in place
([upgrade from 0.4](docs/deployment.md#upgrade-from-04)).

## Run locally

Requires Docker with Compose and Node.js 26. `compose.dev.yaml` runs PostgreSQL and a
Keycloak with a ready realm; the app runs on the host. Local delivery writes private
`.eml` files and sends no external email.

```bash
docker compose -f compose.dev.yaml up -d
cp .env.example .env
npm ci
npm run db:migrate
npm run cli -- seed-demo
npm run dev
```

Open <http://localhost:5173/f/demo/>. The admin area is at
<http://localhost:5173/admin/>: sign in with `admin` / `admin` (template admin) or
`editor` / `editor` (form editor). Use synthetic data only. Passwords in the examples
are local placeholders. [Development](docs/development.md) covers the stack, the
document sandbox, the database and the checks.

## Configure a deployment

Each operator supplies their own identity and infrastructure settings. No credentials,
production data, or external account identifiers are included. Configure:

- `KEYCLOAK_BASE_URL`, `KEYCLOAK_REALM` (or `OIDC_ISSUER` for another OpenID Connect
  provider), client credentials and role groups for admin sign-in.
- `APPROVED_DELIVERY_RECIPIENTS`, the Finance inboxes forms may send to.
- PostgreSQL, private storage, malware scanner, TLS proxy and health check settings.
- Optionally `SENTRY_DSN` for error reports without claim content.

In the admin area under Admin > General, enter the operator's name and legal page for
the footer of public pages, and choose the app language (German or English), timezone,
date format and number format (European 12,50 by default, or US 12.50). The app
language applies to public pages, emails to participants and Finance, and the claim
PDF. Under Admin > Email, choose how the app sends email: MailerSend with an API token,
or an SMTP server. Set the sender address there, and turn the participant confirmation
off or write its subject and text; a test email checks the connection. Forms take no
claims until email is set up. Operators, and AI with access to the server, set the same
settings with `cli settings` ([operator commands](docs/deployment.md#operator-commands));
the environment no longer holds them. Under Admin > Appearance, optionally
set an accent color as a hex code and upload a favicon; both apply to public pages
and the admin area. Without an accent color, the app uses the colors every Meldgrove
app shares.
Replace the initial privacy setup notice in the admin area before opening forms.
Review the declaration and retention periods for your deployment. Texts written in the
admin area, such as the privacy notice, declarations and form descriptions, are shown
as written, so write them in the app language. Payment timing is left to the
operator's support process.

Production requires PostgreSQL, Keycloak (or another OpenID Connect provider),
MailerSend or an SMTP server, ClamAV, Linux 6.2 or later for the document sandbox, a bounded private
document workspace, and worker heartbeat checks. The development sign-in exists only
in development. See [deployment](docs/deployment.md) on a Linux server (Debian,
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
node scripts/check-public-repository.mjs
npm run lint && npm run format:check && npm run typecheck
npm test
npm run test:integration          # PostgreSQL of compose.dev.yaml
```

The [CI workflow](.github/workflows/ci.yaml) runs these, checks that the migrations
match the schema, builds the production image, checks its document sandbox and runs
the upgrade from 0.4 with 0.4's own `compose.yaml`. A second job starts that image with
a worker and runs the participant and admin browser checks in Chromium and the setup
check. [Browser checks](docs/browser-checks.md) describes the browser scripts.

The interface is the shared Meldgrove one: the theme, the components, the app frame
(sidebar with the search and the person's menu, header with the breadcrumbs, keyboard
shortcuts), the sign-in page, the cards of the person's Settings page and the update
button come from the npm package `@meldgrove/ui`
([meldgrove/ui](https://github.com/meldgrove/ui)), so a change there reaches this app
with its next version of the package. The keys are the package's: ⌘K or Ctrl+K and
"/" search, "G then O" opens Claims and "G then F" Forms, Ctrl+/ lists the shortcuts
and ⌘B or Ctrl+B hides the sidebar. The participant pages use the same theme and
components without the frame.

See the [form contract](docs/form-contract.md) for validation and document behavior,
and [release checks](docs/production-readiness.md) for deployment verification. The
words the code and docs use are in [CONTEXT.md](CONTEXT.md).

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
