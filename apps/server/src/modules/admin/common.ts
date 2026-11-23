import type { Context } from "hono";
import type { User } from "../../db/schema";
import { config } from "../../config";
import type { AppEnv } from "../../http/env";
import { badRequest } from "../../http/errors";
import { BodyTooLarge, isBodyTooLarge } from "../../http/middleware";

/** Who an audited action is logged for: the person's email, or their username. */
export function actor(user: Pick<User, "email" | "username">): string {
  return user.email || user.username;
}

/** Rows a list shows on one page (Django's change list). */
export const PAGE_SIZE = 100;

/** The page a list asks for (`page`, from 1), and the slice it covers. */
export function pageOf(c: Context<AppEnv>): { page: number; offset: number } {
  const raw = c.req.query("page") ?? "1";
  const page = /^[1-9][0-9]{0,5}$/.test(raw) ? Number(raw) : 1;
  return { page, offset: (page - 1) * PAGE_SIZE };
}

export function pagesOf(count: number): number {
  return Math.max(1, Math.ceil(count / PAGE_SIZE));
}

/** The address of a participant page of this app, e.g. https://reimbursements.example.invalid/f/workshop/. */
export function absolute(path: string): string {
  return new URL(path, config().APP_URL).toString();
}

/** The JSON body of a request, or 400. */
export async function body(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await c.req.json();
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch (error) {
    if (isBodyTooLarge(error)) throw new BodyTooLarge();
    // otherwise answered below
  }
  throw badRequest("The request body must be a JSON object");
}

/** IDs a bulk action sends (`ids`): at most `limit`, each matching `pattern`. */
export function idsOf(value: unknown, pattern: RegExp, limit = 1000): string[] {
  if (!Array.isArray(value)) throw badRequest("Select the records first.");
  const ids = [...new Set(value.map(String))];
  if (ids.length > limit || !ids.every((id) => pattern.test(id))) throw badRequest("Invalid selection.");
  return ids;
}

/** Django's message of a bulk (un)archive action. */
export function archivingMessage(changed: number, noun: string, archived: boolean): string {
  const verb = archived ? "archived" : "unarchived";
  if (changed === 1) return `1 ${noun} was ${verb}.`;
  if (changed) return `${changed} ${noun}s were ${verb}.`;
  return archived
    ? `The selected ${noun}s were already archived.`
    : `None of the selected ${noun}s were archived.`;
}

/** Text search of a list: `%term%` for ILIKE, with the wildcards of the term escaped. */
export function contains(term: string): string {
  return `%${term.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}
