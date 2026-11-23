import { createRoute } from "@tanstack/react-router";
import { participantRoute } from "@/routes/participant";
import { StartPage } from "./start-page";
import { FormPage } from "./form-page";
import { ReceivedPage } from "./received-page";
import { PrivacyPage } from "./privacy-page";

/**
 * The participant pages, in the participant frame (routes/participant.tsx),
 * at the addresses of the Django version: links to /f/<slug>/ are shared.
 */
export const startRoute = createRoute({
  getParentRoute: () => participantRoute,
  path: "/",
  component: StartPage,
});
export const formRoute = createRoute({
  getParentRoute: () => participantRoute,
  path: "/f/$slug",
  component: FormPage,
});
export const receivedRoute = createRoute({
  getParentRoute: () => participantRoute,
  path: "/received/$claimId",
  component: ReceivedPage,
});
export const privacyRoute = createRoute({
  getParentRoute: () => participantRoute,
  path: "/datenschutz",
  component: PrivacyPage,
});

export const participantRoutes = [startRoute, formRoute, receivedRoute, privacyRoute] as const;
