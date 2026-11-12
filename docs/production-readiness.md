# Release checks

Require the CI workflow to pass for the revision being deployed. It checks lint,
formatting, Django configuration, migration drift, the PostgreSQL regression suite,
document confinement, and the production image with compiled styles. A second job
runs that image with a worker: the participant smoke test in Chromium and
`verify_setup` with local email delivery.

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

## Capacity and restore exercise

```bash
./scripts/capacity.sh 250
```

This creates disposable PostgreSQL, web and worker containers, submits synthetic
claims, captures local email, verifies storage, restores a matching database/file
backup and exercises deletion. `CAPACITY_OUTPUT_DIR` chooses the private evidence
directory. `CAPACITY_PAUSE_SECONDS=10` includes a worker pause.

The workload uses two web processes, one worker limited to two CPUs and 2 GB,
two receipt images and one signature per claim. A useful starting target is zero
failures and p95 completion below 15 minutes. Record hardware, image revision and
conditions. This workload excludes malware scanning and external delivery latency;
measure those with staging integrations. No previous installation's performance
results are included.

The image requires Linux Landlock ABI 3+ and libseccomp2. Web and worker each need
a private tmpfs workspace bounded to at most 750 MB; the supplied definition uses
700 MB. Startup refuses missing production credentials, development mode, SQLite,
disabled scanning, local email delivery, disabled confinement or missing heartbeat
checks. See [operations](operations.md) for recovery commands and monitoring.
