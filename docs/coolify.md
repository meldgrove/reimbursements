# Deploy with Coolify

Use `compose.yaml` for the web process, worker, scanner and migration job: create a
Docker Compose resource from this repository and set its Docker Compose location to
`/compose.yaml`. It runs the published release image; `REIMBURSEMENTS_VERSION` names
the release series, such as `0.2` (see [automatic updates](updates.md)). Run
PostgreSQL as a separate resource on the same private network. Route only the web
service to a public HTTPS hostname. Keep all persistent volumes across upgrades. Use
`compose.dev.yaml` locally.

## Database and storage

Create a PostgreSQL database and enable the application's access to its private
network. Set `DATABASE_URL` to the internal connection URL. Keep database and
private-file backups together. The application owns a persistent `private_data`
volume and a bounded 700 MB tmpfs workspace on web and worker. The scanner has
its own signature database volume.

## Admin sign-in

Create a confidential OpenID Connect client in your Keycloak realm. Enable the
authorization code flow, disable implicit and direct password grants, and enable
PKCE S256. Configure the following against your public hostname:

| Setting | Example |
| --- | --- |
| Redirect URI | `https://reimbursements.example.invalid/oidc/callback/` |
| Web origin | `https://reimbursements.example.invalid` |
| Post-logout redirect | `https://reimbursements.example.invalid/` |

Add a group membership mapper that includes full paths in the verified ID token.
Only users with a verified email and a mapped portal group may sign in.

| Environment variable | Default group | Access |
| --- | --- | --- |
| `KEYCLOAK_ADMIN_GROUP` | `/reimbursements/admins` | Templates, notices, all forms and claims |
| `KEYCLOAK_EDITOR_GROUP` | `/reimbursements/editors` | Own forms and their submissions |

Set `KEYCLOAK_BASE_URL`, `KEYCLOAK_REALM`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`.
Membership is refreshed at every sign-in. Admin sessions expire after eight hours.

## Application settings

Copy `.env.coolify.example` into the environment editor and replace all placeholder
values. Set the public hostname in `ALLOWED_HOSTS`, the HTTPS origin in
`CSRF_TRUSTED_ORIGINS`, and the actual proxy network ranges in
`TRUSTED_PROXY_CIDRS`. Include `127.0.0.1` in allowed hosts for container probes.

Set `PORTAL_OPERATOR` and `PORTAL_LEGAL_URL`. The app language, timezone and date
format are set after the first sign-in under Admin > General, the accent color and
favicon under Admin > Appearance. Set `MAIL_FROM_ADDRESS`
to an address in a verified MailerSend domain, and `MAIL_REPLY_TO_ADDRESS` to a
monitored inbox. `APPROVED_DELIVERY_RECIPIENTS` lists every inbox a form may send to.
For staging, also set a nonempty `TEST_RECIPIENT_ALLOWLIST`; it restricts accounting
and participant messages. Do not make production receipts available to staging.

Supply MailerSend API credentials and a webhook signing secret. Create a version
2 webhook at `https://reimbursements.example.invalid/webhooks/mailersend/`, using
your actual hostname. Subscribe to supported sent, delivered, deferred, bounced
and suppressed events. Disable provider tracking. See [operations](operations.md)
for ambiguous delivery outcomes and retry controls.

Optionally set `SENTRY_DSN` for error reports from web, worker and migrations. See
[operations](operations.md#monitoring-and-maintenance) for what a report contains.

Optionally set `UPDATE_DEPLOY_HOOK_URL` and `UPDATE_DEPLOY_HOOK_TOKEN`: the `updater`
service then installs new releases of the series automatically.
[Automatic updates](updates.md) explains where Coolify shows both values, and the
backups to set up first.

## First launch and upgrades

Deploy, then sign in at `/admin/`. Replace the initial privacy setup text with your
operator's notice, review the template declaration, and create a form with an
approved recipient, support address and required internal values. Then run
`python manage.py verify_setup --to <an approved Finance inbox>` in the web container.
It sends a synthetic claim through the scanner, document sandbox, MailerSend and the
signed delivery webhook, and deletes it again; see
[setup check](operations.md#setup-check). Publish your form and send a synthetic claim
through it before accepting participant data, and verify its PDF.

Run the [release checks](production-readiness.md). The migration job must complete
before web and worker start. For upgrades, stop old workers before migrations and
preserve database, private files and scanner volumes. Back up the database and
private files together before a manual upgrade; automatic updates rely on scheduled
backups instead.
Before a manual upgrade, read the GitHub release notes of every version since the
deployed one; they list the upgrade steps a release needs. See
[releases](releases.md) and [automatic updates](updates.md).
