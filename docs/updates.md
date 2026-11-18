# Automatic updates

Each release publishes the production image `ghcr.io/meldgrove/reimbursements` under
its version, its series and `latest` (see [releases](releases.md)). `compose.yaml` runs
the tag named in `REIMBURSEMENTS_VERSION` and pulls it again on every deploy.

The `updater` service in `compose.yaml` installs new releases. Once an hour it asks the
registry whether that tag points to a new image. If so, it waits for the
[cooldown](#when-a-release-installs) and then calls Coolify's deploy link, or on Debian
leaves a request for the server, and Coolify or the server pulls the image, runs the
migrations, and replaces web and worker. It is
[Meldgrove Updater](https://github.com/meldgrove/updater), the same for every Meldgrove
app. Until it is [switched on](#switch-it-on), it does nothing.

## Choose what to run

| `REIMBURSEMENTS_VERSION` | Runs | Updates automatically to |
| --- | --- | --- |
| `0.3` | the newest 0.3.x release | every 0.3.x release, never 0.4.0 |
| `latest` | the newest release | every release |
| `0.3.1` | exactly this release | nothing |

A series such as `0.3` receives every release that needs no operator action: fixes,
features, and migrations that run on their own. A release that operators must act on
starts the next series, so `0.3` never moves to 0.4.0, and a deployment on a series
stays current until then. From 1.0.0 the series is the major version: `1` receives
every 1.x release, and 2.0.0 is the next release that needs action.

When a release is out that the tag does not reach, the `updater` log names it. Moving
to another series is a manual upgrade: read the release notes of every version since
the deployed one, take their upgrade steps, then change `REIMBURSEMENTS_VERSION`. Do
it soon: an earlier series gets no more fixes, and `stable` already holds the
`compose.yaml` of the new one.

With `latest`, every release installs, including one whose notes list upgrade steps,
before anyone has taken them. Watch the repository's releases on GitHub (Watch >
Custom > Releases) and take the steps right away.

## When a release installs

A release installs three days after it came out, so that a faulty release can be
replaced before it reaches the deployment. `UPDATE_COOLDOWN` changes the time: `0`
installs within the hour, `7d` waits a week. Security fixes wait as well; redeploy by
hand to install a release at once.

Web and worker stop while a release installs. `UPDATE_WINDOW`, such as `02:00-05:00`
in the time zone `TZ` (default UTC), keeps installs out of working hours.

## Switch it on

Set up [backups](#backups) first.

### On Coolify

1. Under Settings > Advanced, turn on API Access if it is off.
2. Under Keys & Tokens > API Tokens, create a token with only the `deploy` permission;
   clear `read`. Copy it at once; Coolify shows it only once.
3. Open the application's resource, select Webhooks, and copy Deploy Webhook. It looks
   like `https://coolify.example.invalid/api/v1/deploy?uuid=<resource>&force=false`.
4. In the resource's environment variables, set `UPDATE_DEPLOY_HOOK_URL` to the
   webhook and `UPDATE_DEPLOY_HOOK_TOKEN` to the token. Redeploy.

The `updater` container's log then says which tag it watches, and later each
deployment it starts or that Coolify refused. Admin > General shows the running
version.

### On Debian

On a server set up as [Deploy on Debian](debian.md) describes, as root in
`/srv/reimbursements`, with `UPDATE_DEPLOY_HOOK_URL` empty:

```sh
docker compose up -d --pull always
docker compose run --rm -T --pull always updater host-setup > updater-setup.sh
sh updater-setup.sh
```

The first command starts the image the tag points to now, which the updater takes as
installed. The second writes the setup script from the updater's image; read it before
you run it. The script installs a systemd unit that waits for the updater's request,
then pulls the new image and runs `docker compose up -d`: it replaces only containers
whose image changed, after the migration job has finished. Admin > General shows the
running version, `docker compose logs updater` the tag the updater watches, and
`journalctl -u meldgrove-updater-reimbursements.service` each installation.

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

On Coolify, clear `UPDATE_DEPLOY_HOOK_URL` and redeploy. On Debian, run
`sh updater-setup.sh remove` as root in `/srv/reimbursements`. On both, setting
`REIMBURSEMENTS_VERSION` to an exact version also stops updates once it is deployed (on
Debian with `docker compose up -d`).
