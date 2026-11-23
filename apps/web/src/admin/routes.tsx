import { createRoute, redirect } from "@tanstack/react-router";
import { adminRoute, requireTemplateAdmin } from "@/routes/admin";
import { SettingsPage } from "./settings-page";
import { ClaimsPage } from "./claims/claims-page";
import { ClaimPage } from "./claims/claim-page";
import { FormsPage } from "./forms/forms-page";
import { NewFormPage } from "./forms/new-form-page";
import { FormPage } from "./forms/form-page";
import { TemplatesPage } from "./templates/templates-page";
import { TemplatePage } from "./templates/template-page";
import { PrivacyNoticePage } from "./privacy/privacy-notice-page";
import { NewPrivacyNoticePage } from "./privacy/new-privacy-notice-page";
import { GeneralPage } from "./settings/general-page";
import { AppearancePage } from "./settings/appearance-page";
import { UpdatesPage } from "./settings/updates-page";

/**
 * The admin area's pages, all in the app frame (routes/admin.tsx). Claims and
 * Forms for template admins and form editors; the Admin group for template
 * admins only (the server checks every role too). Each page's agent fills its
 * component file; a page that needs search parameters adds `validateSearch`
 * to its route here.
 */

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
  component: ClaimsPage,
});

export const claimRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/admin/claims/$claimId",
  component: ClaimPage,
});

export const formsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/admin/forms",
  component: FormsPage,
});

export const newFormRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/admin/forms/new",
  component: NewFormPage,
});

export const formRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/admin/forms/$formId",
  component: FormPage,
});

export const templatesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/admin/templates",
  beforeLoad: requireTemplateAdmin,
  component: TemplatesPage,
});

export const newTemplateRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/admin/templates/new",
  beforeLoad: requireTemplateAdmin,
  component: TemplatePage,
});

export const templateRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/admin/templates/$templateId",
  beforeLoad: requireTemplateAdmin,
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

export const generalRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/admin/general",
  beforeLoad: requireTemplateAdmin,
  component: GeneralPage,
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

export const adminRoutes = [
  adminIndexRoute,
  claimsRoute,
  claimRoute,
  formsRoute,
  newFormRoute,
  formRoute,
  templatesRoute,
  newTemplateRoute,
  templateRoute,
  privacyNoticeRoute,
  newPrivacyNoticeRoute,
  generalRoute,
  appearanceRoute,
  updatesRoute,
  settingsRoute,
] as const;
