import { createRoute, redirect } from "@tanstack/react-router";
import { adminRoute, requireTemplateAdmin } from "@/routes/admin";
import { SettingsPage } from "./settings-page";
import { ClaimsPage } from "./claims/claims-page";
import { ClaimPage } from "./claims/claim-page";
import { RetryPage } from "./claims/retry-page";
import { DeleteClaimsPage } from "./claims/delete-page";
import { FormsPage } from "./forms/forms-page";
import { FormPage } from "./forms/form-page";
import { editorKey } from "./forms/editor-key";
import { TemplatesPage } from "./templates/templates-page";
import { TemplatePage } from "./templates/template-page";
import { PrivacyNoticePage } from "./privacy/privacy-notice-page";
import { NewPrivacyNoticePage } from "./privacy/new-privacy-notice-page";
import { PrivacyNoticeVersionPage } from "./privacy/privacy-notice-version-page";
import { GeneralPage } from "./settings/general-page";
import { AppearancePage } from "./settings/appearance-page";
import { EmailPage } from "./settings/email-page";
import { UpdatesPage } from "./settings/updates-page";
import { SearchPage } from "./search-page";
import type { ClaimsSearch, FormsSearch } from "./api";

/**
 * The admin area's pages, all in the app frame (routes/admin.tsx). Claims and
 * Forms for template admins and form editors; the Admin group for template
 * admins only (the server checks every role too). Lists keep their filters
 * in the address, as Django's change lists did.
 */

const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
const digits = (value: unknown) =>
  typeof value === "number"
    ? String(value)
    : typeof value === "string" && /^\d+$/.test(value)
      ? value
      : undefined;
const page = (value: unknown) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 1 ? number : undefined;
};

/** /admin opens the start page, Claims ("G then O"). */
export const adminIndexRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/admin",
  beforeLoad: () => {
    throw redirect({ to: "/admin/claims" });
  },
});

export const claimsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/admin/claims",
  validateSearch: (search: Record<string, unknown>): ClaimsSearch => ({
    status: text(search.status),
    form: digits(search.form),
    q: text(search.q),
    year: digits(search.year),
    month: digits(search.month),
    day: digits(search.day),
    page: page(search.page),
  }),
  component: ClaimsPage,
});

export const deleteClaimsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/admin/claims/delete",
  validateSearch: (search: Record<string, unknown>): { ids?: string } => ({ ids: text(search.ids) }),
  beforeLoad: requireTemplateAdmin,
  component: DeleteClaimsPage,
});

export const claimRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/admin/claims/$claimId",
  component: ClaimPage,
});

export const retryRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/admin/claims/$claimId/retry",
  beforeLoad: requireTemplateAdmin,
  component: RetryPage,
});

export const formsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/admin/forms",
  validateSearch: (search: Record<string, unknown>): FormsSearch => ({
    status: text(search.status),
    primary: search.primary === "1" || search.primary === "0" ? search.primary : undefined,
    template: digits(search.template),
    q: text(search.q),
    page: page(search.page),
  }),
  component: FormsPage,
});

/**
 * A form's editor; "new" chooses a template first (`?template=`). A new form
 * keeps its editor when the first save gives it an address of its own, so
 * nothing typed meanwhile is lost (`editorKey`).
 */
export const formRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/admin/forms/$formId",
  validateSearch: (search: Record<string, unknown>): { template?: number } => ({
    template: digits(search.template) ? Number(digits(search.template)) : undefined,
  }),
  remountDeps: ({ params, search }) => editorKey(params.formId, search.template),
  component: FormPage,
});

export const templatesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/admin/templates",
  validateSearch: (search: Record<string, unknown>): { q?: string } => ({ q: text(search.q) }),
  beforeLoad: requireTemplateAdmin,
  component: TemplatesPage,
});

export const newTemplateRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/admin/templates/new",
  beforeLoad: requireTemplateAdmin,
  component: TemplatePage,
});

/** A template; form editors may open it read-only (links from 0.4 and from their forms), as in Django. */
export const templateRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/admin/templates/$templateId",
  component: TemplatePage,
});

export const privacyNoticeRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/admin/privacy-notice",
  beforeLoad: requireTemplateAdmin,
  component: PrivacyNoticePage,
});

export const newPrivacyNoticeRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/admin/privacy-notice/new",
  beforeLoad: requireTemplateAdmin,
  component: NewPrivacyNoticePage,
});

export const privacyNoticeVersionRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/admin/privacy-notice/$noticeId",
  beforeLoad: requireTemplateAdmin,
  component: PrivacyNoticeVersionPage,
});

export const generalRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/admin/general",
  beforeLoad: requireTemplateAdmin,
  component: GeneralPage,
});

export const emailRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/admin/email",
  beforeLoad: requireTemplateAdmin,
  component: EmailPage,
});

export const appearanceRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/admin/appearance",
  beforeLoad: requireTemplateAdmin,
  component: AppearancePage,
});

export const updatesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/admin/updates",
  beforeLoad: requireTemplateAdmin,
  component: UpdatesPage,
});

export const settingsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/admin/settings",
  component: SettingsPage,
});

export const searchRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/admin/search",
  validateSearch: (search: Record<string, unknown>): { q?: string } => ({ q: text(search.q) }),
  component: SearchPage,
});

export const adminRoutes = [
  adminIndexRoute,
  claimsRoute,
  deleteClaimsRoute,
  claimRoute,
  retryRoute,
  formsRoute,
  formRoute,
  templatesRoute,
  newTemplateRoute,
  templateRoute,
  privacyNoticeRoute,
  newPrivacyNoticeRoute,
  privacyNoticeVersionRoute,
  generalRoute,
  emailRoute,
  appearanceRoute,
  updatesRoute,
  settingsRoute,
  searchRoute,
] as const;
