# Releases

A release bundles everything merged to `main` since the previous one. Maintainers
start it by hand; nothing is released on merge. A release is a `vX.Y.Z` tag on a
`main` commit that passed CI. No file holds the version (`pyproject.toml` stays at
`0.0.0`), and releasing pushes nothing to `main`. Every Meldgrove project releases
the same way.

## Version numbers

Versions follow Semantic Versioning. Choose the smallest part that fits the largest
change:

- **Patch** (the default): fixes, dependency and base image updates, security fixes,
  and small changes to the interface or texts.
- **Minor:** anything new for users or operators (features, settings, integrations),
  database migrations, and changes operators must act on. For example a new or
  renamed required variable in `compose.yaml`, changed Keycloak, MailerSend or
  PostgreSQL requirements, a migration with manual steps, or a changed public URL.
  The release notes say what to do.
- **Major:** rare, only for a really big update: a rewrite, a new architecture or
  deployment model, or the removal of a major feature. 1.0.0 is the maintainers'
  deliberate decision.

A series tag such as `0.2` or `1.2` therefore only receives patch releases, which
never need operator action.

## Release notes

Notes come from the titles of the merged pull requests, so write titles as
release-note lines. Label a pull request `breaking` when operators must act on
upgrade, and describe the steps in it: the notes list it first, under "Upgrade
steps needed". Dependabot's pull requests (`dependencies`) come last
(`.github/release.yml`).

## Cut a release

1. Wait for CI to pass on the latest `main` commit.
2. In GitHub, open Actions > Release > Run workflow. Choose patch, minor or major
   and tick "Dry run". It builds and starts the image on amd64 and arm64 and
   shows the version, image tags and notes, without publishing anything.
3. Run it again without "Dry run". When the release needs operator action, untick
   "Deploy" and deploy by hand after taking the steps.
4. When the release needs operator action, edit its notes on GitHub and add the
   upgrade steps at the top.

The workflow stops without changes when it is not started from `main`, when CI
has not passed for that commit, or when nothing changed since the last release.
Otherwise it:

- raises the latest `vX.Y.Z` tag by the chosen part, tags the commit, and pushes
  only the tag;
- builds the production image with the version for amd64 and arm64 and publishes
  it as `ghcr.io/meldgrove/reimbursements:X.Y.Z`, `:X.Y`, from 1.0.0 also `:X`,
  and `:latest`. Deployments that run a series tag install the release
  automatically when [automatic updates](updates.md) are on;
- attests the image's build provenance and creates the GitHub Release;
- deploys the release to the maintainers' server, if the repository has a deploy
  link (below).

If a job fails after the tag was pushed, fix the cause and use "Re-run failed
jobs". It publishes from the tag. Do not start a new release for the same
changes.

**Release candidates:** tick "Release candidate" to publish `X.Y.Z-rc.N` for
testing on a staging server. It publishes only that image tag (never `latest`),
marks the GitHub Release as a prerelease, and deploys nothing. Release with the
same choice of patch, minor or major afterwards.

Pull requests that change the `Dockerfile`, `.dockerignore`,
`scripts/start-web.sh` or the workflow build and start both images without
publishing.

## Deploy after a release

The maintainers' server installs every release as soon as it is out, instead of
waiting for the hourly check of [automatic updates](updates.md). It runs the image
tag `latest` (`REIMBURSEMENTS_VERSION=latest`) and leaves `UPDATE_DEPLOY_HOOK_URL`
empty, so a release deploys once. The repository has two Actions secrets:

- `DEPLOY_HOOK_URL`: a link that redeploys the app on `POST`. In Coolify, the
  resource's Webhooks > Deploy Webhook.
- `DEPLOY_HOOK_TOKEN`: its bearer token. In Coolify, an API token with only the
  `deploy` permission.

The Deploy job calls the link once the release is published; without
`DEPLOY_HOOK_URL` it does nothing. GitHub's runners must reach the link over the
internet. If the call fails, the release is still out: fix the cause and use
"Re-run failed jobs", or deploy by hand.

Other operators' servers are out of the workflow's reach. They use
[automatic updates](updates.md) instead.

## Release images

Release images set `APP_VERSION`. `/-/healthz` reports it, and error reports name
the release `reimbursements@X.Y.Z` unless `SENTRY_RELEASE` is set. Images built
from source report no version unless built with `--build-arg APP_VERSION=X.Y.Z`;
Coolify passes its environment variables as build arguments.

Verify an image's origin with:

```bash
gh attestation verify oci://ghcr.io/meldgrove/reimbursements:X.Y.Z --owner meldgrove
```

## Repository settings

- **Package visibility:** after the first release, make the `reimbursements`
  package public in the organisation's package settings if it is not already, so
  operators can pull it without signing in.
- **Immutable releases** are on: a published release's tag can never move or be
  deleted, while its notes stay editable. Fix a bad release with a new patch
  release.
- **Protected `main`:** releases push only a tag, so the ruleset that requires
  pull requests on `main` needs no bypass actor. Do not restrict creating `v*`
  tags: the workflow pushes them with its own token.
