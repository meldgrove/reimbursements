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
   `Erst/YYYY-MM-DD/demo/beispiel/000001` and differs for repeated claims. Another browser session must receive a 404 for that page.
   Payment timing must say the configured support contact. No retention
   duration appears on this page.
8. Inspect the private local `.eml` attachment. Check summary fields, signature,
   exact totals, page completeness, row/file order, PDF bookmarks, and readability.
   Confirm the full serialized PDF is within the output limit.
   A separate participant `.eml` must contain the same reference and no attachments.

Tests in `tests/` independently verify the server contract, document pipeline,
compression, webhook signatures, delivery failures, cleanup, and PostgreSQL races.
This checklist records the additional visual and browser interaction checks.

`tests/browser/live-validation.cjs` checks the debounce delay, focus, error clearing,
dependent fields, stale responses, expense amounts, server Expense errors after row
reordering, return-date dependencies, and validation before review.
It intercepts validation responses and sends no uploads or emails.

The repeatable interaction smoke test is `tests/browser/smoke.cjs`. With Playwright
available to Node, set `BASE_URL`, `FIXTURES_DIR` and `OUTPUT_DIR`, then run it with
Node. Supply only synthetic `train.png`, two-page `hotel.pdf`, and `signature.png`
fixtures. It verifies desktop/mobile completion, both signature paths, review
reset, row/file association, mileage-only claims, totals, delivery, and cross-session
receipt denial. Set `FORM_SLUG` to run against a different synthetic form, including
a form with a single fixed purpose.

Run `tests/browser/signature-recovery.cjs` with the same `BASE_URL` and
`FIXTURES_DIR` to inject signature validation failures, polling errors, polling
timeouts, and a busy deletion response. It checks that uploaded and drawn
signatures can be replaced repeatedly without exhausting the three-file limit.
Upload and submission endpoints are intercepted in this test, so it sends no mail.

Transient polling errors and delayed checks retain the existing upload. The
signature recovery script verifies retrying the same handle without consuming
another file slot. It accelerates polling delays while preserving request deadlines.
It also verifies that drawing a replacement makes the old upload's retry action
ineffective, so submission cannot revive and reuse the obsolete signature.

Run `tests/browser/error-recovery.cjs` with the same variables. It verifies that
real IBAN and date validation errors reveal the details step, focus the invalid
field and reset the signature acknowledgments. It also checks a 503 followed by
successful receipt validation and receipt-page status recovery. The upload routes
are intercepted and no valid claim is submitted. Run these browser scripts
sequentially when using the local SQLite fallback; release checks use PostgreSQL.

`tests/browser/admin-form-recovery.cjs` checks publication retries and keyboard
submission in the admin editor. Set `FORM_ADMIN_URL` to the change URL of a local
draft with no participant drafts or claims. Set `ADMIN_STORAGE_STATE` to a
Playwright storage-state file for a local admin session. It intercepts every save,
so it leaves the draft unchanged. The
test covers failed publish/unpublish requests, lost responses, edits after a
failure, Enter in text fields, and keyboard activation of the publication button.
It also verifies the save spinner/checkmark, toolbar alignment, deletion visibility,
and cancellation from the deletion confirmation page.

`node --test tests/js/*.test.cjs` checks the Signature lifecycle without a browser or
server. It covers failed-upload cleanup, deletion failure, pending Upload reuse,
obsolete polling results and drawings changed during capture. CI runs these checks
alongside the server suite. Canvas rendering, busy controls and consent reset remain
covered by the browser recovery scripts.

`FORM_HTML=/absolute/path/to/rendered-demo.html` runs live-validation and
signature-recovery against an offline rendered page. The scripts intercept the
page and local scripts; validation is simulated, so server rule agreement is tested
separately in `tests/test_claim_validation.py`. Error-recovery uses a running local
portal and changes entries after review to verify authoritative submission checks.

`tests/browser/receipt-removal.cjs` checks removal during an active upload,
partial deletion failure, retry without losing file handles, replacement uploads,
and cleanup when a file has already gone. Run it with the demo form or set
`FORM_HTML` to a rendered demo page. Upload and deletion endpoints are intercepted;
no receipt leaves the browser. It requires Playwright available to Node.
