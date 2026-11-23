import type { ErrorBody } from "@reimbursements/shared/api/common";

/** An error response of the API, with its status, code and field messages. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Messages by field path, e.g. `{ "config.url": "Enter a URL" }`. */
    readonly fields?: Record<string, string>,
    /** The whole response body, for routes that answer errors with more (e.g. a 409 with the current state). */
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Query = Record<string, string | number | boolean | null | undefined | string[]>;

/** Builds `/api/v1<path>?<query>`, skipping empty values and repeating array values. */
export function apiUrl(path: string, query?: Query): string {
  const url = new URL(`/api/v1${path}`, window.location.origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item);
    else url.searchParams.set(key, String(value));
  }
  return url.pathname + url.search;
}

let onUnauthorized: (() => void) | undefined;

/** Called when the session has ended (401), e.g. to show the sign-in page. */
export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler;
}

/** A request outside `api` got a 401: the session ended. */
export function sessionEnded() {
  onUnauthorized?.();
}

/** Reads an answer of the API: its JSON (null when unreadable), or an ApiError for an error status. */
export async function parseResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const body = data as Partial<ErrorBody> | null;
    if (response.status === 401) sessionEnded();
    throw new ApiError(
      response.status,
      body?.error?.code ?? "internal_error",
      body?.error?.message ?? `Request failed (${response.status})`,
      body?.error?.fields,
      data,
    );
  }
  return data as T;
}

async function request<T>(
  method: string,
  path: string,
  options: { query?: Query; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch(apiUrl(path, options.query), {
    method,
    credentials: "same-origin",
    headers:
      options.body === undefined
        ? { accept: "application/json" }
        : { accept: "application/json", "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });
  return parseResponse<T>(response);
}

/** Uploads one file as multipart form data (field `file`). */
async function upload<T>(path: string, file: File, signal?: AbortSignal): Promise<T> {
  const body = new FormData();
  body.append("file", file);
  const response = await fetch(apiUrl(path), {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "application/json" },
    body,
    signal,
  });
  return parseResponse<T>(response);
}

/** Typed calls to the REST API. Types come from @reimbursements/shared/api/*. */
export const api = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal) => request<T>("GET", path, { query, signal }),
  post: <T>(path: string, body?: unknown, query?: Query) =>
    request<T>("POST", path, { body: body ?? {}, query }),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, { body: body ?? {} }),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, { body: body ?? {} }),
  delete: <T = void>(path: string, query?: Query) => request<T>("DELETE", path, { query }),
  upload: <T>(path: string, file: File, signal?: AbortSignal) => upload<T>(path, file, signal),
};

/** A user-facing message for any error. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong";
}
