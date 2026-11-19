# Deploy with Coolify

The app is made for a Linux server ([deployment](deployment.md)). It also runs on
Coolify, from `compose.coolify.yaml`: the web process, worker, scanner, migration job and
updater as one Docker Compose resource. Create it from this repository, choose the
branch `stable`, and set its Docker Compose location to `/compose.coolify.yaml`. Under
Advanced, set Auto deploy to "Manual deployments only", so that only the updater and
you deploy, not every change of `stable`.
`stable` is at the newest release; `main` has changes that are not released yet. The
file runs the published release image; `REIMBURSEMENTS_VERSION` names the release
series, such as `0.3`, or `preview` for unreleased changes (see
[automatic updates](#automatic-updates)). Run PostgreSQL as a separate resource on the
same private network. Route only the web service to a public HTTPS hostname. Keep all
persistent volumes across upgrades.

`compose.coolify.yaml` is `compose.yaml` without a host port, with every deploy pulling
the images again, and with the updater calling Coolify's deploy link. Coolify's proxy,
Traefik, receives each request in full before it passes it to `web`, through a label in
that file, as Caddy does on a server.

## Database and storage

Create a PostgreSQL database and enable the application's access to its private
network (Connect To Predefined Network). Set `DATABASE_URL` to the internal connection
URL. Keep database and private-file backups together; the PostgreSQL resource has
scheduled backups, the `private_data` volume needs its own. The application owns a
persistent `private_data` volume and a bounded 700 MB tmpfs workspace on web and
worker. The scanner has its own signature database volume.

## Settings

Create the Keycloak client and its groups as [admin sign-in](deployment.md#admin-sign-in)
describes. Copy `.env.production.example` into the environment editor (Developer view)
and replace all placeholder values as
[application settings](deployment.md#application-settings) describes, with these
differences:

- `DATABASE_URL` is the PostgreSQL resource's internal URL; leave out `COMPOSE_FILE`
  and `POSTGRES_PASSWORD`.
- `TRUSTED_PROXY_CIDRS` lists the actual network ranges of Coolify's proxy; never
  `0.0.0.0/0`.
- For automatic updates, add `UPDATE_DEPLOY_HOOK_URL` and `UPDATE_DEPLOY_HOOK_TOKEN`
  ([automatic updates](#automatic-updates)).

## First launch and upgrades

Deploy, then sign in at `/admin/` and continue as
[first launch](deployment.md#first-launch) describes, with the setup check run in the
web container. The migration job must complete before web and worker start. For
upgrades, stop old workers before migrations and preserve database, private files and
scanner volumes. Back up the database and private files together before a manual
upgrade; automatic updates rely on scheduled backups instead.

Before a manual upgrade, read the GitHub release notes of every version since the
deployed one; they list the upgrade steps a release needs. Take the steps, then change
`REIMBURSEMENTS_VERSION` in the resource's environment variables and redeploy. Coolify
reads `compose.coolify.yaml` from `stable`, which is at the newest release.

## Automatic updates

On Coolify, the image tag set in `REIMBURSEMENTS_VERSION` decides what installs, not
the channel under Admin > Updates:

| `REIMBURSEMENTS_VERSION` | Runs | Updates automatically to |
| --- | --- | --- |
| `0.3` | the newest 0.3.x release | every 0.3.x release, never 0.4.0 |
| `latest` | the newest release | every release |
| `preview` | the newest preview | every preview and release |
| `0.3.1` | exactly this release | nothing |

With `latest`, every release installs, including one whose notes list upgrade steps,
before anyone has taken them. For a release that needs upgrade steps, take the steps and
change the tag; the update button links to its release notes. Cooldown, window and the
update button work as on a server ([automatic updates](updates.md)). Set up backups
first.

1. Under Settings > Advanced, turn on API Access if it is off.
2. Under Keys & Tokens > API Tokens, create a token with only the `deploy` permission;
   clear `read`. Copy it at once; Coolify shows it only once.
3. Open the application's resource, select Webhooks, and copy Deploy Webhook. It looks
   like `https://coolify.example.invalid/api/v1/deploy?uuid=<resource>&force=false`.
4. In the resource's environment variables, set `UPDATE_DEPLOY_HOOK_URL` to the
   webhook and `UPDATE_DEPLOY_HOOK_TOKEN` to the token. Redeploy.

The updater calls the deploy link when the tag in `REIMBURSEMENTS_VERSION` points to a
new image. The `updater` container's log says which tag it watches, and later each
deployment it starts or that Coolify refused. To switch it off, clear
`UPDATE_DEPLOY_HOOK_URL` and redeploy; setting `REIMBURSEMENTS_VERSION` to an exact
version also stops updates once it is deployed.

## Moving an existing resource

Resources set up before `compose.coolify.yaml` existed read `/compose.yaml`. That file
is made for a server now: it has no deploy link, no Traefik buffering label, and does
not pull the images again, so automatic updates stop with it. Once the release that
brings `compose.coolify.yaml` is out (its release notes name this step):

1. Before that release, check that Auto deploy under Advanced is "Manual deployments
   only": otherwise the release redeploys the resource from `/compose.yaml` at once.
2. In the resource's configuration, set Docker Compose Location to
   `/compose.coolify.yaml` and save.
3. Keep the environment variables. Change `REIMBURSEMENTS_VERSION` when the release
   starts a new series.
4. Redeploy. The services and volumes keep their names, so the data stays.
