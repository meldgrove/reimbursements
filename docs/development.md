# Development

## Local stack

`compose.dev.yaml` runs the services the app talks to:

| Service | Address | Login |
| --- | --- | --- |
| PostgreSQL 17 | `localhost:55468`, database `reimbursement` | `reimbursement` / `reimbursement` |
| Keycloak 26 | http://localhost:8106 | console `admin` / `admin`; realm `reimbursements`: `admin` / `admin` (template admin), `editor` / `editor` (form editor) |
| ClamAV (profile `scanner`) | `localhost:3310` | none |

The realm (`dev/keycloak/reimbursements-realm.json`) has the sign-in client
`reimbursements` (secret `reimbursements-dev-client-secret`, with a group claim of full
paths) and the groups `/reimbursements/admins` and `/reimbursements/editors`.

```sh
docker compose -f compose.dev.yaml up -d
cp .env.example .env
npm ci                                   # Node.js 26
npm run db:migrate
npm run cli -- seed-demo                 # the demo form /f/demo/
npm run dev                              # http://localhost:5173
```

`npm run dev` starts the server (API, sign-in and worker; port 8000, reloads on
changes) and Vite with the web app on port 5173, which passes `/api`, `/oidc` and
`/-/` on to the server. The server reads `.env`; `APP_URL` is Vite's address, which the
development realm allows as a sign-in redirect. The participant form is at
http://localhost:5173/f/demo/, the admin area at http://localhost:5173/admin/.

Local email delivery (`MAIL_DELIVERY_MODE=local`) writes private `.eml` files under
`var/private` and never contacts MailerSend. The malware scanner is off
(`UPLOAD_SCANNER=disabled`); `docker compose -f compose.dev.yaml --profile scanner up -d`
starts ClamAV, whose first start takes several minutes, for `UPLOAD_SCANNER=clamav` and
`CLAMAV_HOST=127.0.0.1`. Use synthetic data only.

Without Keycloak, set `DEV_LOGIN=1` in `.env`, create a template admin with
`npm run cli -- create-superuser --username dev`, and sign in at
http://localhost:5173/admin/login (development mode only). `npm run cli -- help` lists
the other commands.

The repository is an npm workspace:

| Folder | What |
| --- | --- |
| `apps/server` | Hono server: the participant and admin API (`src/modules`), sign-in (`src/auth`), the services (`src/services`: intake, documents, jobs, email, retention, ...), the worker (`src/worker`), the document child and its sandbox (`src/documents`, `native/sandbox`), the database (`src/db`: Drizzle schema, migrations in `drizzle/`, the takeover of a 0.4 database in `django.ts`), operator commands (`src/commands`, `src/cli.ts`) |
| `apps/web` | React web app: the participant pages (`src/participant`) and the admin area (`src/admin`) in the app frame of `@meldgrove/ui`, TanStack Router and Query |
| `packages/shared` | API types (`src/api`), the German texts (`src/i18n`), date and number formats, countries, theme colors |

The theme, the components, the app frame and the update button come from the npm
package `@meldgrove/ui`, which the Meldgrove apps share
([meldgrove/ui](https://github.com/meldgrove/ui)).

## Document sandbox

Uploaded receipts and signatures are parsed only in a child process
(`src/documents/file-worker.ts`) that a small launcher confines with Landlock and a
native add-on with seccomp, both in `apps/server/native/sandbox`. They need Linux 6.2 or
later (Landlock ABI 3), a C compiler and, at run time, libseccomp2:
`npm run build:sandbox --workspace @reimbursements/server` builds them into
`apps/server/native/build`, and `DOCUMENT_SANDBOX_ENABLED=1` uses them. `.env.example`
sets `DOCUMENT_SANDBOX_ENABLED=0`, which reads files unconfined, for development only;
production refuses it.

## Database

A schema change: edit `apps/server/src/db/schema.ts`, then `npm run db:generate` writes
the migration. Keep the names of the Django version for existing tables, and give a new
column of an existing table a database default: 0.4 must still run on the database
after a rollback.

## Checks

CI (`.github/workflows/ci.yaml`) runs the same:

```sh
node scripts/check-public-repository.mjs
npm run lint && npm run format:check && npm run typecheck
npm test                                                   # unit tests
npm run db:generate                                        # must leave apps/server/drizzle unchanged
TEST_DATABASE_URL=postgresql://reimbursement:reimbursement@localhost:55468/reimbursements_test \
  npm run test:integration
npm run build
```

Integration tests recreate the database of `TEST_DATABASE_URL`; people running them at
the same time pick their own database name. One test takes over a database of 0.4
(`src/db/fixtures/django-0.4.sql`) and checks that it ends with the schema of a new one.
The sandbox tests need Linux with Landlock ABI 3 and libseccomp, as CI has.

`tests/upgrade/django-compose.sh <image>` starts 0.4.0 with its own `compose.yaml`,
installs the image under test the way the updater does, goes back to 0.4.0 and installs
it again. [Browser checks](browser-checks.md) describes the Playwright scripts and the
CI job that runs them against the production image.

The update button needs an updater at `UPDATER_URL` (`.env.example` leaves it empty,
which hides the button). Any server that answers the updater's API
([updates](updates.md)) works.
