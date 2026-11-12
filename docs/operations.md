# Deployment and operations

## Configure and launch

Follow [Coolify deployment](coolify.md). The application is one Coolify resource
(web, worker, ClamAV, migrations) on one domain; PostgreSQL is a separate Coolify
database resource reached through Connect To Predefined Network. Forms, templates,
the privacy notice and the General settings (app language, timezone, date format,
favicon) are managed in the admin area at `/admin/`, which signs in through Keycloak
and grants roles from the `groups` claim.

Use a TLS reverse proxy for the public hostname. Expose only the web
HTTP service. Do not publish PostgreSQL, ClamAV, worker, or storage ports.
`compose.yaml` publishes no host port; Coolify routes directly to the web
container. Do not add a second reverse proxy.

For production set `DJANGO_DEBUG=0`, a random `DJANGO_SECRET_KEY`, production
PostgreSQL credentials/URL, `ALLOWED_HOSTS`, `CSRF_TRUSTED_ORIGINS`, and
`DEPLOYMENT_ENV=production`. Set `TRUST_PROXY_HEADERS=1` only when the existing
proxy replaces forwarded protocol headers. Configure:

- `MAIL_DELIVERY_MODE=mailersend`, `MAILERSEND_API_TOKEN` and
  `MAILERSEND_WEBHOOK_SIGNING_SECRET`. Set `MAIL_FROM_ADDRESS` to an address on a
  verified sender domain and `MAIL_REPLY_TO_ADDRESS` to the support inbox.
- `APPROVED_DELIVERY_RECIPIENTS`, comma-separated approved Buchhaltung inboxes.
  Admins choose a form's recipient from this list.
