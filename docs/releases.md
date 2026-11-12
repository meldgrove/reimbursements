# Releases

A release bundles everything merged to `main` since the previous one. Maintainers
start it by hand; nothing is released on merge. Every Meldgrove project releases
the same way.

## Version numbers

Versions follow Semantic Versioning, judged by what an operator has to do to
upgrade:

- **Major:** the upgrade needs operator action. For example a new or renamed
  required variable in `compose.yaml`, changed Keycloak, MailerSend or PostgreSQL
  requirements, a migration with manual steps, or a changed public URL.
- **Minor:** new features and migrations that need no operator action.
- **Patch:** fixes and dependency updates.

Before 1.0.0, a minor release may also need operator action. Its notes say so.

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
3. Run it again without "Dry run".
4. When the release needs operator action, edit its notes on GitHub and add the
   upgrade steps at the top.

The workflow stops without changes when it is not started from `main`, when CI
has not passed for that commit, when nothing changed since the last release, or
when `pyproject.toml` does not hold the version of the latest release. Otherwise
it:

- raises the version in `pyproject.toml` and `uv.lock` with the uv that the
  Dockerfile pins, commits `chore(release): vX.Y.Z` and tags it. The first
  release keeps the version already in `pyproject.toml`;
- pushes the commit and tag together. If `main` moved during the run, neither
  lands and nothing is released; start it again;
- builds the production image with the version for amd64 and arm64 and publishes
  it as `ghcr.io/meldgrove/reimbursements:X.Y.Z`, `:X.Y`, from 1.0.0 also `:X`,
  and `:latest`. Deployments that run a series tag (`0.Y`, or `X` from 1.0.0) install
  the release automatically when [automatic updates](updates.md) are on;
- attests the image's build provenance and creates the GitHub Release.

If a job fails after the tag was pushed, fix the cause and use "Re-run failed
jobs". It publishes from the tag. Do not start a new release for the same
changes.

**Release candidates:** tick "Release candidate" to publish `X.Y.Z-rc.N` for
testing on a staging server. It tags the current commit without changing
`pyproject.toml`, publishes only that image tag (never `latest`), and marks the
GitHub Release as a prerelease. Release with the same choice of patch, minor or
major afterwards.

Pull requests that change the `Dockerfile`, `.dockerignore`,
`scripts/start-web.sh` or the workflow build and start both images without
publishing.

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
- **Protected `main`:** the workflow pushes the version commit and tag straight
  to `main` with the workflow's own token. Once a ruleset requires pull requests
  on `main`, that push is rejected. Give the push to a GitHub App that may bypass
  the ruleset:

  1. Create a GitHub App owned by the organisation, without a webhook, with the
     repository permission Contents: Read and write. Install it on this
     repository only.
  2. Add the app as a bypass actor (always allow) to the ruleset for `main`, and
     to any ruleset that protects `v*` tags.
  3. Generate a private key for the app. Add the repository variable
     `RELEASE_APP_CLIENT_ID` with the app's client ID, and the repository secret
     `RELEASE_APP_PRIVATE_KEY` with the key.

  With the variable set, the workflow pushes with the app's token. Commits pushed
  by the app also start CI on `main`; those pushed by the workflow's own token do
  not.
