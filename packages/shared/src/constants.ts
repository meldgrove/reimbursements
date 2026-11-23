/** The product name, the same in every language and deployment. */
export const APP_NAME = "Meldgrove Reimbursement";
/** The short name in the app frame's sidebar. */
export const APP_SHORT_NAME = "Reimbursements";
/** The app's repository: the About card and the sign-in page say it is part of Meldgrove. */
export const REPOSITORY_URL = "https://github.com/meldgrove/reimbursements";
/** What the app is for, in one sentence: the large text of the sign-in page. */
export const APP_TAGLINE =
  "Collect expense claims with receipts and signatures, and send them to accounting.";
/** Standard participant texts, in English; the German dictionary holds their German version. */
export const DECLARATION =
  "I confirm that the stated expenses were actually incurred, serve the stated purpose " +
  "and have not been reimbursed before.";
export const DECLARATION_VERSION = "reimbursement-v1";
export const MAX_IMAGE_PIXELS = 40_000_000;
export const MAX_NORMALIZED_FILE_BYTES = 10_000_000;
export const MAX_PDF_PAGES = 30;
export const MAX_RECEIPT_DIMENSION = 3508;
export const FORM_TITLE = "Your expenses. Simply submitted.";
export const FORM_DESCRIPTION =
  "Submit the costs you paid out of your own pocket for reimbursement. " +
  "Your details, receipts and signature are sent to accounting as a PDF.";
export const PAYMENT_TIMING =
  "For questions about your claim or the payment, contact the address given in the form.";

/** Constants translated where they are shown, e.g. t(FORM_TITLE) (i18n.test.ts reads this list). */
export const TRANSLATED_ELSEWHERE = [
  "I confirm that the stated expenses were actually incurred, serve the stated purpose and have not been reimbursed before.",
  "Your expenses. Simply submitted.",
  "Submit the costs you paid out of your own pocket for reimbursement. Your details, receipts and signature are sent to accounting as a PDF.",
  "For questions about your claim or the payment, contact the address given in the form.",
];

/** The roles of the admin area: Django group names, kept so the Django version reads them too. */
export const TEMPLATE_ADMIN = "Vorlagen-Admins";
export const FORM_EDITOR = "Formular-Editoren";
export const ROLES = [TEMPLATE_ADMIN, FORM_EDITOR] as const;
export type RoleName = (typeof ROLES)[number];
