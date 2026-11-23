import { and, eq, exists, inArray, sql, type SQL } from "drizzle-orm";
import { FORM_EDITOR, ROLES, TEMPLATE_ADMIN, type RoleName } from "@reimbursements/shared/constants";
import { claims, formOwners, forms, groups, userGroups, users, type User } from "../db/schema";
import { q } from "../db/tx";

/**
 * Admin roles and form access (portal/roles.py of the Django version). The
 * provider's groups map to these roles at every sign-in, stored as Django
 * groups so the Django version reads them too.
 *
 * Template admins manage templates, the privacy notice, every form and claim
 * actions. Form editors create forms from templates and see the claims of the
 * forms they own. Every check of who may manage a form or see a claim goes
 * through `managedForms` and `visibleClaims`, so object checks and admin lists
 * cannot disagree.
 */
export { FORM_EDITOR, ROLES, TEMPLATE_ADMIN, type RoleName };

type Person = Pick<User, "id" | "isActive" | "isSuperuser">;

/** The roles of a user: none when turned off; a Django superuser is a template admin. */
export async function roles(user: Person | null | undefined): Promise<Set<RoleName>> {
  if (!user || !user.isActive) return new Set();
  const rows = await q()
    .select({ name: groups.name })
    .from(userGroups)
    .innerJoin(groups, eq(groups.id, userGroups.groupId))
    .where(and(eq(userGroups.userId, user.id), inArray(groups.name, [...ROLES])));
  const found = new Set(rows.map((row) => row.name as RoleName));
  if (user.isSuperuser) found.add(TEMPLATE_ADMIN);
  return found;
}

export async function isTemplateAdmin(user: Person | null | undefined): Promise<boolean> {
  return (await roles(user)).has(TEMPLATE_ADMIN);
}

/** Form editing is part of both roles. */
export async function isFormEditor(user: Person | null | undefined): Promise<boolean> {
  return (await roles(user)).size > 0;
}

/** Whether `user` owns the form given as an SQL column (the form's id). */
function ownsForm(user: Pick<User, "id">, formId: SQL | typeof forms.id | typeof claims.formId) {
  return exists(
    q()
      .select({ one: sql`1` })
      .from(formOwners)
      .where(and(eq(formOwners.formId, formId), eq(formOwners.userId, user.id))),
  );
}

/**
 * The condition on `portal_form` for the forms this person manages: all for
 * template admins, their own for form editors, none for anyone else. Combine
 * it with other conditions in a query of `forms`.
 */
export async function managedForms(user: Person | null | undefined): Promise<SQL> {
  const granted = await roles(user);
  if (granted.has(TEMPLATE_ADMIN)) return sql`true`;
  if (granted.size > 0) return ownsForm(user!, forms.id);
  return sql`false`;
}

/** The condition on `portal_claim` for the claims this person sees: those of the forms they manage. */
export async function visibleClaims(user: Person | null | undefined): Promise<SQL> {
  const granted = await roles(user);
  if (granted.has(TEMPLATE_ADMIN)) return sql`true`;
  if (granted.size > 0) return ownsForm(user!, claims.formId);
  return sql`false`;
}

export async function manages(user: Person | null | undefined, form: { id: number }): Promise<boolean> {
  const [row] = await q()
    .select({ id: forms.id })
    .from(forms)
    .where(and(eq(forms.id, form.id), await managedForms(user)));
  return Boolean(row);
}

export async function sees(user: Person | null | undefined, claim: { id: string }): Promise<boolean> {
  const [row] = await q()
    .select({ id: claims.id })
    .from(claims)
    .where(and(eq(claims.id, claim.id), await visibleClaims(user)));
  return Boolean(row);
}

/** The id of a role's group, created when missing (as Django's get_or_create). */
async function groupId(name: RoleName): Promise<number> {
  await q().insert(groups).values({ name }).onConflictDoNothing({ target: groups.name });
  const [row] = await q().select({ id: groups.id }).from(groups).where(eq(groups.name, name));
  return row!.id;
}

/** Replaces the user's roles; staff access (`is_staff`) follows from having any role. */
export async function assign(user: Pick<User, "id">, granted: Iterable<RoleName>): Promise<void> {
  const wanted = new Set(granted);
  const ids = new Map<RoleName, number>();
  for (const name of ROLES) ids.set(name, await groupId(name));
  await q()
    .delete(userGroups)
    .where(and(eq(userGroups.userId, user.id), inArray(userGroups.groupId, [...ids.values()])));
  const rows = [...wanted].map((name) => ({ userId: user.id, groupId: ids.get(name)! }));
  if (rows.length > 0) await q().insert(userGroups).values(rows).onConflictDoNothing();
  await q()
    .update(users)
    .set({ isStaff: wanted.size > 0 })
    .where(eq(users.id, user.id));
}

/** Users who may own forms (the owner choices of the form editor): active people with a role. */
export async function roleHolders(): Promise<User[]> {
  return q()
    .selectDistinct({ user: users })
    .from(users)
    .leftJoin(userGroups, eq(userGroups.userId, users.id))
    .leftJoin(groups, eq(groups.id, userGroups.groupId))
    .where(
      and(
        eq(users.isActive, true),
        sql`(${groups.name} in (${sql.join(
          ROLES.map((role) => sql`${role}`),
          sql`, `,
        )}) or ${users.isSuperuser})`,
      ),
    )
    .then((rows) => rows.map((row) => row.user));
}
