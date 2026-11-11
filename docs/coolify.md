# Deploy with Coolify

Use `compose.coolify.yaml` for the web process, worker, scanner and migration job.
Run PostgreSQL as a separate resource on the same private network. Route only the
web service to a public HTTPS hostname. Keep all persistent volumes across upgrades.
The `exclude_from_hc` field is a Coolify extension. Use `compose.yaml` locally.

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

Set `PORTAL_NAME`, `PORTAL_OPERATOR` and `PORTAL_LEGAL_URL`. Set `MAIL_FROM_ADDRESS`
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

## First launch and upgrades

Deploy, then sign in at `/admin/`. Replace the initial privacy setup text with your
operator's notice, review the template declaration, and create a form with an
approved recipient, support address and required internal values. Publish and send
a synthetic claim before accepting participant data. Verify the PDF, participant
confirmation, signed delivery callbacks and retention cleanup.

Run the [release checks](production-readiness.md). The migration job must complete
before web and worker start. For upgrades, stop old workers before migrations and
preserve database, private files and scanner volumes. Back up the database and
private files together before deployment.
