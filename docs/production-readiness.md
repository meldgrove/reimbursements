# Release checks

Require the CI workflow to pass for the revision being deployed. Its first job checks
the public repository contents, lint, formatting, types, the unit tests, that the
database migrations match the schema, the integration tests on PostgreSQL (document
confinement included), the production dependencies' audit and the production image:
it runs as uid 10001, refuses to start without its settings, passes its sandbox
self-test, and starts with the Compose file of 0.4 and back (the upgrade test). A
second job runs that image with a worker: the participant browser checks in Chromium,
the admin editor check after a real Keycloak sign-in, and `cli verify-setup` with
local email delivery ([browser checks](browser-checks.md)).

Before accepting claims, run the [setup check](operations.md#setup-check) and verify
the following in staging with synthetic data:

- Operator identity, support address, privacy notice, declaration and internal accounting fields.
- Both sign-in roles and the separation between form editors and template admins.
- Receipt and mileage submission, both signature paths, PDF page completeness and legibility.
- Accounting delivery and participant confirmation, signed callbacks, reconciliation and unknown-send review.
- Worker/scanner readiness, queue age, free storage and independent monitoring.
- PDF and content deletion, including failed or unresolved delivery retention.
- Encrypted off-host backup and a matching database/private-file restore.

The portal deletes delivered PDFs after 7 days and remaining claim content after
90 days from submission. Unresolved delivery suspends deletion until resolution or
archiving.
Review external recipient retention separately. Replace the initial privacy setup
notice before publishing forms.

## Capacity

Measure capacity on staging with synthetic claims before launch: two receipt images
and one signature per claim, the worker limited to two CPUs and 2 GB as in
`compose.yaml`. A useful starting target for 250 participants is zero failures and a
p95 completion below 15 minutes. Record hardware, image revision and conditions, and
include malware scanning and external delivery latency. No previous installation's
performance results are included. The scripted capacity and restore exercise of 0.4
(`scripts/capacity.sh`) is not part of 0.5; test restores with
[Meldgrove Backups](deployment.md#backups) or by hand
([operations](operations.md#backup-and-restore)).

The image requires Linux Landlock ABI 3+ and libseccomp2. Web and worker each need
a private tmpfs workspace bounded to at most 750 MB; the supplied definition uses
700 MB. Outside development, startup refuses missing production credentials,
disabled scanning, local email delivery, disabled confinement or missing heartbeat
checks. See [operations](operations.md) for recovery commands and monitoring.