- `KEYCLOAK_BASE_URL`, `KEYCLOAK_REALM`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`, with
  `KEYCLOAK_ADMIN_GROUP` / `KEYCLOAK_EDITOR_GROUP` for other group paths.
- `UPLOAD_SCANNER=clamav`, its private host/port, and `HEALTHCHECK_TOKEN`.
- Persistent encrypted database/private storage volumes and an independent,
  encrypted off-host backup destination. Backup keys remain outside Git.

A change to what participants agree to or are validated against (the declaration,
the privacy notice, purpose options, travel mode or mileage rate) gives the form a new
revision. Unsubmitted forms from an older revision must reload and review again; other
edits, such as autosaved wording or opening times, leave them open. Accepted claims
keep their original configuration snapshot. Stop web and
worker before migrations, then replace both with the new image. Old workers must
not create reservations during this upgrade.
Locally, without Keycloak, create an admin with `python manage.py createsuperuser`
and sign in with a password; `python manage.py seed_demo` creates the form
`/f/demo/`. Password sign-in exists only in development mode.
Only one worker process is supported operationally; its queue uses row locks and
leases and acquires ready jobs in FIFO order across validation, rendering and
sending. Later uploads cannot indefinitely overtake accepted claims.

The Django deployment check leaves HSTS preload disabled and suppresses only its
optional preload warning. TLS redirection, secure cookies, and HSTS are enabled in production.
Decide preload enrollment with the owner of the selected public domain.

The supplied image requires Linux x86_64/aarch64, Landlock ABI 3 or newer and
libseccomp. Startup and readiness run a real confinement probe. Document children
can read only their selected inputs and trusted runtime/font files, can write only
their own workspace, and cannot open network sockets. Keep the private 700 MB
tmpfs mount at `PRIVATE_STORAGE_ROOT/work` on both web and worker. Startup rejects
a missing, shared or unbounded workspace in production. This mount is separate
from persistent source/PDF storage; publishing copies files atomically between them.
Workspace reservations charge the tmpfs allowance there and reserve only the
bounded normalized/final output on persistent storage. Local setups sharing one
filesystem reserve both against that filesystem.
Keep the supplied web/worker limit of 64 processes/threads per container. The
syscall filter also denies signaling and changing another process's resource or
scheduling limits, including pidfd and queued-signal variants.

Use completely separate staging databases, files, credentials, and recipients.
Set `DEPLOYMENT_ENV=staging` and a nonempty `TEST_RECIPIENT_ALLOWLIST`. The send
adapter checks that list as well as the approved recipient list.

## Draft admission

New drafts share a PostgreSQL-backed budget across sessions and web processes.
`MAX_DRAFTS_PER_NETWORK` defaults to 300 creations per 24 hours per IPv4 address or
IPv6 /48, allowing the expected 250 participants to share a venue connection. An
IPv6 /48 is one site: a single customer or tunnel holds thousands of /64s, which must
not count as separate networks. `MAX_ACTIVE_DRAFTS` (10,000) limits open drafts across
all networks; keep it far above the per-network budget, or a few networks can open
every draft and turn all new participants away.
Existing drafts remain accessible after the creation limit is reached. No raw IP
address is stored in the counter, and inactive counter keys expire after two days.
Set `TRUSTED_PROXY_CIDRS` to the exact reverse-proxy networks if the application
receives proxied requests. The proxy must replace or correctly append
`X-Forwarded-For`; the app walks that chain from the trusted connection to the first
untrusted address. With no trusted proxies configured, it uses `REMOTE_ADDR`.
Configure the edge's connection/request limits as well and monitor 429/503 rates.

Upload admission also charges cumulative processing work: 200 uploads / 150 MB per
draft and 5,000 uploads / 15 GB per network per day, with 1,000 uploads per network
per minute. That is ample for one venue of 250 participants, and it bounds how long a
single network can keep the shared validation queue full: about as long as the worker
needs for its daily uploads. Deleting or replacing a file does not refund those
counters. A pending upload reserves 10 MB for normalization; each draft permits
100 MB of derived and reserved data. Normalized images are resized and capped at
10 MB of serialized output. A global database lock protects admission against
concurrent processes, including the configured free-space floor, request-spooling
headroom and active execution reservations. At most 1,000 validations may be
queued/running. Tune the documented environment limits against measured deployment
capacity before launch.

## MailerSend and handoff

Create a version 2 webhook for sent, delivered, deferred, soft/hard bounced, and
suppressed events at `/webhooks/mailersend/`. Check which events the account plan
supports. The endpoint verifies raw-body signatures, handles the signed setup
ping, and records minimal deduplicated events. Opaque attempt tags can correlate
a callback arriving before the send response commits. Disable open/click/content
tracking, as the provider adapter requests.

A locally accepted claim is not a payment approval. API acceptance is not email
delivery, and recipient-server delivery is not proof of completed accounting processing.
The merged PDF is the authoritative document in the configured accounting workflow.
Content purge is always on; no environment variable turns it off or changes its
periods. `PDF_RETENTION_DAYS` (7) and `CONTENT_RETENTION_DAYS` (90) in
`config/settings.py` are the periods the privacy notice states; change them only
together with the notice, the summary on the form page and a migration that
publishes the updated notice. An already started purge always resumes.

Run the [setup check](#setup-check) before launch, then a complete dummy claim
through one of your forms and the approved MailerSend route. Check all pages,
KST/KTR, declaration, signature, amounts, and compressed readability. The service compresses the complete PDF in bounded passes down to
72 DPI / JPEG quality 50. If the complete document still exceeds the configured
cap, it remains a processing exception. No page is silently removed and no partial
attachment is sent. Inspect the retained sources and resolve with Finance through
an approved private process.

## Setup check

After the first launch, each upgrade and any change of credentials, run in the web
container, with the worker running:

```bash
python manage.py verify_setup --to finance@your-org.example.invalid
```

It checks the database, private storage, the worker's heartbeat, the document sandbox,
ClamAV (including that it detects the EICAR test file) and the Keycloak realm's issuer,
endpoints and signing key. Then it submits a synthetic claim through a temporary form:
receipt and signature uploads, scanning, normalization, the PDF, the Finance email and
the participant confirmation. With MailerSend it waits for the signed delivery webhook
and the delivery. Each step prints `ok`, `skip` or `FAIL` with what to fix, and the
command exits nonzero on any failure.

`--to` must be one of `APPROVED_DELIVERY_RECIPIENTS`; that inbox receives a PDF titled
"Setup check (not a real claim)". `--confirmation-to` receives the participant
confirmation and defaults to `--to`. In staging, both must be on
`TEST_RECIPIENT_ALLOWLIST`. `--timeout` (default 300 seconds) is how long the test
claim may take, MailerSend's webhook included.

The claim takes no bookkeeping reference, so Finance's numbering has no gap; its emails
name its UUID. The check deletes the claim, form and template at the end, also after a
failure, and logs the deletion with the actor `verify_setup`. The emails stay in the
inboxes. Group mapping needs a person: sign in at `/admin/` once with each role.

## Recovery commands

Template admins can retry a claim in the admin area (Claims > Process again);
it records their sign-in address and reason. Form editors see the claims of their
forms, with name, email, total and status, but no banking or receipt data.

Template admins can also delete claims, for example test submissions: **Delete** on
a claim, or the list action **Delete selected claims** for up to 100 at once.
A confirmation page lists the claims and says whether Finance may already hold their
PDF; deletion needs a reason and records it with their address. It deletes the claim
immediately: the claim, its files, personal and banking data are removed, it no longer
appears in the list, and pending processing or sending stops. A claim that is currently
being rendered or sent cannot be deleted until that finishes. A copy already sent to
Finance or downstream systems is not affected. The logged action is kept without a link
to the claim. Each deletion also logs `claim_deleted reference=<uuid>`.

The commands below run through authorized host access and record the host actor.
Use operational reasons without participant names, account details, or receipt text.

```bash
python manage.py claim_status
python manage.py claim_status --state processing_failed
python manage.py claim_status --status send_unknown
python manage.py claim_status CLAIM_UUID
python manage.py reconcile_deliveries --batch-size 100
python manage.py verify_storage
python manage.py retry_claim CLAIM_UUID --reason 'Resolved the sender configuration'
python manage.py retry_claim CLAIM_UUID --reason 'Provider activity checked; intentional resend' \
  --acknowledge-duplicate-risk
