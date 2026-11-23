import { useCallback, useEffect, useRef, useState } from "react";
import type {
  FormEditor,
  FormSaved,
  FormSettings,
  FormState,
  PublicationAction,
} from "@reimbursements/shared/api/admin";
import { ApiError, apiUrl, parseResponse } from "@/lib/api";

/**
 * The form editor saves as one types (portal/static/portal/admin-form.js of
 * the Django version): changes save in order, 600 ms after the last one;
 * publication and archiving use the same queue. The first save of a new form
 * sends a creation key, so a retried save never makes a second form. A save
 * that failed keeps the changes and offers to try again; the browser warns
 * before leaving while something is unsaved (the editor page asks before
 * in-app navigation too). The start page is sent only when the person changed
 * it, so a save of other settings keeps a handover made meanwhile.
 */

export type SaveState = "idle" | "pending" | "saving" | "saved" | "error";
type Action = Exclude<PublicationAction, "">;

/** Each publication action: the status it leads to, and what the indicator says. */
export const ACTIONS: Record<Action, { status: string; progress: string; error: string }> = {
  publish: { status: "published", progress: "Publishing …", error: "Publishing failed." },
  unpublish: { status: "draft", progress: "Unpublishing …", error: "Unpublishing failed." },
  archive: { status: "archived", progress: "Archiving …", error: "Archiving failed." },
  unarchive: { status: "draft", progress: "Unarchiving …", error: "Unarchiving failed." },
};

export const DEBOUNCE_MS = 600;
const TIMEOUT_MS = 20_000;

/** Django's URLify for a new form's link: ASCII letters, digits and hyphens. */
export function slugify(value: string, maxLength = 50): string {
  return value
    .replaceAll("ß", "ss")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{ASCII}]/gu, "")
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[-\s]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/, "");
}

async function send(
  target: { id: number } | { template: number },
  body: Record<string, unknown>,
): Promise<FormSaved> {
  const url =
    "id" in target
      ? apiUrl(`/admin/forms/${target.id}`)
      : apiUrl("/admin/forms", { template: target.template });
  const response = await fetch(url, {
    method: "id" in target ? "PUT" : "POST",
    credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return parseResponse<FormSaved>(response);
}

/** Why a save failed, for the summary above the form. */
function failure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Your session may have expired. Please reload the page.";
    if (error.status === 404) return "The form is no longer available. Please reload the page.";
    return error.message;
  }
  const name = (error as { name?: string } | null)?.name;
  if (name === "TypeError" || name === "TimeoutError" || name === "AbortError")
    return "No connection. Please check your internet connection and try again.";
  return error instanceof Error ? error.message : "Changes were not saved.";
}

