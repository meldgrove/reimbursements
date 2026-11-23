import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { config } from "../config";
import { sessions, users, type SessionData, type User } from "../db/schema";
import { getDb } from "../db/client";

/**
 * Browser sessions of this version (the Django version's sessions end at the
 * upgrade, src/db/django.ts). Two kinds, each with its own cookie:
 *
 * - admin: someone who signed in through the provider. It ends
 *   ADMIN_SESSION_SECONDS (8 hours) after sign-in, however it is used: an
 *   inactivity timeout would let ordinary use prolong admin access. It
 *   counts only while its user is active.
 * - participant: binds drafts to a browser (src/participants.ts). It lasts
 *   PARTICIPANT_SESSION_SECONDS (7 days) and exists only once a draft was
 *   admitted.
 *
 * The cookie holds a random token; the database keeps its SHA-256.
 */

/**
 * The cookie's name. On HTTPS with the `__Host-` prefix: the browser then
 * takes it only from this host itself, never from a sibling subdomain.
 */
export function cookieName(name: string): string {
  return secureCookies() ? `__Host-${name}` : name;
}

export function secureCookies(): boolean {
  return config().APP_URL.startsWith("https://");
}

export const adminCookie = () => cookieName("reimbursements_session");
export const participantCookie = () => cookieName("reimbursements_participant");

export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

function readToken(c: Context, name: string): string | null {
  const token = getCookie(c, name);
  return token && token.length <= 200 ? token : null;
}

function writeCookie(c: Context, name: string, token: string, expiresAt: Date) {
  setCookie(c, name, token, {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "Lax",
    path: "/",
    expires: expiresAt,
  });
}

// -- admin sessions -------------------------------------------------------------

/**
 * Starts an admin session for the user and sets its cookie; null when the
 * user was turned off meanwhile. A new sign-in replaces the session the
 * browser had. Sets the user's last_login, as Django did.
 */
export async function startSession(c: Context, user: Pick<User, "id">, idToken = ""): Promise<Date | null> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + config().ADMIN_SESSION_SECONDS * 1000);
  await endSession(c);
  const started = await getDb().transaction(async (tx) => {
    const [active] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, user.id), eq(users.isActive, true)))
      // Not "share": two sign-ins of one user would both hold it, then
      // deadlock on last_login. This one waits for the other.
      .for("no key update");
    if (!active) return false;
    await tx
      .insert(sessions)
      .values({ id: tokenHash(token), kind: "admin", userId: user.id, expiresAt, idToken });
    await tx.update(users).set({ lastLogin: new Date() }).where(eq(users.id, user.id));
    return true;
  });
  if (!started) return null;
  await getDb().delete(sessions).where(lt(sessions.expiresAt, new Date()));
  writeCookie(c, adminCookie(), token, expiresAt);
  return expiresAt;
}

/** The signed-in user of the request and the provider's ID token of the session, or null. */
export async function currentSession(c: Context): Promise<{ user: User; idToken: string } | null> {
  const token = readToken(c, adminCookie());
  if (!token) return null;
  const [row] = await getDb()
    .select({ user: users, idToken: sessions.idToken })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.id, tokenHash(token)),
        eq(sessions.kind, "admin"),
        gt(sessions.expiresAt, new Date()),
        eq(users.isActive, true),
      ),
    );
  return row ?? null;
}

/** Ends the request's admin session; returns the provider's ID token it had. */
export async function endSession(c: Context): Promise<string> {
  const token = readToken(c, adminCookie());
  deleteCookie(c, adminCookie(), { path: "/", secure: secureCookies() });
  if (!token) return "";
  const [row] = await getDb()
    .delete(sessions)
    .where(and(eq(sessions.id, tokenHash(token)), eq(sessions.kind, "admin")))
    .returning({ idToken: sessions.idToken });
  return row?.idToken ?? "";
}

// -- participant sessions -------------------------------------------------------------

/**
 * The participant session of the request: its token and data, or null. The
 * cookie keeps working for its 7 days; the session's row expires with it.
 */
export async function participantSession(c: Context): Promise<{ token: string; data: SessionData } | null> {
  const token = readToken(c, participantCookie());
  if (!token) return null;
  const [row] = await getDb()
    .select({ data: sessions.data })
    .from(sessions)
    .where(
      and(
        eq(sessions.id, tokenHash(token)),
        eq(sessions.kind, "participant"),
        gt(sessions.expiresAt, new Date()),
      ),
    );
  return row ? { token, data: row.data } : null;
}

/** Starts a participant session and sets its cookie. Commits at once (never inside a transaction). */
export async function startParticipantSession(c: Context): Promise<{ token: string; data: SessionData }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + config().PARTICIPANT_SESSION_SECONDS * 1000);
  await getDb()
    .insert(sessions)
    .values({ id: tokenHash(token), kind: "participant", expiresAt, data: {} });
  writeCookie(c, participantCookie(), token, expiresAt);
  return { token, data: {} };
}

/**
 * Saves a participant session's data. Like Django's sessions, a change gives
 * the session (and, with the request, its cookie) its full 7 days again: a
 * draft opened on the session's last day stays reachable for its own 24
 * hours. Admin sessions never move their end (`startSession`).
 */
export async function saveParticipantData(token: string, data: SessionData, c?: Context): Promise<void> {
  const expiresAt = new Date(Date.now() + config().PARTICIPANT_SESSION_SECONDS * 1000);
  const updated = await getDb()
    .update(sessions)
    .set({ data, expiresAt })
    .where(and(eq(sessions.id, tokenHash(token)), eq(sessions.kind, "participant")))
    .returning({ id: sessions.id });
  if (c && updated.length > 0) writeCookie(c, participantCookie(), token, expiresAt);
}

/** Removes expired sessions of both kinds (the worker's cleanup). */
export async function deleteExpiredSessions(): Promise<number> {
  const removed = await getDb()
    .delete(sessions)
    .where(lt(sessions.expiresAt, sql`now()`))
    .returning({ id: sessions.id });
  return removed.length;
}

// -- signed values (the sign-in's state cookie) ------------------------------------

function signature(value: string): string {
  return createHmac("sha256", `reimbursements-signed:${config().AUTH_SECRET}`)
    .update(value)
    .digest("base64url");
}

export function sign(data: unknown): string {
  const value = Buffer.from(JSON.stringify(data)).toString("base64url");
  return `${value}.${signature(value)}`;
}

export function unsign<T>(signed: string | undefined): T | null {
  if (!signed) return null;
  const dot = signed.lastIndexOf(".");
  if (dot <= 0) return null;
  const value = signed.slice(0, dot);
  const given = Buffer.from(signed.slice(dot + 1));
  const expected = Buffer.from(signature(value));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

/** A keyed digest for values that must not be stored as they are (draft bindings, network keys). */
export function saltedHmac(salt: string, value: string): string {
  return createHmac("sha256", `${salt}:${config().AUTH_SECRET}`).update(value).digest("hex");
}

/**
 * Django's `salted_hmac(salt, value).hexdigest()` with the same secret
 * (DJANGO_SECRET_KEY, or AUTH_SECRET in its place): HMAC-SHA1 keyed with
 * SHA1(salt + secret). For keys the Django version stored and this version
 * must find again, such as the network budgets (`portal_draftadmission`).
 */
export function djangoSaltedHmac(salt: string, value: string): string {
  const key = createHash("sha1").update(`${salt}${config().AUTH_SECRET}`).digest();
  return createHmac("sha1", key).update(value).digest("hex");
}
