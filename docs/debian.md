# Deploy on Debian

Use `compose.yaml` for the web process, worker, scanner and migration job on a server
with Debian 13 or later, or a similar system with systemd and apt such as Ubuntu 24.04.
The document sandbox needs Linux 6.2 or later (Landlock ABI 3); Debian 12 runs Linux
6.1. The file runs the published release image; `REIMBURSEMENTS_VERSION` names the
release series, such as `0.3`, and automatic updates set it to the exact version they
install (see [automatic updates](updates.md)). The branch `stable`
is at the newest release; `main` has changes that are not released yet. Caddy on the
same server terminates HTTPS and routes the public hostname to the web service only.
Keep all persistent volumes across upgrades. To run it on Coolify instead, see
[Deploy with Coolify](coolify.md).

## Database and storage

`compose.yaml` contains no database. Use a PostgreSQL of your own that the containers
reach over the network, and set `DATABASE_URL` to its URL; `localhost` in it would be
the container itself. Keep database and private-file backups together. Docker Compose
names the volumes after the folder: `reimbursements_private_data` holds the private
files, `reimbursements_scanner_data` the scanner's signature database. Web and worker
also get a bounded 700 MB tmpfs workspace.

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
   [admin sign-in](coolify.md#admin-sign-in) describes.
4. **Create `.env`** from `.env.coolify.example` (`cp .env.coolify.example .env`,
   `chmod 600 .env`; not `.env.example`, which selects the local setup) and replace
   all placeholder values as [application settings](coolify.md#application-settings)
   describes. `DATABASE_URL` is the URL of your PostgreSQL. Set `TRUSTED_PROXY_CIDRS`
   to `127.0.0.1/32` until step 7. Leave `UPDATE_DEPLOY_HOOK_URL` and
   `UPDATE_DEPLOY_HOOK_TOKEN` empty.
5. **Port for Caddy:** `compose.yaml` publishes no host port, because Coolify routes to
   the web container directly. Publish port 8000 of `web` on `127.0.0.1` in a file
   `compose.override.yaml` next to `compose.yaml`, which Docker Compose reads with it:

   ```yaml
   services:
     web:
       ports:
         - "127.0.0.1:8000:8000"
   ```

6. **Start:** `docker compose up -d --pull always`. The scanner's first start can take
   several minutes.
7. **Trusted proxy:** Caddy's requests reach `web` from the gateway of the app's Docker
   network. Show it with:

   ```sh
   docker network inspect reimbursements_default --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
   ```

   Set `TRUSTED_PROXY_CIDRS` in `.env` to it with `/32`, such as `172.18.0.1/32`, and
   run `docker compose up -d` again.
8. **HTTPS:** point the domain's DNS at the server, install Caddy (`apt install caddy`),
   and replace `/etc/caddy/Caddyfile` with:

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

   Then `systemctl reload caddy`. Caddy gets the certificate itself. As Traefik does on
   Coolify, it refuses a request larger than 10 MiB and receives a smaller one in full
   before it passes it on, so a slowly sent upload does not hold one of the web
   process's workers. Debian 13's package is Caddy 2.6; Caddy 2.8 and later take
   `request_buffers 10MiB` instead of the two lines under `reverse_proxy`.
9. **First launch:** sign in at `/admin/` and continue as
   [first launch](coolify.md#first-launch-and-upgrades) describes. Run the setup check
   in the web container with:

   ```sh
   docker compose exec web python manage.py verify_setup --to <an approved Finance inbox>
   ```

10. **Automatic updates:** set them up [on Debian](updates.md#on-debian).

## Upgrades

Before a manual upgrade, read the GitHub release notes of every version since the
deployed one; they list the upgrade steps a release needs. Back up the database and
private files together. Then, in `/srv/reimbursements`:

1. Run `git pull` for the newest release's `compose.yaml`.
2. Take the upgrade steps and change `REIMBURSEMENTS_VERSION` in `.env`.
3. Stop the old web and worker before the migrations: `docker compose stop web worker`.
4. Run `docker compose up -d --pull always`. The migration job completes before web and
   worker start.

Then run the [setup check](operations.md#setup-check) again. Automatic updates install
the releases of the series without these steps and rely on scheduled backups instead;
see [automatic updates](updates.md). With them, take steps 1 and 2 without changing
`REIMBURSEMENTS_VERSION`, then install the release with **Install anyway…** in the
update button in the admin header.
