import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config, overrideConfigForTests, resetConfigForTests } from "../config";
import { getDb } from "../db/client";
import { sessions, users } from "../db/schema";
import { createUser, request, resetDatabase, testApp } from "../test/helpers";
import {
  claims,
  CLIENT_ID,
  DISCOVERY,
  rsaKey,
  setCookie,
  signIn,
  useFakeProvider,
  type FakeProvider,
} from "../test/fake-provider";
import { providerLogoutUrl, resetDiscoveryCache } from "./oidc";
import { FORM_EDITOR, roles, TEMPLATE_ADMIN } from "./roles";

/**
 * The admin area's sign-in (portal/auth.py, tests/test_admin_sessions.py of
 * the Django version): the provider's checks, roles from its groups at every
 * sign-in, the 8-hour session and sign-out.
 */

const NO_ACCESS = "/admin/no-access";

let provider: FakeProvider;
let restore: () => void;

const sessionCookie = (token: string) => ({ cookie: `reimbursements_session=${token}` });
const me = async (token: string | undefined) =>
  token ? (await request("GET", "/api/v1/meta", { headers: sessionCookie(token) })).body.user : null;

describe("sign-in to the admin area", () => {
  beforeAll(() => {
    ({ provider, restore } = useFakeProvider());
  });
  afterAll(() => restore());

  beforeEach(async () => {
    await resetDatabase();
    resetConfigForTests();
    resetDiscoveryCache();
    provider.discovery = DISCOVERY;
    provider.userInfo = claims();
    provider.idToken = {};
    provider.requests.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  it("sends the browser to the provider with PKCE, a state and a nonce", async () => {
    const response = await testApp().request("/oidc/authenticate/");
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.href.startsWith(DISCOVERY.authorization_endpoint)).toBe(true);
    for (const name of ["state", "nonce", "code_challenge"])
      expect(location.searchParams.get(name)).toBeTruthy();
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("redirect_uri")).toBe("http://localhost:8000/oidc/callback/");
  });

  it("creates the person on first sign-in, with name, email and roles from the provider", async () => {
    const { location, session } = await signIn(provider);
    expect(location).toBe("/admin/");
    const [user] = await getDb().select().from(users);
    expect(user).toMatchObject({
      username: "subject-1",
      email: "ada@example.invalid",
      firstName: "Ada",
      lastName: "Admin",
      isStaff: true,
      isActive: true,
    });
    expect(user!.password.startsWith("!")).toBe(true);
    expect(user!.lastLogin).toBeInstanceOf(Date);
    expect([...(await roles(user!))]).toEqual([TEMPLATE_ADMIN]);
    expect(await me(session)).toMatchObject({ email: "ada@example.invalid", isTemplateAdmin: true });
  });

  it("replaces the roles at every sign-in from the groups claim", async () => {
    await signIn(provider);
    provider.userInfo = claims({ groups: ["/reimbursements/editors"], email: "new@example.invalid" });
    const { session } = await signIn(provider);
    const [user] = await getDb().select().from(users);
    expect([...(await roles(user!))]).toEqual([FORM_EDITOR]);
    expect(user!.email).toBe("new@example.invalid");
    expect(await me(session)).toMatchObject({ isTemplateAdmin: false, isFormEditor: true });
  });

  it("takes the groups of the verified ID token over those of the user info", async () => {
    provider.userInfo = claims({ groups: [] });
    provider.idToken = { claims: { groups: ["/reimbursements/editors"] } };
    const { session } = await signIn(provider);
    expect(await me(session)).toMatchObject({ isFormEditor: true, isTemplateAdmin: false });
  });

  it.each([
    ["an unverified email", { email_verified: false }],
    ["a string that is not true", { email_verified: "yes" }],
    ["no email", { email: "" }],
    ["no role group", { groups: ["/other/group"] }],
    ["groups that are no list", { groups: "/reimbursements/admins" }],
  ])("lets nobody in with %s", async (_case, extra) => {
    provider.userInfo = claims(extra);
    const { location, session } = await signIn(provider);
    expect(location).toBe(NO_ACCESS);
    expect(session).toBeFalsy();
    expect(await getDb().select().from(users)).toEqual([]);
  });

  it("accepts email_verified as the string true", async () => {
    provider.userInfo = claims({ email_verified: "True" });
    expect((await signIn(provider)).session).toBeTruthy();
  });

  it("lets nobody in whose user was turned off", async () => {
    await createUser("subject-1", [TEMPLATE_ADMIN], { isActive: false });
    const { location, session } = await signIn(provider);
    expect(location).toBe(NO_ACCESS);
    expect(session).toBeFalsy();
  });

  it("refuses ID tokens with any audience but this client, another issuer, or expired", async () => {
    const accepted = async (extra: Record<string, unknown>) => {
      provider.idToken = { claims: extra };
      return Boolean((await signIn(provider)).session);
    };
    const now = Math.floor(Date.now() / 1000);
    expect(await accepted({})).toBe(true);
    expect(await accepted({ azp: CLIENT_ID })).toBe(true);
    // Unlike plain OpenID Connect, the Django version wanted every audience to be this client.
    expect(await accepted({ aud: ["other", CLIENT_ID], azp: CLIENT_ID })).toBe(false);
    expect(await accepted({ aud: "other" })).toBe(false);
    expect(await accepted({ azp: "other" })).toBe(false);
    expect(await accepted({ iss: "https://evil.example.invalid" })).toBe(false);
    // Expiry has no leeway; issue and not-before times may be a minute ahead.
    expect(await accepted({ exp: now - 5 })).toBe(false);
    expect(await accepted({ exp: now + 300, iat: now + 30, nbf: now + 30 })).toBe(true);
    expect(await accepted({ iat: now + 3600, exp: now + 7200 })).toBe(false);
    expect(await accepted({ nbf: now + 3600 })).toBe(false);
    expect(await accepted({ exp: "tomorrow" })).toBe(false);
  });

  it("checks the signature of the ID token", async () => {
    provider.idToken = { key: rsaKey() };
    expect((await signIn(provider)).session).toBeFalsy();
  });

  it("takes user info only about the subject of the ID token", async () => {
    provider.userInfo = claims({ sub: "someone-else" });
    expect((await signIn(provider)).session).toBeFalsy();
    expect(await getDb().select().from(users)).toEqual([]);
  });

  it("ends admin sessions 8 hours after sign-in, however they are used", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-11-23T08:00:00Z");
    vi.setSystemTime(start);
    const { session } = await signIn(provider);
    const [row] = await getDb().select().from(sessions);
    expect(row!.expiresAt.getTime()).toBe(start.getTime() + config().ADMIN_SESSION_SECONDS * 1000);
    vi.setSystemTime(new Date(start.getTime() + 7 * 3600 * 1000));
    expect(await me(session)).not.toBeNull();
    // Using it does not move the deadline.
    const [again] = await getDb().select().from(sessions);
    expect(again!.expiresAt).toEqual(row!.expiresAt);
    vi.setSystemTime(new Date(start.getTime() + config().ADMIN_SESSION_SECONDS * 1000 + 1000));
    expect(await me(session)).toBeNull();
    const fresh = await signIn(provider);
    expect(await me(fresh.session)).not.toBeNull();
  });

  it("answers an error callback without a matching state with 400, and keeps the session", async () => {
    const { session } = await signIn(provider);
    const pending = await testApp().request("/oidc/authenticate/", { headers: sessionCookie(session!) });
    const stateCookie = setCookie(pending, "reimbursements_oidc")!;
    const response = await testApp().request("/oidc/callback/?error=access_denied&state=other-state", {
      headers: { cookie: `reimbursements_session=${session}; reimbursements_oidc=${stateCookie}` },
    });
    expect(response.status).toBe(400);
    expect(await me(session)).not.toBeNull();
  });

  it("ends the session on an error callback with the browser's state", async () => {
    const { session } = await signIn(provider);
    const pending = await testApp().request("/oidc/authenticate/", { headers: sessionCookie(session!) });
    const stateCookie = setCookie(pending, "reimbursements_oidc")!;
    const state = new URL(pending.headers.get("location")!).searchParams.get("state")!;
    const response = await testApp().request(`/oidc/callback/?error=access_denied&state=${state}`, {
      headers: { cookie: `reimbursements_session=${session}; reimbursements_oidc=${stateCookie}` },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(NO_ACCESS);
    expect(await me(session)).toBeNull();
  });

  it("answers a callback for a sign-in this browser never started with 400", async () => {
    const response = await testApp().request("/oidc/callback/?code=x&state=unknown");
    expect(response.status).toBe(400);
  });

  it("goes back only to a path of this app after sign-in", async () => {
    expect((await signIn(provider, { next: "/admin/forms/1" })).location).toBe("/admin/forms/1");
    expect((await signIn(provider, { next: "//evil.example.invalid/x" })).location).toBe("/admin/");
    expect((await signIn(provider, { next: "https://evil.example.invalid/" })).location).toBe("/admin/");
  });

  it("ends the provider's session at sign-out, back to the start page", async () => {
    const url = await providerLogoutUrl("id-token");
    expect(url.startsWith(`${DISCOVERY.end_session_endpoint}?`)).toBe(true);
    const query = new URL(url).searchParams;
    expect(query.get("id_token_hint")).toBe("id-token");
    expect(query.get("client_id")).toBe(CLIENT_ID);
    expect(query.get("post_logout_redirect_uri")).toBe(`${config().APP_URL}/`);
  });

  it("signs out of the app and the provider with the session's ID token", async () => {
    const { session } = await signIn(provider);
    const response = await request("POST", "/api/v1/auth/logout", { headers: sessionCookie(session!) });
    expect(response.status).toBe(200);
    const redirect = new URL(response.body.redirect);
    expect(redirect.searchParams.get("id_token_hint")!.split(".")).toHaveLength(3);
    expect(await me(session)).toBeNull();
  });

  it("signs out people who were turned off or lost every role", async () => {
    const { session } = await signIn(provider);
    const [user] = await getDb().select().from(users);
    await getDb().update(users).set({ isActive: false }).where(eq(users.id, user!.id));
    expect(await me(session)).toBeNull();
    await getDb().update(users).set({ isActive: true }).where(eq(users.id, user!.id));
    expect(await me(session)).not.toBeNull();
    const { assign } = await import("./roles");
    await assign(user!, []);
    expect(await me(session)).toBeNull();
  });

  it("has no development sign-in unless it is switched on", async () => {
    await createUser("root", [], { isSuperuser: true });
    expect((await request("POST", "/api/v1/auth/dev-login", { body: { username: "root" } })).status).toBe(
      404,
    );
    overrideConfigForTests({ DEV_LOGIN: true });
    const response = await request("POST", "/api/v1/auth/dev-login", { body: { username: "root" } });
    expect(response.status).toBe(200);
    const token = setCookie(response.raw, "reimbursements_session");
    expect(await me(token)).toMatchObject({ isTemplateAdmin: true });
  });
});
