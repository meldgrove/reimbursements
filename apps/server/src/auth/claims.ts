import { eq } from "drizzle-orm";
import { config } from "../config";
import { users, type User } from "../db/schema";
import { atomic, isUniqueViolation, q } from "../db/tx";
import { logger } from "../logger";
import { assign, FORM_EDITOR, TEMPLATE_ADMIN, type RoleName } from "./roles";

/**
 * Who signs in to the admin area (portal/auth.py of the Django version). The
 * provider proves who someone is and, with its groups, what they may do:
 * KEYCLOAK_ADMIN_GROUP makes a template admin, KEYCLOAK_EDITOR_GROUP a form
 * editor. Roles come only from the verified groups of every sign-in. People
 * are keyed by the provider's subject (Django's `username`), and their name
 * and email follow the provider.
 */

export type Claims = Record<string, unknown>;

/** The sign-in cannot go on: the person is not let in. The message stays in the log. */
export class SignInRefused extends Error {
  constructor(readonly reason: "unverified_email" | "no_portal_group" | "inactive_user") {
    super(reason);
    this.name = "SignInRefused";
  }
}

export function emailVerified(claims: Claims): boolean {
  const value = claims.email_verified;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  return value === true;
}

/** The roles the claimed groups grant. */
export function grantedRoles(claims: Claims): Set<RoleName> {
  const raw = claims[config().OIDC_GROUPS_CLAIM];
  const claimed = new Set(
    Array.isArray(raw) ? raw.filter((group): group is string => typeof group === "string") : [],
  );
  const granted = new Set<RoleName>();
  if (claimed.has(config().KEYCLOAK_ADMIN_GROUP)) granted.add(TEMPLATE_ADMIN);
  if (claimed.has(config().KEYCLOAK_EDITOR_GROUP)) granted.add(FORM_EDITOR);
  return granted;
}

const text = (value: unknown, length: number) => (typeof value === "string" ? value : "").slice(0, length);

/**
 * The user for a verified sign-in, created on the first one, with name,
 * email and roles from the claims. Refused without a verified email address
 * or without a role group, and for a user who was turned off.
 */
export async function userForClaims(claims: Claims): Promise<User> {
  if (!emailVerified(claims) || !claims.email) {
    logger.warn({ code: "unverified_email" }, "admin_login_denied");
    throw new SignInRefused("unverified_email");
  }
  const granted = grantedRoles(claims);
  if (granted.size === 0) {
    logger.warn({ code: "no_portal_group" }, "admin_login_denied");
    throw new SignInRefused("no_portal_group");
  }
  const subject = String(claims.sub);
  const values = {
    email: text(claims.email, 254),
    firstName: text(claims.given_name, 150),
    lastName: text(claims.family_name, 150),
  };
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await atomic(async () => {
        let [user] = await q().select().from(users).where(eq(users.username, subject)).for("no key update");
        if (!user) {
          [user] = await q()
            .insert(users)
            .values({ username: subject, ...values })
            .returning();
        } else {
          if (!user.isActive) throw new SignInRefused("inactive_user");
          [user] = await q().update(users).set(values).where(eq(users.id, user.id)).returning();
        }
        await assign(user!, granted);
        const [updated] = await q().select().from(users).where(eq(users.id, user!.id));
        return updated!;
      });
    } catch (error) {
      // Two first sign-ins of one person at once: the second finds the first's user.
      if (attempt === 0 && isUniqueViolation(error)) continue;
      throw error;
    }
  }
}
