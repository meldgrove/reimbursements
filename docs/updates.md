# Automatic updates

Each release publishes the production image `ghcr.io/meldgrove/reimbursements` under
its version, its series and `latest` (see [releases](releases.md)); every change on
`main` whose checks pass is published as a preview under its version, such as
`0.3.2-preview.4`, and `preview`. `compose.yaml` runs the tag named in
`REIMBURSEMENTS_VERSION`. This page is about a Linux server
([deployment](deployment.md)); on Coolify, see
[its automatic updates](coolify.md#automatic-updates).

The `updater` service in `compose.yaml` checks for new versions once an hour and
installs them. It is [Meldgrove Updater](https://github.com/meldgrove/updater), the same
for every Meldgrove app. It installs nothing until it is [switched on](#switch-it-on),
but template admins see available updates in the app either way.

## Channels

- **Stable** (default): releases. A release of the deployed series installs
  automatically after the [cooldown](#when-a-release-installs). A release that needs
  upgrade steps starts the next series: the app shows it, but it never installs on its
  own.
- **Preview** (unstable): every change on `main` as soon as its checks pass, before it
  is released, and every release. Previews install at the next check, without
  cooldown. New features first, and now and then a new bug. Previews have no release
  notes; the app links to their changes on GitHub instead.

Switching from Preview to Stable installs nothing and never goes back to an older
version: the deployment keeps the preview until a release is newer, as a database
migrated by a newer version may not work with an older one.

Template admins choose the channel under Admin > Updates. A series such as `0.3`
receives every release that needs no operator action: fixes, features, and migrations
that run on their own. A release that operators must act on starts the next series, so
`0.3` never moves to 0.4.0. From 1.0.0 the series is the major version: `1` receives
every 1.x release, and 2.0.0 is the next release that needs action.

The server writes the exact version it installs into `REIMBURSEMENTS_VERSION` in `.env`,
such as `0.3.2` or `0.3.3-preview.1`.

## Update button

Template admins see an update icon in the admin header; form editors do not. It checks
for updates on click, shows an available update with its changes and when it installs,
installs it at once with **Install now**, shows the progress, and says why an
installation failed. Web and worker restart during an installation; the page reloads
when the new version runs, once the server reports every service healthy.
Without a result after 15 minutes, it asks to check the server and offers **Stop
waiting**. For a release that needs upgrade steps, it links to its release notes: take
the steps on the server first (`git pull` when the release changes `compose.yaml`),
then install it with **Install anyway…**.

Admin > Updates shows the installed version, the channel, when updates install
automatically and the last check. The button and Admin > Updates come from
`@meldgrove/ui`, the same in every Meldgrove app; the app serves their four routes under
`/admin/updates/`. Without a reachable updater, the icon is grey and Admin > Updates says
so. `UPDATER_URL` is where the app reaches the updater, `http://updater:8080` by
default. Under `compose.yaml` an empty value falls back to that default; empty hides
the icon only where the app reads its environment directly, as in the local setup.
The updater's port has no authentication: never publish it.

## When a release installs

A release installs three days after it came out, so that a faulty release can be
replaced before it reaches the deployment. `UPDATE_COOLDOWN` changes the time: `0`
installs at the next check, `7d` waits a week. Security fixes wait as well; install
them at once with the update button.

Web and worker stop while a version installs. `UPDATE_WINDOW`, such as `02:00-05:00`
in the time zone `TZ` (default UTC), keeps automatic installs out of working hours.

## Switch it on

Set up [backups](#backups) first. Then, on a server set up as
[deployment](deployment.md) describes, as root in `/srv/reimbursements`:

```sh
docker compose up -d --pull always
docker compose run --rm -T --pull always updater host-setup > updater-setup.sh
sh updater-setup.sh
```

The first command starts the image the tag points to now, which the updater takes as
installed. The second writes the setup script from the updater's image; read it before
you run it. The script installs a systemd unit that waits for the updater's request,
then writes the version into `.env`, pulls the image and runs
`docker compose up --wait`: it replaces only containers whose image changed, after the
migration job has finished. When the new version does not become healthy, it restores
`.env` and starts the version before, and the update button says why.
`journalctl -u meldgrove-updater-reimbursements.service` shows each installation. The
server installs images, not files: a release that changes `compose.yaml` needs a
`git pull`.

A server set up with updater 0.1, by a release before the update button, keeps
updating along its tag. To get the update button and the new host setup, as root in
`/srv/reimbursements`: run `git pull`, set `REIMBURSEMENTS_VERSION` in `.env` to the
release that brings the update button or a newer one, then

```sh
docker compose up -d --pull always
docker compose run --rm -T --pull always updater host-setup > updater-setup.sh
sh updater-setup.sh
```

The first command installs that release of the app, not only the new updater; the
others replace the host setup, as above.

## Backups

An automatic update runs without anyone present, so nobody takes a backup right
before it. Before switching updates on:

- Schedule encrypted, off-host backups of the database and the private files together,
  at least nightly, as [backup and restore](operations.md#backup-and-restore)
  describes.
- Test a restore.

Releases can include migrations, so going back to an older release can need the
backup from before the update.

## Switch it off

Run `sh updater-setup.sh remove` as root in `/srv/reimbursements`. The update button
then still shows new versions, but says that automatic updates are off on this server
and installs nothing.
