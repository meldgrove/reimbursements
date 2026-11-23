import { Hono } from "hono";
import { asc, eq } from "drizzle-orm";
import { APP_NAME } from "@reimbursements/shared/constants";
import { devLoginSchema, type Meta, type MeUser } from "@reimbursements/shared/api/meta";
import { config } from "../config";
import { users, type User } from "../db/schema";
import { q } from "../db/tx";
import type { AppEnv } from "../http/env";
import { jsonBody } from "../http/middleware";
import { notFound } from "../http/errors";
import { accountUrl, providerLogoutUrl } from "../auth/oidc";
import { endSession, startSession } from "../auth/session";
import { roles, TEMPLATE_ADMIN } from "../auth/roles";
import { loadSettings } from "../services/app-settings";

/** The person of the admin area as pages see them; null without access. */
export async function meUser(user: User | null): Promise<MeUser | null> {
  if (!user) return null;
  const granted = await roles(user);
  if (granted.size === 0) return null;
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email || user.username;
  return {
    id: user.id,
    name,
    email: user.email,
    roles: [...granted],
    isTemplateAdmin: granted.has(TEMPLATE_ADMIN),
    isFormEditor: true,
  };
}

const router = new Hono<AppEnv>();

/** What every page of both areas needs; answered without a session too. */
router.get("/meta", async (c) => {
  const settings = config();
  const user = await meUser(c.get("user"));
  const body: Meta = {
    appName: APP_NAME,
    version: settings.APP_VERSION ?? "",
    settings: c.get("settings") ?? (await loadSettings()),
    operator: settings.PORTAL_OPERATOR,
    legalUrl: settings.PORTAL_LEGAL_URL,
    user,
    updatesButton: Boolean(user?.isTemplateAdmin && settings.UPDATER_URL),
    accountUrl: user ? accountUrl() : "",
    auth: {
      oidcEnabled: settings.oidcEnabled,
      providerName: settings.oidcProviderName,
      devLogin: settings.isDevelopment && settings.DEV_LOGIN,
    },
  };
  return c.json(body);
});

/** Signs out here, and tells the browser where to go: the provider's sign-out, or the start page. */
router.post("/auth/logout", async (c) => {
  const idToken = await endSession(c);
  return c.json({ redirect: await providerLogoutUrl(idToken) });
});

const devLoginEnabled = () => config().isDevelopment && config().DEV_LOGIN;

/** Development only (DEV_LOGIN=1 in a development deployment): sign in as an existing user. */
router.get("/auth/dev-users", async (c) => {
  if (!devLoginEnabled()) throw notFound();
  const rows = await q().select().from(users).where(eq(users.isActive, true)).orderBy(asc(users.username));
  const people = [];
  for (const user of rows) {
    const me = await meUser(user);
    if (me) people.push({ username: user.username, name: me.name, email: user.email, roles: me.roles });
  }
  return c.json(people);
});

router.post("/auth/dev-login", async (c) => {
  if (!devLoginEnabled()) throw notFound();
  const { username } = await jsonBody(c, devLoginSchema);
  const [user] = await q().select().from(users).where(eq(users.username, username)).limit(1);
  if (!user || !(await meUser(user))) throw notFound("No active user with a role has this name.");
  if (!(await startSession(c, user))) throw notFound("No active user with a role has this name.");
  return c.json({ ok: true });
});

export default router;
