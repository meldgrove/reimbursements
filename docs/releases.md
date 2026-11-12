# Releases

A release bundles everything merged to `main` since the previous one. Maintainers
start it by hand; nothing is released on merge.

## Version numbers

Versions follow Semantic Versioning, judged by what an operator has to do to
upgrade:

- **Major:** the upgrade needs operator action. For example a new or renamed
  required variable in `compose.yaml`, changed Keycloak, MailerSend or PostgreSQL
  requirements, a migration with manual steps, or a changed public URL.
- **Minor:** new features and migrations that need no operator action.
- **Patch:** fixes and dependency updates.

Before 1.0.0, a minor release may also need operator action. Its notes say so.

## Cut a release

1. Wait for CI to pass on the latest `main` commit.
2. In GitHub, open Actions > Release > Run workflow. Choose patch, minor or major.
   Tick "Dry run" first to see the next version and its notes without changing
   anything.
3. When a release needs operator action, edit its notes on GitHub afterwards and
   add the upgrade steps at the top.

The workflow stops without changes when it is not started from `main`, when CI
has not passed for that commit, when nothing changed since the last release, or
when the version in `pyproject.toml` differs from the latest tag. Otherwise it:

- raises the version in `pyproject.toml` and `uv.lock` with the uv version the
  Dockerfile pins, commits `chore(release): vX.Y.Z` and tags it;
- pushes the commit and tag together. If `main` moved during the run, neither
  lands and nothing is released; start it again;
- builds the production image with the version and pushes it as
  `ghcr.io/meldgrove/reimbursements:X.Y.Z` and `:X.Y`, and from 1.0.0 also `:X`;
- attests the image's build provenance;
- creates the GitHub Release with notes generated from the titles of merged pull
  requests, so write titles as release-note lines.

If the image or release step fails after the tag was pushed, fix the cause and
use "Re-run failed jobs". That job rebuilds from the tag. Do not start a new
release for the same changes.

After the first release, make the `reimbursements` package public in the
organisation's package settings if it is not already, so operators can pull
it without signing in.

## Release images

Release images set `APP_VERSION`. `/-/healthz` reports it, and error reports name
the release `reimbursements@X.Y.Z` unless `SENTRY_RELEASE` is set. Images built
from source report no version unless built with `--build-arg APP_VERSION=X.Y.Z`;
Coolify passes its environment variables as build arguments.

Verify an image's origin with:

```bash
gh attestation verify oci://ghcr.io/meldgrove/reimbursements:X.Y.Z --owner meldgrove
```

## Protected main branch

The workflow pushes the version commit and tag straight to `main` with the
workflow's own token. Once a ruleset requires pull requests on `main`, that push
is rejected. Give the push to a GitHub App that may bypass the ruleset:

1. Create a GitHub App owned by the organisation, without a webhook, with the
   repository permission Contents: Read and write. Install it on this
   repository only.
2. Add the app as a bypass actor (always allow) to the ruleset for `main`, and to
   any ruleset that protects `v*` tags.
3. Generate a private key for the app. Add the repository variable
   `RELEASE_APP_CLIENT_ID` with the app's client ID, and the repository secret
   `RELEASE_APP_PRIVATE_KEY` with the key.

With the variable set, the workflow pushes with the app's token. Commits pushed by
the app also start CI on `main`; those pushed by the workflow's own token do not.
