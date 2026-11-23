import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { config } from "../config";
import { logger } from "../logger";
import type { AppEnv } from "./env";
import {
  authorizationUrl,
  callbackUrl,
  completeSignIn,
  ProviderUnavailable,
  type SignInState,
} from "../auth/oidc";
import { userForClaims, SignInRefused } from "../auth/claims";
import { cookieName, endSession, secureCookies, sign, startSession, unsign } from "../auth/session";

/**
 * The sign-in's redirects: /oidc/authenticate/ sends the browser to the
 * provider, /oidc/callback/ comes back from it (the paths of the Django
 * version, so the provider's client needs no change). Someone without a
 * verified email address or a role group lands on the no-access page;
 * other failures land on the sign-in page with a reason: `denied` (the
 * sign-in did not check out) or `unavailable` (the provider cannot be
 * reached).
 */

/** The pending sign-ins (cookieName: `__Host-` on HTTPS, so on the whole site). */
const stateCookie = () => cookieName("reimbursements_oidc");
const STATE_SECONDS = 600;
/** Sign-ins a browser may have open at once (several tabs). */
const MAX_STATES = 5;

type StoredState = SignInState & { expires: number };

/** A path in this app to go to after sign-in; anything else becomes "/". */
export function safeNext(value: string | undefined | null, fallback = "/admin/"): string {
  return safePath(value) ?? fallback;
}

function safePath(value: string | undefined | null): string | null {
  if (!value || value.length > 2000) return null;
  const controls = [...value].some((character) => character.charCodeAt(0) < 32);
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.startsWith("/\\") ||
    controls ||
    value.includes("\\")
  ) {
    return null;
  }
  try {
    const url = new URL(value, "http://app.example.invalid");
    if (url.origin !== "http://app.example.invalid") return null;
    const next = url.pathname + url.search + url.hash;
    // Normalizing can turn "/.//host" into "//host", which a browser reads as another site.
    return next.startsWith("//") || next.startsWith("/\\") ? null : next;
  } catch {
    return null;
  }
}

function readStates(c: Context): StoredState[] {
  const states = unsign<StoredState[]>(getCookie(c, stateCookie())) ?? [];
  return Array.isArray(states) ? states.filter((state) => state && state.expires > Date.now()) : [];
}

function writeStates(c: Context, states: StoredState[]) {
  if (states.length === 0) {
    deleteCookie(c, stateCookie(), { path: "/", secure: secureCookies() });
    return;
  }
  setCookie(c, stateCookie(), sign(states), {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "Lax",
    path: "/",
    maxAge: STATE_SECONDS,
  });
}

const toSignIn = (c: Context, error: "denied" | "unavailable") =>
  c.redirect(`/admin/login?error=${error}`, 302);
/** Where people without access land (the Django version's /admin/no-access/). */
const toNoAccess = (c: Context) => c.redirect("/admin/no-access", 302);

export function signInRoutes() {
  const app = new Hono<AppEnv>();

  app.get("/oidc/authenticate/", async (c) => {
    if (!config().oidcEnabled) return toSignIn(c, "unavailable");
    try {
      const { url, state } = await authorizationUrl(safeNext(c.req.query("next")));
      const states = [...readStates(c), { ...state, expires: Date.now() + STATE_SECONDS * 1000 }].slice(
        -MAX_STATES,
      );
      writeStates(c, states);
      c.header("cache-control", "no-store");
      return c.redirect(url, 302);
    } catch (error) {
      logger.warn({ error: safeError(error) }, "sign-in provider unavailable");
      return toSignIn(c, "unavailable");
    }
  });

  app.get("/oidc/callback/", async (c) => {
    c.header("cache-control", "no-store");
    const states = readStates(c);
    const stateParam = c.req.query("state");
    const state = states.find((item) => item.state === stateParam);
    // Each state is used once.
    writeStates(
      c,
      states.filter((item) => item !== state),
    );
    // A callback for no sign-in this browser started: as in the Django version, a
    // 400 that leaves the current session alone. The provider's error callback
    // can end a session, so it needs a state too.
    if (!state) return c.text("Bad request", 400);
    if (c.req.query("error")) {
      await endSession(c);
      return toNoAccess(c);
    }
    let signedIn: { claims: Record<string, unknown>; idToken: string };
    try {
      // The provider redirected to the callback URL of APP_URL; behind a
      // proxy the request's own URL may differ (scheme, host, port). The code
      // exchange must name the callback URL the sign-in started with.
      const current = new URL(callbackUrl());
      current.search = new URL(c.req.url).search;
      signedIn = await completeSignIn(current, state);
    } catch (error) {
      if (error instanceof ProviderUnavailable || isNetworkError(error)) {
        logger.warn({ error: safeError(error) }, "sign-in provider request failed");
        return toSignIn(c, "unavailable");
      }
      logger.warn({ error: safeError(error) }, "sign-in did not check out");
      return toSignIn(c, "denied");
    }
    try {
      const user = await userForClaims(signedIn.claims);
      if (!(await startSession(c, user, signedIn.idToken))) return toNoAccess(c);
    } catch (error) {
      if (error instanceof SignInRefused) {
        logger.warn({ code: error.reason }, "sign-in refused");
        await endSession(c);
        return toNoAccess(c);
      }
      throw error;
    }
    return c.redirect(state.next, 302);
  });

  return app;
}

/**
 * What the log may say about a failed sign-in: the kind of error and the
 * provider's error code or status, never its description or body, which can
 * quote tokens or personal data.
 */
function safeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { type: typeof error };
  const fields = error as Error & { code?: unknown; error?: unknown; status?: unknown };
  return {
    type: error.constructor.name,
    code: typeof fields.code === "string" ? fields.code : undefined,
    error: typeof fields.error === "string" && /^[a-z_]{1,64}$/.test(fields.error) ? fields.error : undefined,
    status: typeof fields.status === "number" ? fields.status : undefined,
  };
}

function isNetworkError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (current.name === "TimeoutError" || current.message === "fetch failed") return true;
    current = current.cause;
  }
  return false;
}
