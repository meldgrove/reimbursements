/**
 * The signature's lifecycle, without the page (portal/static/portal/signature.js of
 * the Django version). The page supplies network access and renders a read-only
 * status; the upload handle never escapes this module.
 */

/** An upload as the page tracks it: its ID once the server has it, and its state. */
export type SignatureHandle = {
  id?: string;
  state: string;
  message?: string;
};

export type SignatureStatus = Readonly<{
  /** empty, replacing, pending, ready, failed or obsolete. */
  state: string;
  busy: boolean;
  canRetry: boolean;
  message: string;
}>;

export type SignatureOptions<B> = {
  /** Uploads `blob` and waits for its check; `update` reports progress and the handle. */
  upload: (blob: B, update: (value: Partial<SignatureHandle>) => void) => Promise<SignatureHandle>;
  /** Waits again for the check of an upload whose check took long. */
  poll: (
    handle: SignatureHandle,
    update: (value: Partial<SignatureHandle>) => void,
  ) => Promise<SignatureHandle>;
  /** Removes an upload; an error with status 404 means it is gone already. */
  remove: (id: string) => Promise<unknown>;
  onChange?: (status: SignatureStatus) => void;
  /** Messages in the app language; a missing one shows its key. */
  text?: Record<string, string>;
};

export type Signature<B> = Readonly<{
  status(): SignatureStatus;
  /** The drawing changed: the current upload no longer shows it. */
  invalidate(): void;
  clear(): Promise<void>;
  replace(blob: B | null | undefined): Promise<void>;
  retry(): Promise<void>;
  /** The ID of a checked upload of the current signature, uploading the drawing if needed. */
  ensureReady(getDrawing: () => B | null | undefined | Promise<B | null | undefined>): Promise<string>;
}>;

export function createSignature<B>({
  upload,
  poll,
  remove,
  onChange = () => {},
  text = {},
}: SignatureOptions<B>): Signature<B> {
  let current: SignatureHandle | null = null;
  let busy = false;
  let generation = 0;
  const say = (key: string) => text[key] || key;
  const changed = () => new Error(say("signature_changed"));

  function status(): SignatureStatus {
    return Object.freeze({
      state: current?.state || "empty",
      busy,
      canRetry: !busy && current?.state === "pending",
      message: current?.message || "",
    });
  }
  function notify() {
    onChange(status());
  }
  async function run<T>(action: () => Promise<T>): Promise<T> {
    if (busy) throw new Error(say("signature_busy"));
    busy = true;
    notify();
    try {
      return await action();
    } finally {
      busy = false;
      notify();
    }
  }
  async function discard() {
    if (current?.id) {
      try {
        await remove(current.id);
      } catch (error) {
        if ((error as { status?: number }).status !== 404) throw error;
      }
    }
    current = null;
  }
  async function receive(
    action: (update: (value: Partial<SignatureHandle>) => void) => Promise<SignatureHandle>,
  ) {
    const version = generation;
    function update(value: Partial<SignatureHandle>) {
      if (value.id || current) {
        current = { ...current, ...value } as SignatureHandle;
        if (version !== generation) current.state = "obsolete";
        notify();
      }
    }
    try {
      const result = await action(update);
      update(result);
      if (version !== generation) throw changed();
      return current;
    } catch (error) {
      if (current && version === generation) {
        current.state = "failed";
        current.message = (error as Error).message;
        notify();
      }
      throw error;
    }
  }
  async function resume() {
    if (current?.state !== "pending" || !current.id) return;
    const handle = { ...current };
    await receive((update) => poll(handle, update));
  }

  return Object.freeze({
    status,
    invalidate() {
      generation += 1;
      if (current) current.state = "obsolete";
      notify();
    },
    clear() {
      return run(async () => {
        generation += 1;
        await discard();
      });
    },
    replace(blob: B | null | undefined) {
      return run(async () => {
        const version = ++generation;
        await discard();
        if (version !== generation) throw changed();
        if (!blob) throw new Error(say("signature_missing"));
        current = { state: "replacing" };
        notify();
        await receive((update) => upload(blob, update));
      });
    },
    retry() {
      return run(resume);
    },
    ensureReady(getDrawing: () => B | null | undefined | Promise<B | null | undefined>) {
      return run(async () => {
        if (current?.state === "pending") await resume();
        else if (current?.state !== "ready") {
          const version = ++generation;
          await discard();
          if (version !== generation) throw changed();
          const blob = await getDrawing();
          if (version !== generation) throw changed();
          if (!blob) throw new Error(say("signature_missing"));
          await receive((update) => upload(blob, update));
        }
        const now = current as SignatureHandle | null;
        if (now?.state !== "ready") throw new Error(now?.message || say("signature_wait"));
        return now.id!;
      });
    },
  });
}
