# Automatic updates

Each release publishes the production image `ghcr.io/meldgrove/reimbursements` under
its version and under its series (see [releases](releases.md)). `compose.yaml` runs the
tag named in `REIMBURSEMENTS_VERSION` and pulls it again on every deploy. A redeploy
therefore installs the newest release of the series.

## Choose what to run

| `REIMBURSEMENTS_VERSION` | Runs | Updates automatically to |
| --- | --- | --- |
| `0.2` | the newest 0.2.x release | 0.2.x, never 0.3.0 |
| `1.2` (from 1.2.0) | the newest 1.2.x release | 1.2.x, never 1.3.0 |
| `0.2.1` | exactly this release | nothing |

A series only receives patch releases, which need no operator action. A new minor
version may need operator action, so `0.2` never moves to 0.3.0, and `1.2` never to
1.3.0. Moving to another series is a manual upgrade: read the release notes of every
version since the deployed one, then change `REIMBURSEMENTS_VERSION`.

Do not combine automatic updates with `latest` or, from 1.0.0, a major version tag
such as `1`. The worker still calls the deploy link only for patch releases, but the
redeploy pulls whatever the tag points to, including a minor release whose upgrade
steps nobody took.

## How the worker updates the app

Set `UPDATE_DEPLOY_HOOK_URL` to your hosting platform's deploy link: a URL that
redeploys the app when it receives a `POST` request. The worker then reads the
project's releases on GitHub once an hour:

- **A newer release in the series:** the worker calls the deploy link once, with
  `Authorization: Bearer <UPDATE_DEPLOY_HOOK_TOKEN>` when the token is set. The
  platform pulls the image, runs the migrations, and replaces web and worker.
- **A newer release outside the series:** nothing is installed. The admin area shows
  it, with a link to its release notes.
- **The deploy link fails:** the admin area shows the error, and the worker tries
  again an hour later.
- **The app still runs the old version an hour after the call:** the admin area says
  so, and the worker does not call the deploy link again for that release. Usually
  `REIMBURSEMENTS_VERSION` names an exact version instead of a series.

Template admins see these messages on every admin page. Admin > General shows the
running version and the last check. The worker needs to reach `api.github.com` and
the deploy link. GitHub sees the server's address and the app version, and nothing
else about the installation.

Updates need a release image: an app built from source reports no version and is
never updated.

## Switch it on

### Coolify

1. Under Settings > Advanced, turn on API Access if it is off.
2. Under Keys & Tokens > API Tokens, create a token with only the `deploy` permission;
   clear `read`. Copy it at once; Coolify shows it only once.
3. Open the application's resource, select Webhooks, and copy Deploy Webhook. It looks
   like `https://coolify.example.invalid/api/v1/deploy?uuid=<resource>&force=false`.
4. In the resource's environment variables, set `UPDATE_DEPLOY_HOOK_URL` to the
   webhook and `UPDATE_DEPLOY_HOOK_TOKEN` to the token. Redeploy.

Admin > General then says "Automatic updates are on", and shows the time of the last
check after the worker's first one.

### Other platforms

Any platform with a deploy link that redeploys on `POST` works. Set
`UPDATE_DEPLOY_HOOK_TOKEN` only when the platform expects a bearer token. The deploy
must pull the image again; `compose.yaml` asks Docker Compose to do that with
`pull_policy: always`. Use an `https://` link, since the token travels with every
call.

### Docker Compose without a platform

Without a deploy link, leave `UPDATE_DEPLOY_HOOK_URL` empty and run Docker Compose
every hour, for example with cron:

```cron
0 * * * * cd /srv/reimbursements && docker compose up --detach --quiet-pull
```

It pulls the series tag and replaces only containers whose image changed, after the
migration job has finished. The admin area does not show releases outside the series
in this setup. Watch the repository's releases on GitHub instead (Watch > Custom >
Releases).

## Backups

An automatic update runs without anyone present, so nobody takes a backup right
before it. Before switching updates on:

- Schedule encrypted, off-host backups of the database and the private files together,
  at least nightly, as [backup and restore](operations.md#backup-and-restore)
  describes. In Coolify, the PostgreSQL resource has scheduled backups; the
  `private_data` volume needs its own.
- Test a restore.

Releases can include migrations, so going back to an older release can need the
backup from before the update.

## Switch it off

Clear `UPDATE_DEPLOY_HOOK_URL` and redeploy, or set `REIMBURSEMENTS_VERSION` to an
exact version.