export function useFormAutosave(editor: FormEditor, options: { onCreated?: (form: FormState) => void } = {}) {
  const [settings, setSettingsState] = useState<FormSettings>(editor.settings);
  const [form, setForm] = useState<FormState | null>(editor.form);
  const [state, setState] = useState<SaveState>(editor.form ? "saved" : "idle");
  const [message, setMessage] = useState(
    editor.form ? "All changes saved." : "Changes are saved automatically.",
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState("");
  const [retryVisible, setRetryVisible] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const settingsRef = useRef(settings);
  const formRef = useRef(form);
  const creationKey = useRef(crypto.randomUUID());
  const revision = useRef(0);
  const dirty = useRef(false);
  const saving = useRef(false);
  const publication = useRef<Action | null>(null);
  const failedPublication = useRef<Action | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** The start page changed since the last save that sent it. */
  const primaryTouched = useRef(false);
  /** False once the editor is gone: a save that ends later changes nothing on the page. */
  const mounted = useRef(true);
  /** True once the person confirmed leaving without saving, also while the next page loads. */
  const left = useRef(false);
  const onCreated = useRef(options.onCreated);
  onCreated.current = options.onCreated;

  const show = useCallback((next: SaveState, text: string) => {
    setState(next);
    setMessage(text);
  }, []);

  const save = useCallback(async () => {
    clearTimeout(timer.current);
    // Once the person left the editor (also by "Leave without saving"), nothing queued is sent.
    if (!mounted.current || left.current) return;
    if (saving.current || (!dirty.current && !publication.current)) return;
    const action = publication.current;
    publication.current = null;
    let sent = settingsRef.current;
    if (!formRef.current && !sent.slug) {
      // Freeze the generated link before sending, also when the first answer is lost.
      sent = { ...sent, slug: slugify(sent.name) || `form-${creationKey.current.slice(0, 12)}` };
      settingsRef.current = sent;
      setSettingsState(sent);
    }
    const startedAt = revision.current;
    const sendsPrimary = !formRef.current || primaryTouched.current;
    primaryTouched.current = false;
    saving.current = true;
    setRetryVisible(false);
    show("saving", action ? ACTIONS[action].progress : "Saving …");
    const target = formRef.current ? { id: formRef.current.id } : { template: editor.template.id };
    try {
      let result: FormSaved;
      try {
        const { primary, ...others } = sent;
        result = await send(target, {
          ...others,
          ...(sendsPrimary ? { primary } : {}),
          action: action ?? "",
          ...(formRef.current ? {} : { creationKey: creationKey.current }),
        });
      } catch (error) {
        // A start page that did not arrive goes with the next save.
        if (sendsPrimary && formRef.current) primaryTouched.current = true;
        setErrors(error instanceof ApiError && error.fields ? error.fields : {});
        setSummary(
          error instanceof ApiError && error.status === 422
            ? "Please correct the marked fields."
            : failure(error),
        );
        throw error;
      }
      setErrors({});
      setSummary("");
      const failed = failedPublication.current;
      if (action || (failed && ACTIONS[failed].status === result.status)) failedPublication.current = null;
      const created = !formRef.current;
      formRef.current = result;
      setForm(result);
      // The server may fill in a draft's name and link; changes made meanwhile stay.
      const current = settingsRef.current;
      const next = { ...current };
      if (current.name === sent.name) next.name = result.name;
      if (current.slug === sent.slug) next.slug = result.slug;
      // Archiving gives up the start page, and another form may have taken it:
      // the editor shows what the form has unless the person changed it meanwhile.
      if (!primaryTouched.current) next.primary = result.primary;
      settingsRef.current = next;
      setSettingsState(next);
      dirty.current = revision.current !== startedAt;
      if (failedPublication.current) show("error", ACTIONS[failedPublication.current].error);
      else if (dirty.current) show("pending", "Unsaved changes …");
      else show("saved", "All changes saved.");
      setRetryVisible(Boolean(failedPublication.current));
      if (created && mounted.current) onCreated.current?.(result);
    } catch {
      dirty.current = true;
      if (action) failedPublication.current = action;
      show(
        "error",
        failedPublication.current
          ? ACTIONS[failedPublication.current].error
          : "Saving failed. Your changes are not saved yet.",
      );
      setRetryVisible(true);
    } finally {
      saving.current = false;
      setPublishing(Boolean(publication.current));
      if (mounted.current && !left.current && (publication.current || revision.current !== startedAt))
        timer.current = setTimeout(() => void save(), 0);
    }
  }, [editor.template.id, show]);

  /** Changes settings; they save shortly after the last change. */
  const update = useCallback(
    (changes: Partial<FormSettings>) => {
      left.current = false;
      const next = { ...settingsRef.current, ...changes };
      settingsRef.current = next;
      setSettingsState(next);
      if ("primary" in changes) primaryTouched.current = true;
      revision.current += 1;
      dirty.current = true;
      show(saving.current ? "saving" : "pending", saving.current ? "Saving …" : "Unsaved changes …");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void save(), DEBOUNCE_MS);
    },
    [save, show],
  );

  /** Publishes, unpublishes, archives or unarchives, after the changes before it. */
  const publish = useCallback(
    (action: Action) => {
      failedPublication.current = null;
      publication.current = action;
      setPublishing(true);
      void save();
    },
    [save],
  );

  const retry = useCallback(() => {
    if (failedPublication.current) {
      publication.current = failedPublication.current;
      setPublishing(true);
    }
    void save();
  }, [save]);

  /** Saves at once (Ctrl+S, the form's submit, leaving the tab). */
  const saveNow = useCallback(() => {
    dirty.current = true;
    void save();
  }, [save]);

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") void save();
    };
    const leaving = (event: BeforeUnloadEvent) => {
      if (dirty.current || saving.current || publication.current || failedPublication.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    mounted.current = true;
    document.addEventListener("keydown", keys);
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("beforeunload", leaving);
    return () => {
      document.removeEventListener("keydown", keys);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("beforeunload", leaving);
      clearTimeout(timer.current);
      mounted.current = false;
    };
  }, [save]);

  /** "Leave without saving": nothing queued or following is sent any more. */
  const discard = useCallback(() => {
    left.current = true;
    clearTimeout(timer.current);
    publication.current = null;
  }, []);

  /** Whether leaving now would lose something. */
  const unsaved = useCallback(
    () =>
      dirty.current || saving.current || Boolean(publication.current) || Boolean(failedPublication.current),
    [],
  );

  return {
    settings,
    form,
    state,
    message,
    errors,
    summary,
    retryVisible,
    publishing,
    update,
    publish,
    retry,
    saveNow,
    unsaved,
    discard,
  };
}
