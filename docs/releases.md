# Releases

A release bundles everything merged to `main` since the previous one. Maintainers
start it by hand; nothing is released on merge. A release is a `vX.Y.Z` tag on a
`main` commit that passed CI. No file holds the version (`pyproject.toml` stays at
`0.0.0`), and releasing pushes nothing to `main`. Every Meldgrove project releases
the same way.

## Version numbers

The version says whether a release installs without anyone acting. While the version
is below 1.0.0:

- **Patch** (the default): everything that operators need not act on. Fixes,
  dependency and base image updates, and also new features, settings, and database
  migrations that run on their own.
- **Minor:** only when operators must act on upgrade. For example a new or renamed
  required variable in `compose.yaml`, changed Keycloak, MailerSend or PostgreSQL
  requirements, a migration with manual steps, or a changed public URL. Label the pull
  request `breaking`; the release notes say what to do.
- **Major:** 1.0.0 is the maintainers' deliberate decision.

From 1.0.0, a release that operators must act on is a major version, new features are
minor versions, and fixes are patches.

A release that needs action therefore starts a new series, and a series tag such as
`0.3` (from 1.0.0 the major version, `1`) receives every release that needs none:
deployments that follow it stay current. The workflow refuses a smaller version when a
pull request merged since the last release is labelled `breaking`.

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
3. Run it again without "Dry run". Deployments that follow a series or `latest`
   install it once their cooldown is over, three days unless they set another, so have
   the upgrade steps of a release that needs them ready.
4. When the release needs operator action, edit its notes on GitHub and add the
   upgrade steps at the top.

The workflow (`.github/workflows/release.yaml`) calls the workflow that every
Meldgrove project shares
([meldgrove/.github](https://github.com/meldgrove/.github#release-workflow)). It stops
without changes when it is not started from `main`, when CI has not passed for that
commit, when nothing changed since the last release, or when the chosen version is too
small for a pull request labelled `breaking`. Otherwise it:

- raises the latest `vX.Y.Z` tag by the chosen part, tags the commit, and pushes
  only the tag;
- builds the production image with the version for amd64 and arm64 and publishes
  it as `ghcr.io/meldgrove/reimbursements:X.Y.Z`, `:X.Y`, from 1.0.0 also `:X`,
  and `:latest`. Deployments that run a series tag or `latest` install the release
  after their cooldown when [automatic updates](updates.md) are on;
- attests the image's build provenance and creates the GitHub Release;
- moves the branch `stable` to the released commit. Coolify reads `compose.yaml` from
  `stable`, so that file belongs to the newest release.

If a job fails after the tag was pushed, fix the cause and use "Re-run failed
jobs". It publishes from the tag. Do not start a new release for the same
changes.

**Release candidates:** tick "Release candidate" to publish `X.Y.Z-rc.N` for
testing on a staging server. It publishes only that image tag (never `latest`) and
marks the GitHub Release as a prerelease. Release with the same choice of patch, minor
or major afterwards.

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
gh attestation verify oci://ghcr.io/meldgrove/reimbursements:X.Y.Z \
  --repo meldgrove/reimbursements --signer-repo meldgrove/.github
```

The shared workflow signs the image of every release after 0.3.0. For 0.3.0 and
earlier, leave out `--signer-repo`.

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
- **Code owners:** `.github/CODEOWNERS` assigns `.github/` (workflows and
  release settings) to the `maintainers` team, so a pull request that
  changes it asks the team for review. The team needs write access to the
  repository, or GitHub ignores the line.
