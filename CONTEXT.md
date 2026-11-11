# Domain glossary

The words the code, docs and reviews use for this app's concepts. Field-level details
are in [the form contract](docs/form-contract.md); operations in
[operations](docs/operations.md).

## Intake

- **Form**: what participants fill in at `/f/<slug>/`, made from a **Template** that
  sets its internal values, travel mode, mileage and **Declaration**.
- **Draft**: one participant's session-bound, token-authorized copy of a form, opened
  against the form's revision. Every participant action passes the Draft gate with a
  named action: READ, REVIEW, REMOVE, UPLOAD or SUBMIT (`portal/services/drafts.py`).
- **Upload**: a receipt or signature file of a draft. Validation scans it, normalizes
  it in the document sandbox and publishes its output; a PDF is its own output
  (`documents.validate_upload`). Every failure code has a participant message, or is
  listed as one the participant cannot fix (`intake.UNCHECKED_FAILURES`).
- **Entries**: a valid submission in the parts acceptance stores: claim fields, expense
  rows, signature and total (`claim_validation.Entries`).
- **Acceptance**: turning a draft into a **Claim**. Every file of the claim is checked
  before the claim is written (`uploads.claimable`).

## Claims

- **Claim**: an accepted submission with its **Expenses** (receipt or mileage rows),
  bookkeeping reference, snapshot and authoritative PDF.
- **Claim status**: what a claim shows to operators and its participant: the claim's
  processing state until a Finance delivery exists, then the delivery's state, and
  `purging` while it is deleted. One rule, in `portal/services/claim_status.py`.
  Participants see three outcomes: processing, problem or delivered.
- **Retention**: when a claim's PDF and content are deleted, and deleting them. A claim
  is resolved once Finance has its PDF (`portal/services/retention.py`).

## Email

- **Outbound email**: every email the app sends, through `portal/services/outbound.py`:
  recipient rules, the transport, and local copies. Each email is sent at most once.
- **Finance delivery**: sending a claim's PDF to its approved Finance inbox, in one or
  more **Delivery attempts**.
- **Confirmation**: the participant's confirmation of receipt, without attachments or
  banking details.
- **Evidence**: what MailerSend says about a sent message, from a webhook or a lookup.
  The MailerSend adapter translates it; the Delivery module applies it to an attempt.
