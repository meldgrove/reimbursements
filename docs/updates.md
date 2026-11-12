# Automatic updates

Each release publishes the production image `ghcr.io/meldgrove/reimbursements` under
its version, its series and `latest` (see [releases](releases.md)). `compose.yaml` runs
the tag named in `REIMBURSEMENTS_VERSION` and pulls it again on every deploy.

The `updater` service in `compose.yaml` installs new releases. Once an hour it asks the
registry whether that tag points to a new image. If so, it calls the hosting
platform's deploy link, and the platform pulls the image, runs the migrations, and
replaces web and worker. It is [Meldgrove Updater](https://github.com/meldgrove/updater),
the same for every Meldgrove app. Until `UPDATE_DEPLOY_HOOK_URL` is set, it does
nothing.

## Choose what to run

| `REIMBURSEMENTS_VERSION` | Runs | Updates automatically to |
| --- | --- | --- |
| `0.2` | the newest 0.2.x release | 0.2.x, never 0.3.0 |
| `latest` | the newest release | every release |
| `0.2.1` | exactly this release | nothing |

A series such as `0.2` or `1.2` only receives patch releases, which need no operator
action. A new minor version may need operator action, so `0.2` never moves to 0.3.0.
Moving to another series is a manual upgrade: read the release notes of every version
since the deployed one, then change `REIMBURSEMENTS_VERSION`.

With `latest`, every release installs within the hour, including one whose notes list
upgrade steps, before anyone has taken them. Watch the repository's releases on GitHub
(Watch > Custom > Releases) and take the steps right away. From 1.0.0 a major version
tag such as `1` exists too; it gets minor releases and carries the same risk.

## Switch it on

Set up [backups](#backups) first. Then, in Coolify:

1. Under Settings > Advanced, turn on API Access if it is off.
2. Under Keys & Tokens > API Tokens, create a token with only the `deploy` permission;
   clear `read`. Copy it at once; Coolify shows it only once.
3. Open the application's resource, select Webhooks, and copy Deploy Webhook. It looks
   like `https://coolify.example.invalid/api/v1/deploy?uuid=<resource>&force=false`.
4. In the resource's environment variables, set `UPDATE_DEPLOY_HOOK_URL` to the
   webhook and `UPDATE_DEPLOY_HOOK_TOKEN` to the token. Redeploy.

The `updater` container's log then says which tag it watches, and later each
deployment it starts or that the platform refused. Admin > General shows the running
version.

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

It pulls the tag and replaces only containers whose image changed, after the migration
job has finished. Watch the repository's releases on GitHub for releases outside the
series (Watch > Custom > Releases).

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
