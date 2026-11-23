# Participant browser verification

Use the local demo form, local email delivery, and synthetic receipts/signatures.
Run the worker alongside the web application. Never use production receipts.

1. Open `/f/demo/` at a desktop width and a 390-pixel mobile width. Check that
   fields, expense cards, buttons, and totals fit without horizontal scrolling,
   and that filled fields share one font weight.
2. Fill name, address, country, email, test IBAN `DE89370400440532013000`, and
   check that the account holder follows the name. Choose a purpose option. A single
   preset must appear as plain text. Section 02 has no travel checkbox. Confirm that
   there are no expense rows initially; add a receipt row and open the optional
   receipt-only travel details to enter destination and dates.
3. Add two positions, each with merchant, optional receipt reference, and amount
   in euros. The purpose is asked only once in section 02. Enter `10,10` and `20,20`; confirm a `30,30 €` total. Add a
   mileage position with 100 km, number plate, outbound date and return trip with
   return date and confirm `60,00 €`. Receipt-only travel questions must disappear.
   A return date before departure must block review. Unchecking return trip hides
   its date and halves the amount. Remove every row and confirm that review is
   blocked. Submit a separate mileage-only claim without uploading a receipt.
   Duplicate receipt references should warn without blocking submission.
4. Upload mixed JPG/PNG/PDF receipts, including a multipage PDF. Wait for validation.
   Move rows and receipt files. Confirm the file ownership and displayed order.
5. Try invalid amounts, missing fields, missing receipts, and an empty signature.
   Check readable errors and keyboard focus. Unsupported/oversized files must not
   become ready. A scanner outage must leave files pending.
   Pause typing for 650 ms: edited fields must show inline validation errors without
   moving focus. Correcting an IBAN, postcode, or amount must clear its error.
   Changing the country must recheck the postcode; a non-SEPA IBAN must require BIC.
   A delayed response for an earlier value must not overwrite the latest result.
6. Review every value, acknowledge the declaration/privacy notice, and upload a
   synthetic signature. Also verify drawing with mouse or touch. Returning to edit
   must clear both signature and declaration before another review.
7. Submit once and try a double click. The receipt page must say
   "Dein Antrag wurde eingereicht", show one reference, processing progress, and
   no banking details. Opening the form link again starts a new, empty claim. Reload it and confirm the reference
   remains the same. The readable reference follows
   `Erst/YYYY-MM-DD/demo/beispiel/000001` and differs for repeated claims. Another
   browser session must see "Die Erstattung wurde nicht gefunden." instead.
   Payment timing must say the configured support contact. No retention
   duration appears on this page.
8. Inspect the private local `.eml` attachment. Check summary fields, signature,
   exact totals, page completeness, row/file order, PDF bookmarks, and readability.
   Confirm the full serialized PDF is within the output limit.
   A separate participant `.eml` must contain the same reference and no attachments.

The server and web tests (`npm test`, `npm run test:integration`) independently verify
the server contract, document pipeline, compression, webhook signatures, delivery
failures, cleanup, PostgreSQL races and the signature lifecycle. This checklist records
the additional visual and browser interaction checks.

## Scripts

The scripts in `tests/browser` run the same checks in Chromium with Playwright
(`npm ci` in that directory, then `npx playwright install chromium`). They need the app
at `BASE_URL` with a worker, local email delivery and the demo form (`cli seed-demo`).
`node tests/browser/fixtures.cjs DIR` draws the synthetic upload files `train.png`, the
two-page `hotel.pdf` and `signature.png`; set `FIXTURES_DIR` to that folder and
`OUTPUT_DIR` to a folder for screenshots.

- `smoke.cjs` verifies desktop/mobile completion, both signature paths, review reset,
  row/file association, mileage-only claims, totals, delivery, and cross-session
  receipt denial. Without `FIXTURES_DIR` it draws the files itself. `FORM_SLUG` runs it
  against another synthetic form, such as one with a single fixed purpose.
- `live-validation.cjs` checks the debounce delay, focus, error clearing, dependent
  fields, stale responses, expense amounts, server expense errors after row
  reordering, return-date dependencies, and validation before review. It intercepts
  validation responses and sends no uploads or emails.
- `receipt-removal.cjs` checks removal during an active upload, partial deletion
  failure, retry without losing file handles, replacement uploads, and cleanup when a
  file has already gone. Upload and deletion requests are intercepted; no receipt
  leaves the browser.
- `signature-recovery.cjs` injects signature validation failures, polling errors,
  polling timeouts, and a busy deletion response. Uploaded and drawn signatures can be
  replaced repeatedly without exhausting the three-file limit; retrying the same
  handle uses no other file slot, and drawing a replacement makes the old upload's
  retry ineffective, so submission cannot reuse the obsolete signature. Upload and
  submission requests are intercepted, so it sends no mail.
- `error-recovery.cjs` verifies that real IBAN and date errors reveal the details
  step, focus the invalid field and reset the signature acknowledgments, changing the
  submitted request after review to check the server's authoritative checks. It also
  checks a 503 followed by successful receipt validation and the receipt page's status
  recovery. No valid claim is submitted.
- `sign-in.cjs` signs in to the admin area through the development Keycloak of
  `compose.dev.yaml` (template admin `admin` / `admin`) and saves the session to
  `ADMIN_STORAGE_STATE`.
- `admin-form-recovery.cjs` checks publication and archive retries and keyboard
  submission in the form editor: failed publish, unpublish, archive and unarchive
  requests, lost responses, edits after a failure, Enter in text fields, keyboard
  activation of the publication button, the save indicator, toolbar alignment,
  deletion visibility and cancelling the deletion. It makes a draft of its own and
  intercepts every save. Sign in with `ADMIN_STORAGE_STATE` from `sign-in.cjs`, or,
  in development with `DEV_LOGIN=1`, with `ADMIN_USERNAME` of a template admin.

Run the scripts one after another. The 0.4 option `FORM_HTML`, which ran some scripts
against a saved page, is gone: the form is a single-page app.

## In CI

The `Browser and setup checks` job of the [CI workflow](../.github/workflows/ci.yaml)
runs all of them on every pull request against the production image: PostgreSQL and
Keycloak from `compose.dev.yaml`, web and worker from the image in development mode
(local email, no scanner) with the document sandbox and the worker heartbeat on as in
production, `cli seed-demo`, the scripts, and `cli verify-setup --to
finance@example.invalid`. To run it locally, follow the job's steps on a Linux host
with Landlock (Linux 6.2 or later):

```bash
(cd tests/browser && npm ci && npx playwright install chromium)
docker compose -f compose.dev.yaml up --detach --wait database keycloak
docker build --tag reimbursements:ci .
```

then the steps "Migrate and start web and worker" to "Setup check" with `WEB_PORT=8000`
and `RUNNER_TEMP` set to a temporary folder. The development Keycloak accepts sign-ins
for `http://localhost:8000` and `http://localhost:5173` only.
