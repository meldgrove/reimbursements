# Deployment

Use `compose.yaml` for the web process, worker, scanner, migration job and updater on a
Linux server with Debian 13 or later, or a similar system with systemd and apt such as
Ubuntu 24.04. The document sandbox needs Linux 6.2 or later (Landlock ABI 3); Debian 12
runs Linux 6.1. The file runs the published release image; `REIMBURSEMENTS_VERSION`
names the release series, such as `0.5`, and automatic updates set it to the exact
version they install (see [automatic updates](updates.md)). The branch `stable` is at
the newest release; `main` has changes that are not released yet. Caddy on the same
server terminates HTTPS and routes the public hostname to the web service only. Keep
all persistent volumes across upgrades. To run it on Coolify instead, see
[Coolify](coolify.md).

## Database and storage

Use a PostgreSQL of your own that the containers reach over the network, and set
`DATABASE_URL` to its URL; `localhost` in it would be the container itself. Or run one
next to the app with `compose.postgres.yaml`: add to `.env`, with the same
`openssl rand -hex 32` value in both places,

```sh
COMPOSE_FILE=compose.yaml:compose.postgres.yaml
POSTGRES_PASSWORD=REPLACE_WITH_RANDOM_HEX_PASSWORD
DATABASE_URL=postgresql://reimbursements:REPLACE_WITH_RANDOM_HEX_PASSWORD@postgres:5432/reimbursements
```

With `COMPOSE_FILE` in `.env`, every `docker compose` command in `/srv/reimbursements`
uses both files. Keep database and private-file backups together. Docker Compose names
the volumes after the folder: `reimbursements_private_data` holds the private files,
`reimbursements_scanner_data` the scanner's signature database, and
`reimbursements_postgres` the database of `compose.postgres.yaml`. Web and worker also
get a bounded 700 MB tmpfs workspace.

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
Another OpenID Connect provider works too: set `OIDC_ISSUER` to its issuer URL instead
of the two Keycloak settings, and `OIDC_GROUPS_CLAIM` if its groups are not in the
`groups` claim. Membership is refreshed at every sign-in. Admin sessions expire after
eight hours.

## Application settings

Create `.env` from `.env.production.example` and replace all placeholder values
([set up](#set-up), step 4). Set the public HTTPS origin in `CSRF_TRUSTED_ORIGINS`
(or in `APP_URL`), such as `https://reimbursements.example.invalid`, and the
address Caddy's requests come from in `TRUSTED_PROXY_CIDRS` ([set up](#set-up),
step 6). Sign-in sends the provider back to the app's address: `APP_URL` when it is
set (exactly one address), else the first `https` origin of `CSRF_TRUSTED_ORIGINS`
without a wildcard. Every origin `CSRF_TRUSTED_ORIGINS` lists, wildcards included,
may send changes, as in 0.4. With several addresses, set `APP_URL` to the one
registered as the redirect URI. `DJANGO_SECRET_KEY` (or `AUTH_SECRET`, which wins when
both are set) signs the sessions and seals the secrets entered under Admin > Email: a
random secret of at least 50 characters.

After the first sign-in, set the operator's name and legal page (the footer of public
pages), the app language, timezone and date format under Admin > General, and the accent
color and favicon under Admin > Appearance. `APPROVED_DELIVERY_RECIPIENTS` lists every inbox a
form may send to. For staging, also set a nonempty `TEST_RECIPIENT_ALLOWLIST`; it
restricts accounting and participant messages. Do not make production receipts
available to staging.

Set up email after the first sign-in under Admin > Email, and send a test email from
there. Forms take no claims until it is set up. Choose one provider:

- **MailerSend**: enter an API token, and a sender address on a verified MailerSend
  domain. Create a version 2 webhook at
  `https://reimbursements.example.invalid/webhooks/mailersend/`, using your actual
  hostname, subscribe it to the supported sent, delivered, deferred, bounced and
  suppressed events, and enter its signing secret. Disable provider tracking. The
  page shows when the last signed event arrived.
- **SMTP server**: enter the server, port, encryption (STARTTLS, TLS, or none for a
  relay in a trusted network) and, if it needs a login, username and password. SMTP
  reports no deliveries or bounces back: an email counts as delivered once the server
  accepts it, and bounces go to the sender address.

