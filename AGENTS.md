# AGENTS.md

Meldgrove Reimbursement: a TypeScript app (Node.js 26, PostgreSQL) that collects
expense claims with receipts and signatures, builds one PDF per claim and sends it to an
approved accounting inbox. npm workspaces: `apps/server` (Hono, Drizzle), `apps/web`
(React, Vite, TanStack Router and Query, `@meldgrove/ui`) and `packages/shared` (API
types, German texts, formats). One image, three processes: `migrate`, `web` and
`worker` (`APP_ROLE`, `docker-entrypoint.sh`), plus `cli` for operator commands.
Versions up to 0.4 were a Django app.

- Domain language: `CONTEXT.md`. Field rules: `docs/form-contract.md`.
- Server modules keep the names and functions of the Django modules they replaced
  (`portal/services/drafts.py` became `apps/server/src/services/drafts.ts`).
- Uploaded files are parsed only in the document child (`src/documents/file-worker.ts`),
  which the launcher and add-on in `apps/server/native/sandbox` confine with Landlock
  and seccomp before any parser loads. The server process never reads an uploaded file
  with sharp, the PDF libraries or pdfmake; it goes through `services/documents.ts`
  (the setup check uses sharp only to draw its synthetic images).
- Every email goes through `services/outbound.ts`; claim status has one rule in
  `services/claim-status.ts`; retries, deletions and archiving go through
  `services/operations.ts`. Transactions go through `db/tx.ts` (`atomic`, `q()`,
  `onCommit`).
- The database keeps the table, column, constraint and index names of the Django
  version (`db/schema.ts`); `db/django.ts` takes over a 0.3/0.4 database in place. Add
  columns to existing tables with a database default, so 0.4 still runs after a
  rollback. Migrations: `npm run db:generate`.
- Logs and error reports never contain claim content: no names, addresses, IBANs,
  receipt text or error messages of libraries.
- Participant texts are English in the code and German in
  `packages/shared/src/i18n/de.ts`, through `t()`; the admin area is English only.
- The image must keep starting with the Compose files of earlier versions
  (`docker-django-compat.sh` answers their `python` commands); `tests/upgrade/` checks it.
- The web app shows the admin pages in the app frame of `@meldgrove/ui`; the update
  button and the Updates card come from the package too, and so do the server's update
  routes (`@meldgrove/ui/updates/server`). The server build bundles it from the root
  devDependency: in the server's dependencies, npm would put React into the image.
- The repository is public and Apache 2.0. Use only `example.invalid` in examples;
  `scripts/check-public-repository.mjs` must pass.

## Checks

```sh
node scripts/check-public-repository.mjs
npm run lint && npm run format:check && npm run typecheck
npm test                                                   # unit tests
TEST_DATABASE_URL=postgresql://reimbursement:reimbursement@localhost:55468/reimbursements_test \
  npm run test:integration
npm run db:generate                                        # must leave apps/server/drizzle unchanged
```

The browser checks (`tests/browser`) need the app with a worker and the demo form; see
`docs/browser-checks.md`. CI runs everything above on every pull request.
