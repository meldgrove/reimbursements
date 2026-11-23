import type { ZodError, z } from "zod";

/**
 * An error with an HTTP status and a stable code. Services throw these; the
 * app's error handler turns them into `{ error: { code, message, fields } }`.
 * Messages are shown to people: keep them short and free of internal details.
 */
export class AppError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 423 | 429 | 500 | 502 | 503,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
    /** More top-level response fields, e.g. the current page of a 409 conflict. */
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message: string) => new AppError(400, "bad_request", message);
export const unauthorized = (message = "Sign in to continue") => new AppError(401, "unauthorized", message);
export const forbidden = (message = "You may not do this") => new AppError(403, "forbidden", message);
export const notFound = (message = "Not found") => new AppError(404, "not_found", message);
export const conflict = (message: string, code = "conflict") => new AppError(409, code, message);

export function validationError(fields: Record<string, string>, message = "Check the highlighted fields") {
  return new AppError(422, "validation_error", message, fields);
}

/** Field errors keyed by dotted path, first message per field. */
export function zodFieldErrors(error: ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    fields[key] ??= issue.message;
  }
  return fields;
}

/** Validates a value with a shared schema; a failure becomes a 422 with field errors. */
export function parseWith<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw validationError(zodFieldErrors(parsed.error));
  return parsed.data;
}