python manage.py purge_expired
python manage.py purge_expired --execute
```

`--status` filters by the status the admin list shows: the claim state until a Finance
delivery exists, then the delivery state, and `purging` while a claim is being deleted.
`claim_status` and `retry_claim` also accept the full readable bookkeeping reference.
It includes the participant's surname; the internal UUID remains available for
operational correlation until content purge deletes the claim.

`retry_claim` records the host actor and reason. It retries failed renders only
before a PDF has become ready, and cannot resend once the PDF has been deleted. Delivery retries reuse the existing immutable PDF
and destination. An ambiguous send, paused/accepted send, or intentional resend
requires explicit duplicate-risk acknowledgment. A new claim is required for
changed participant data; Finance handles replacement and late-submission policy.
If a closed form needs another claim, reopen it in the admin area. The MVP has no automatic replacement or payment cancellation.

An interrupted send or a timeout after transmission can mean MailerSend accepted
the message. These cases become `send_unknown` and do not auto-retry. Inspect
provider activity first. Signed events with an attempt tag may resolve the case.
A failure before transmission, such as a missing or corrupt PDF or a blocked
recipient, is a definite `failed` delivery and can be retried without
acknowledgment once its cause is fixed.
The reconciliation command queries the known message IDs of Finance deliveries and
participant confirmations without resending; an unknown send without a message ID
requires manual provider lookup. A `queued` provider status resolves `send_unknown` to
accepted.
Reconciliation treats MailerSend's `rejected` email status as a terminal failure,
using suppression or hard-bounce details when present. It retains the PDF for
resolution and never resends automatically.

## Monitoring and maintenance

`/-/healthz` checks only process liveness and reports the release version. `/-/readyz` checks database, writable
storage/capacity, document confinement, the bounded workspace, scanner PING,
worker heartbeat and oldest ready-job age (default maximum 900 seconds).
Production probes require `X-Health-Token`. Health checks do not call MailerSend.
The worker updates `worker-heartbeat` in private storage; heartbeat checks permit
the bounded document-processing interval.

HTTP responses include a generated `X-Request-ID`. Access logs contain this ID,
method, status and duration. Application error stacks retain exception type and
code locations while excluding exception values, source text, bodies, paths,
headers and local variables. Use request IDs and operational references to
investigate failures without putting financial content in logs.

Set `SENTRY_DSN` to also send errors to Sentry or a compatible service. Reports
cover unhandled errors in web requests and management commands, and errors the
application logs, such as failed jobs or purges. They follow the same limits as
the logs: exception type, code locations, the URL pattern and the application's
own log message, without exception values, request data, users, local variables
or breadcrumbs. Library log messages keep only their template. Outgoing requests
and document processes get no tracing headers or variables. The `process` tag
is `web` or the management command, e.g. `run_jobs`. `SENTRY_ENVIRONMENT`
defaults to `DEPLOYMENT_ENV`. `SENTRY_RELEASE` names the deployed version and
defaults to `reimbursements@<version>` in [release images](releases.md).

The worker reclaims expired leases and runs cleanup each minute, including deletion
of expired Django sessions through the configured session backend. Active sessions
are preserved.
Reservations older than a job lease are reclaimed when their execution lock is free, including after
a restart clears tmpfs. Both supervisor and parser hold the lock, so a stale job
cannot cause cleanup to remove a live parser's workspace. An interrupted
validation keeps its admitted output reservation while awaiting another attempt.
Rendering can be
reclaimed; interrupted sends become unknown. It retries only known pre-acceptance
email failures and transient scanner outages, with bounded backoff.

Queue age measures waiting time since `run_after` for runnable/running jobs.
Scheduled backoffs do not fail readiness; a newly due retry gets a fresh waiting
interval. `claim_status` uses the same measure. Transient sandbox probe failures
are retried by the next readiness request; successful probes remain cached.

Schedule `reconcile_deliveries` every 15 minutes in the host's scheduler and
monitor its exit status. It rotates through bounded batches, including failed
provider lookups, and exits nonzero on provider failures; unmatched webhook events
also rotate, and the worker drops them after 30 days. `claim_status` streams all matches
and supports state filters.
Monitor queued job age, worker heartbeat, failed jobs,
`send_unknown`/paused/failed deliveries, scanner availability, free disk, and purge
failures. Use the independent monitoring channel, so a MailerSend outage cannot
suppress its own alert. `claim_status` emits redacted operational state for this.
Name the technical owner and Finance contact before launch.

Drafts expire after 24 hours. After recipient-server delivery, the PDF and local
email copies are deleted after seven days; all other content of the claim 90 days
after submission. Failed/ambiguous claims have a 90-day resolution target and
remain retained if unresolved; the admin area marks overdue claims and logs report
approaching ones. The owner must resolve them or record an approved extension.
Content purge deletes the claim record itself; no reference or status record remains.
Email provider and recipient copies follow their separately approved retention policies.

## Backup and restore

Back up PostgreSQL and private source/PDF files together, encrypted and off-host.
Do not back up only the database. Record the backup interval, expiry, key access,
recovery time target, and accepted loss window. The current single-host acceptance
path cannot promise survival of total host loss since the last backup; zero-loss
acceptance requires off-host file durability and matching database durability.

After restoring, leave the public web service stopped. Run overdue purges, apply
any separately recorded exceptional deletions, including admin deletions logged as
`claim_deleted`, and inspect interrupted deliveries
before restarting processing. Never automatically resend every restored job.
Test a restore using dummy data and verify database/file consistency, unknown-send
handling, and deletion. Keep exceptional deletion evidence outside the rollback
scope so an old backup cannot silently reactivate deleted financial data.
Run `python manage.py verify_storage` before restarting the restored application;
it checks recorded source/final PDF hashes, sizes and normalized-file presence
without printing participant content. `./scripts/capacity.sh 250` includes a
separate synthetic restore/deletion exercise; see `docs/production-readiness.md`
for its scope and the remaining staging and owner evidence.