Also enter the reply address for Finance emails, a monitored inbox. Tokens, signing
secrets and passwords entered there are stored encrypted with a key derived from
`AUTH_SECRET` (or `DJANGO_SECRET_KEY`); after changing that secret, enter them again.
`cli settings` sets the same settings without a browser
([operator commands](#operator-commands)). See [operations](operations.md) for
ambiguous delivery outcomes and retry controls.

Optionally set `SENTRY_DSN` for error reports from web, worker, migrations and `cli`
commands. See
[operations](operations.md#monitoring-and-maintenance) for what a report contains.

The `updater` service installs new versions once the server's host setup runs, and
template admins can install them from the update button in the admin header.
[Automatic updates](updates.md#switch-it-on) explains the setup and the backups to set
up first. Set `UPDATER_TOKEN` to a random value (`openssl rand -hex 32`): the app sends
it, and the updater then takes requests only with it. It is recommended, not required.
A server set up before the token existed can add it later, as
[protect the update service](updates.md#protect-the-update-service) describes.

## Set up

Run the commands as root (`sudo -i`).

1. **Docker:** install Docker Engine and the Compose plugin from Docker's apt
   repository ([Debian](https://docs.docker.com/engine/install/debian/),
   [Ubuntu](https://docs.docker.com/engine/install/ubuntu/)), and Git:
   `apt install git`.
2. **Get the files** at the newest release:

   ```sh
   git clone --branch stable https://github.com/meldgrove/reimbursements.git /srv/reimbursements
   cd /srv/reimbursements
   ```

3. **Admin sign-in:** create the Keycloak client and its groups as
   [admin sign-in](#admin-sign-in) describes.
4. **Create `.env`** from `.env.production.example`
   (`cp .env.production.example .env`, `chmod 600 .env`; not `.env.example`, which
   selects the local setup) and replace all placeholder values as
   [application settings](#application-settings) describes. Set `DATABASE_URL` as
   [database and storage](#database-and-storage) describes, and `TRUSTED_PROXY_CIDRS`
   to `127.0.0.1/32` until step 6.
5. **Start:** `docker compose up -d --pull always`. The scanner's first start can take
   several minutes.
6. **Trusted proxy:** Caddy's requests reach `web` from the gateway of the app's Docker
   network. Show it with:

   ```sh
   docker network inspect reimbursements_default --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
   ```

   Set `TRUSTED_PROXY_CIDRS` in `.env` to it with `/32`, such as `172.18.0.1/32`, and
   run `docker compose up -d` again.
7. **HTTPS:** point the domain's DNS at the server, install Caddy (`apt install caddy`),
   and put this site into `/etc/caddy/Caddyfile`, in place of the package's example site
   `:80` and next to the sites of other apps:

   ```text
   reimbursements.example.invalid {
   	request_body {
   		max_size 10MiB
   	}
   	reverse_proxy 127.0.0.1:8000 {
   		buffer_requests
   		max_buffer_size 10MiB
   	}
   }
   ```

   Then `systemctl reload caddy`. Caddy gets the certificate itself. It refuses a
   request larger than 10 MiB and receives a smaller one in full before it passes it
   on, so a slowly sent upload does not keep an upload open in the app. Debian
   13's package is Caddy 2.6; Caddy 2.8 and later take `request_buffers 10MiB` instead
   of the two lines under `reverse_proxy`.

   `compose.yaml` publishes `web` on `127.0.0.1:8000` only; `REIMBURSEMENTS_PORT`
   changes the host port. With several apps on one server, give each its own port
   and its own site in the Caddyfile.
8. **First launch:** sign in at `/admin/` and continue as
   [first launch](#first-launch) describes. Run the setup check
   in the web container, with one of your approved inboxes in place of the example:

   ```sh
   docker compose run --rm -T migrate cli verify-setup --to finance@your-org.example.invalid
   ```

9. **Automatic updates:** [switch them on](updates.md#switch-it-on).

## First launch

Deploy, then sign in at `/admin/`. Replace the initial privacy setup text with your
operator's notice, review the template declaration, and create a form with an
approved recipient, support address and required internal values. Set up email under
Admin > Email ([above](#application-settings)) or with
[`cli settings`](#operator-commands). Then run
`docker compose run --rm -T migrate cli verify-setup --to <an approved inbox>`.
It sends a synthetic claim through the scanner, document sandbox, the email provider
and, with MailerSend, the signed delivery webhook, and deletes it again; see
[setup check](operations.md#setup-check). Publish your form and send a synthetic claim
through it before accepting participant data, and verify its PDF.

Run the [release checks](production-readiness.md). The migration job must complete
before web and worker start.
Before a manual upgrade, read the GitHub release notes of every version since the
deployed one; they list the upgrade steps a release needs. See
[releases](releases.md) and [automatic updates](updates.md).

## Backups

### With Meldgrove Backups

The `backup-agent` service in `compose.yaml` sends the database and the
`private_data` volume to
[Meldgrove Backups](https://github.com/meldgrove/backups) when Backups asks.
While `BACKUP_URL` is empty, it idles.

1. In Backups, add a source of the kind **Meldgrove app**, and put the two
   lines it shows (`BACKUP_URL`, `BACKUP_TOKEN`) into `.env`.
2. Run `docker compose up -d`, then check the agent:
   `docker compose exec backup-agent backup-agent check`.
3. Let the backup end before the update window (`UPDATE_WINDOW`): automatic
   updates run migrations without anyone present.

Keep the session secret apart from the backups: `AUTH_SECRET` if `.env` sets it, else
`DJANGO_SECRET_KEY` (sessions, the open drafts of participants and the upload budgets
of client networks are tied to it). A restore needs it, the backups do not hold it,
and Backups shows both names on the source page.

With [automatic updates](updates.md), run the updater's host setup again once
the app's folder has updater 0.2.2 or later (`git pull`): its deploy script
then pulls the agent's image with each update. Without it:
`docker compose pull backup-agent && docker compose up -d`.

To restore, take the database and the private files back as the
[agent's guide](https://github.com/meldgrove/backup-agent#restore) shows (its
steps 1 to 3), but do not start the app yet. First take the steps in
[Operations](operations.md#backup-and-restore): keep the public web service
stopped, run overdue purges, apply recorded deletions, and run
`cli verify-storage`. Then start web and worker.

### By hand

Back up PostgreSQL and the private files together, encrypted and off-host:
[Operations](operations.md#backup-and-restore) has the rules.

## Upgrade from 0.4

Release 0.5 is the same app rebuilt in TypeScript, on the stack of the other Meldgrove
apps. It takes over the database of 0.3 or 0.4 in place: the tables keep their names,
and 0.4 runs on the database again if you go back. The private files stay where they
are. An older installation (0.1, 0.2) installs 0.4 first; 0.5's migration job refuses
its database and changes nothing.

1. Back up the database and the private files together. Keep a copy of `.env` and of
   the folder's `compose*.yaml` files as they are: going back to 0.4 needs them.
2. In `/srv/reimbursements`, run `git fetch --tags` and `git checkout v0.5.1` for
   0.5.1's `compose.yaml`.
3. Keep `.env`: `DJANGO_SECRET_KEY` and `CSRF_TRUSTED_ORIGINS` still work, next to their
   new names `AUTH_SECRET` and `APP_URL`. The first `https` origin of
   `CSRF_TRUSTED_ORIGINS` without a wildcard becomes the app's address, which sign-in
   sends the provider back to; when it lists several, set `APP_URL` to the one
   registered as the redirect URI. `ALLOWED_HOSTS` is no longer read; keep it while you
   may go back, since 0.4's `compose.yaml` requires it.
4. Scheduled or scripted operator commands become `cli` commands of the same name:
   `python manage.py reconcile_deliveries` becomes `cli reconcile-deliveries`, with the
   same options ([operations](operations.md#recovery-commands)). The old form keeps
   working through the `python` stand-in described below, so switch when convenient.
5. Set `REIMBURSEMENTS_VERSION=0.5.1`, stop web and worker
   (`docker compose stop web worker`), and run `docker compose up -d --pull always`.
6. Sign in at `/admin/` and run the [setup check](operations.md#setup-check).
7. Run `git checkout stable` and go on to the newest release ([upgrades](#upgrades)).

What changes:

- Forms that participants are filling in at the moment of the switch are lost: their
  drafts were tied to the sessions of 0.4, which end. Participants open the form again
  and start over. Submitted claims are kept, and their queued processing and sending
  continue in the new worker.
- Participants who submitted a claim before the switch can no longer open its
  confirmation page (`/received/<id>/`): it belonged to their 0.4 session. The claim is
  processed and sent as usual, and their confirmation email still arrives. Tell
  support to answer such questions from the admin area, so that nobody submits again.
- Everyone in the admin area signs in once more.
- Email keeps working as it did: at its first start, 0.5.1 copies the MailerSend
  variables and the addresses from `.env` into Admin > Email, which 0.5 adds
  (MailerSend or an SMTP server, and the participant confirmation's text), and the
  operator and the legal page into Admin > General. Later versions do not. A server that
  ran a 0.4 preview with Admin > Email keeps its settings there; keep `DJANGO_SECRET_KEY`
  in `.env`, so the secrets entered there still open when `AUTH_SECRET` differs. 0.4
  ignores the page's table if you go back.
- The admin area is the app frame of the other Meldgrove apps. Its pages have new
  addresses (`/admin/claims`, `/admin/forms`, ...); links to the pages of 0.4 lead to
  the new ones. Participant links (`/f/<form>/`, `/received/<id>/`) stay.
- The claim PDF's summary page is drawn directly instead of rendered from an HTML page
  (WeasyPrint): the same content and layout, not the same bytes.
- Operator commands run as `docker compose run --rm -T migrate cli <command>`, such as
  `cli verify-setup` instead of `python manage.py verify_setup`
  ([operator commands](#operator-commands)).

The image also starts with the `compose.yaml` of 0.4, whose commands and health checks
call `python`: a stand-in named `python` runs them, and the operator commands of 0.4
(`claim_status`, `purge_expired`, `reconcile_deliveries`, `retry_claim`,
`verify_setup`, `verify_storage`) as their `cli` commands. A server on the Preview
channel therefore installs the newest version by itself, past 0.5.1: choose Stable under
Admin > Updates before.

To go back to 0.4:

1. Stop automatic installs, or the updater installs 0.5 again: `docker compose stop
   updater`. Then stop web and worker: `docker compose stop web worker`.
2. Put back the `.env` and `compose*.yaml` files kept before the upgrade (or
   `git checkout v0.4.0 -- compose.yaml compose.coolify.yaml compose.postgres.yaml`
   and the 0.4 settings: `DJANGO_SECRET_KEY`, `ALLOWED_HOSTS`, `CSRF_TRUSTED_ORIGINS`,
   the Keycloak settings under their old names, and the email, operator and legal page
   variables of 0.4's `.env.production.example`), with `REIMBURSEMENTS_VERSION=0.4.0`.
3. Run `docker compose up -d web worker` (their database, scanner and migration job
   start with them; the updater stays stopped). 0.4 runs on the database again;
   everyone signs in again, and open drafts are lost again. Change scheduled `cli`
   commands back to `python manage.py`.
4. Start the updater again (`docker compose up -d updater`) only once you want
   updates again. On the Preview channel, choose Stable under Admin > Updates right
   after: Preview installs 0.5 again within the hour, while Stable never installs a
   new series by itself.

## Operator commands

The image has a `cli` command for operators. On a server, run it in a one-off container
of the migration job, in `/srv/reimbursements`:

```sh
docker compose run --rm -T migrate cli help
```

In a running container, `cli` is on the `PATH`: `docker compose exec web cli help`, or
`cli help` in Coolify's terminal of the web container. [Operations](operations.md#recovery-commands)
describes the commands for claims and storage.

### Settings

`cli settings` sets what Admin > Email, Admin > General and Admin > Appearance set,
without a browser. It runs the same code as the pages: the same checks, the same
encryption, and an entry in the audit log (`portal_operation`) with the actor
`operator` and the command.

| Command | What it does |
| --- | --- |
| `cli settings list [--json]` | Each setting: set, not set or incomplete, with hints; never a secret |
| `cli settings show <name>` | What the page shows, as JSON |
| `cli settings apply <name>` | Saves the JSON body on stdin that the page sends; then prints what `show` prints |
| `cli settings test email --to <address>` | Sends the test email of Admin > Email |

The names are `email`, `general` and `appearance`. None of them is a list, so there is
no `--id` and no `cli settings remove`. The app issues no tokens to other apps, so there
is no `cli tokens`. Exit codes: 0 done; 1 refused, with the page's message on stderr; 2
a wrong command or a body that is not JSON.

The body of `apply` is the whole form, as the page sends it. Start from the `settings`
of `cli settings show <name>` and change what you need. Secrets go only into the body,
never into arguments. An empty secret field keeps the saved secret; `true` in
`deleteMailersendToken`, `deleteWebhookSecret` or `deleteSmtpPassword` deletes it.
Nothing prints a saved secret, the pages do not either.

`email` with MailerSend (`"confirmation": {}` uses the standard texts; to keep your own,
copy them from `show`):

```json
{
  "provider": "mailersend",
  "fromAddress": "no-reply@your-org.example.invalid",
  "replyToAddress": "finance@your-org.example.invalid",
  "mailersendToken": "REPLACE_WITH_THE_API_TOKEN",
  "webhookSecret": "REPLACE_WITH_THE_SIGNING_SECRET",
  "smtpHost": "",
  "smtpPort": 587,
  "smtpSecurity": "starttls",
  "smtpUsername": "",
  "confirmationEnabled": true,
  "confirmation": {}
}
```

With an SMTP server, set `"provider": "smtp"`, `smtpHost`, `smtpPort`, `smtpSecurity`
(`starttls`, `tls` or `none`), and `smtpUsername` and `smtpPassword` if it needs a login.

`general`; `operator` and `legalUrl` left out keep their saved values:

```json
{
  "language": "de",
  "timezone": "Europe/Berlin",
  "dateFormat": "d.m.Y",
  "numberFormat": "european",
  "operator": "Your organization",
  "legalUrl": "https://your-org.example.invalid/imprint"
}
```

`appearance`; `"removeFavicon": true` restores the standard favicon. A favicon is
uploaded on the page only:

```json
{ "accentColor": "#0f766e" }
```

For example, with the body in `email.json`:

```sh
docker compose run --rm -T migrate cli settings apply email < email.json
docker compose run --rm -T migrate cli settings test email --to finance@your-org.example.invalid
rm email.json
```

AI with access to the server sets a key the same way: the key arrives as a file, AI
writes the body with it, pipes the body into `cli settings apply`, runs
`cli settings test` and deletes both files.

## Upgrades

Before a manual upgrade, read the GitHub release notes of every version since the
deployed one; they list the upgrade steps a release needs. Back up the database and
private files together. Then, in `/srv/reimbursements`:

1. Run `git pull` for the newest release's `compose.yaml`.
2. Take the upgrade steps and change `REIMBURSEMENTS_VERSION` in `.env`.
3. Stop the old web and worker before the migrations: `docker compose stop web worker`.
4. Run `docker compose up -d --pull always`. The migration job completes before web and
   worker start. Keep the database, private files and scanner volumes.

Then run the [setup check](operations.md#setup-check) again. Automatic updates install
the releases of the series without these steps and rely on scheduled backups instead;
see [automatic updates](updates.md). With them, take steps 1 and 2 without changing
`REIMBURSEMENTS_VERSION`, then install the release with **Install anyway…** in the
update button in the admin header.

A server that still has its email settings, operator or legal page only in `.env` (0.5.0
or older) first runs 0.5.1 once with 0.5.1's Compose file (`git fetch --tags` and
`git checkout v0.5.1`, afterwards `git checkout stable`). It copies them into the
database, and Admin > Email and Admin > General then name the lines that can go from
`.env`. Later versions do not read them.

Servers set up before `compose.yaml` published the port have a `compose.override.yaml`
that publishes `127.0.0.1:8000:8000`. It does no harm: Docker Compose merges the
identical entry. To remove it after the `git pull` that brings the new `compose.yaml`,
delete it if it holds nothing else, and run
`docker compose up -d --force-recreate updater`: the host setup runs Docker Compose with
the files that started the updater, so it fails while those name a deleted file.
