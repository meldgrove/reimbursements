# Domain glossary

The words the code, docs and reviews use for this app's concepts. Field-level details
are in [the form contract](docs/form-contract.md); operations in
[operations](docs/operations.md).

## Intake

- **Form**: what participants fill in at `/f/<slug>/`, made from a **Template** that
  sets its internal values, travel mode, mileage and **Declaration**. Its status is
  draft, published or archived; an **Archived** form is closed and left out of the
  forms list (`portal/services/publication.py`).
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
- **Retry**: an operator processing a claim again: building a PDF that was never
  produced, or sending the PDF to Finance again. A resend needs the operator's
  acknowledgment while Finance may hold a copy, that is, while any earlier send did not
  definitely fail. `operations.plan_retry` says what a retry would do before it runs.
- **Archived claim**: a claim an operator moved out of the claims list. It keeps its
  status; the Status filter lists it only under Archived (`claim_status.listed`).
- **Retention**: when a claim's PDF and content are deleted, and deleting them. A claim
  is resolved once Finance has its PDF. An archived claim needs no resolution and is
  deleted at the latest on its resolution date (`portal/services/retention.py`).

## Email

- **Outbound email**: every email the app sends, through `portal/services/outbound.py`:
  recipient rules, composing and transmitting each message once (a failure while
  composing is definite), and forgetting local copies and Evidence. Each email has one
  record: a Delivery attempt or a Confirmation.
- **Finance delivery**: sending a claim's PDF to its approved Finance inbox, in one or
  more **Delivery attempts**.
- **Confirmation**: the participant's confirmation of receipt, without attachments or
  banking details.
- **Evidence**: what MailerSend says about a sent email, from a webhook or a lookup.
  The MailerSend adapter translates it; the Evidence module (`portal/services/evidence.py`)
  applies it to the email's record and reconciles the unsettled emails of every sender.

## Updates

- **Release series**: the releases a deployment may install without operator action: the
  same major version, and before 1.0 the same minor version. Its image tag (`0.1`, or `1`
  from 1.0) always names its newest release; `REIMBURSEMENTS_VERSION` chooses it.
- **Deploy link**: the hosting platform's URL that redeploys the app. With automatic
  updates on, the worker calls it once for each newer release of the series
  (`portal/services/updates.py`, [automatic updates](docs/updates.md)).
