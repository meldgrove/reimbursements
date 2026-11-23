import type { ClientConfig, FieldErrors, UploadStatus } from "@reimbursements/shared/api/public";

/**
 * The form page's requests (form.js of the Django version): with the draft
 * token, a 15 second deadline, and errors that say whether trying again can help.
 */

/** Text of the form page in the app language; `{name}` placeholders take the given values. */
export function say(
  config: Pick<ClientConfig, "text">,
  key: string,
  values: Record<string, string | number> = {},
) {
  return (config.text[key] || key).replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}

/** A failed request: its message for the participant, field errors, status and whether to retry. */
export class FormRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly fields?: FieldErrors,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "FormRequestError";
  }
}

type Context = { config: Pick<ClientConfig, "text">; token: string };

/** A JSON request of the form page. */
export async function formRequest<T>(
  context: Context,
  url: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 15_000);
  let response: Response | undefined;
  let result: { error?: { message?: string; fields?: FieldErrors } } & Record<string, unknown>;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      credentials: "same-origin",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "x-draft-token": context.token,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    result = await response.json();
  } catch {
    if (response && !response.ok) {
      result = {
        error: {
          message: [404, 410].includes(response.status)
            ? say(context.config, "session_gone")
            : say(context.config, "request_failed"),
        },
      };
    } else {
      throw new FormRequestError(say(context.config, "connection_lost"), undefined, undefined, true);
    }
  } finally {
    clearTimeout(deadline);
  }
  if (!response.ok) {
    throw new FormRequestError(
      result.error?.message || say(context.config, "request_error"),
      response.status,
      result.error?.fields,
      response.status === 408 || response.status === 429 || response.status >= 500,
    );
  }
  return result as T;
}

/** A file of an expense or the signature, as the page shows it. */
export type FileState = {
  id?: string;
  name: string;
  size: number;
  /** uploading, pending, ready or failed. */
  state: string;
  message?: string;
  pages?: number;
  polling?: boolean;
};

export type UploadUpdate = Partial<FileState> & { state?: string };

const uploadsUrl = (slug: string) => `/api/v1/public/forms/${encodeURIComponent(slug)}/uploads`;
export const uploadUrl = (slug: string, id: string) => `${uploadsUrl(slug)}/${encodeURIComponent(id)}`;

/** Waits for the check of an upload, with growing pauses; after about five minutes it stays pending. */
export async function pollUpload(
  context: Context & { slug: string },
  result: { id: string; name?: string; size?: number },
  onUpdate?: (update: UploadUpdate) => void,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<FileState> {
  onUpdate?.({ ...result, state: "pending", message: say(context.config, "file_pending") });
  for (let attempt = 0; attempt < 36; attempt += 1) {
    let status: Partial<UploadStatus> & { state: string; message: string };
    try {
      status = await formRequest<UploadStatus>(context, uploadUrl(context.slug, result.id));
    } catch (error) {
      if (!(error instanceof FormRequestError) || !error.retryable) throw error;
      status = { state: "pending", message: say(context.config, "connection_slow") };
    }
    onUpdate?.(status);
    if (status.state === "ready") return { ...result, ...status } as FileState;
    if (status.state === "failed") throw new FormRequestError(status.message);
    const delay = Math.min(10_000, 2000 * 1.4 ** attempt);
    await sleep(delay + Math.random() * delay * 0.2);
  }
  const delayed = { ...result, state: "pending", message: say(context.config, "check_slow") } as FileState;
  onUpdate?.(delayed);
  return delayed;
}

/** Uploads a receipt or the signature with progress, then waits for its check. */
export async function uploadFile(
  context: Context & { slug: string; draftId: string; preview: boolean },
  blob: Blob & { name?: string },
  kind: "receipt" | "signature",
  expenseId: string | null,
  onUpdate?: (update: UploadUpdate) => void,
): Promise<FileState> {
  if (context.preview) throw new FormRequestError(say(context.config, "preview_upload"));
  const data = new FormData();
  data.append("draft_id", context.draftId);
  data.append("token", context.token);
  data.append("kind", kind);
  data.append("expense_id", expenseId ?? "");
  data.append("file", blob, blob.name || "signature.png");
  const result = await new Promise<{ id: string; name: string; size: number }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", uploadsUrl(context.slug));
    xhr.setRequestHeader("accept", "application/json");
    xhr.timeout = 120_000;
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable)
        onUpdate?.({
          state: "uploading",
          message: say(context.config, "upload_progress", {
            percent: Math.round((event.loaded / event.total) * 100),
          }),
        });
    });
    xhr.onload = () => {
      let value: { id: string; name: string; size: number; error?: { message?: string } };
      try {
        value = JSON.parse(xhr.responseText);
      } catch {
        reject(new FormRequestError(say(context.config, "upload_failed_retry")));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(value);
      else
        reject(
          new FormRequestError(value.error?.message || say(context.config, "upload_failed"), xhr.status),
        );
    };
    xhr.onerror = xhr.ontimeout = () =>
      reject(new FormRequestError(say(context.config, "upload_interrupted")));
    xhr.send(data);
  });
  return pollUpload(context, result, onUpdate);
}

/** Removes an upload; one that is gone already counts as removed. */
export async function deleteUpload(context: Context & { slug: string }, id: string | undefined) {
  if (!id) return;
  try {
    await formRequest(context, uploadUrl(context.slug, id), { method: "DELETE" });
  } catch (error) {
    if (!(error instanceof FormRequestError) || error.status !== 404) throw error;
  }
}

/** An exact EUR amount in cents, or null when the server would refuse it. */
export function cents(pattern: RegExp, value: string): bigint | null {
  const trimmed = value.trim();
  if (!pattern.test(trimmed)) return null;
  const [whole = "0", fraction = ""] = trimmed.replace(",", ".").split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0") || "0");
}

/** An amount in cents as euros, with the separators of the app number format. */
export function money(
  config: Pick<ClientConfig, "locale" | "decimal_separator" | "thousands_separator">,
  amount: bigint,
) {
  const separators: Record<string, string> = {
    decimal: config.decimal_separator,
    group: config.thousands_separator,
  };
  return new Intl.NumberFormat(config.locale, { style: "currency", currency: "EUR" })
    .formatToParts(Number(amount) / 100)
    .map((part) => separators[part.type] ?? part.value)
    .join("");
}

/** An ISO date (YYYY-MM-DD) in the app date format (a pattern such as DD.MM.YYYY). */
export function formatDate(pattern: string, value: string): string {
  const [year = "", month = "", day = ""] = value.split("-");
  return pattern.replace("YYYY", year).replace("MM", month).replace("DD", day);
}
