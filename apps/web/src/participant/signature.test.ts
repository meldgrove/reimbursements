/** The signature's lifecycle (tests/js/signature.test.cjs of the Django version). */
import { describe, expect, it } from "vitest";
import { createSignature, type SignatureHandle, type SignatureStatus } from "./signature";

// The page passes these messages in the app language.
const text = {
  signature_changed: "The signature changed. Please try again.",
  signature_busy: "The signature is still being processed.",
  signature_missing: "Please draw or upload a signature.",
  signature_wait: "Please wait until the signature has been checked.",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup() {
  const handles = new Set<string>();
  const events: string[] = [];
  const statuses: SignatureStatus[] = [];
  let count = 0;
  let mode = "ready";
  let deletionError: (Error & { status?: number }) | undefined;
  let pollReply: { promise: Promise<SignatureHandle> } | undefined;
  const signature = createSignature<string>({
    async upload(_blob, update) {
      count += 1;
      const handle = { id: String(count), state: "pending" };
      handles.add(handle.id);
      events.push(`upload:${handle.id}`);
      update(handle);
      if (mode === "failed") throw new Error("validation failed");
      return { ...handle, state: mode };
    },
    async poll(handle, update) {
      events.push(`poll:${handle.id}`);
      const result = pollReply ? await pollReply.promise : { ...handle, state: mode };
      update(result);
      return result;
    },
    async remove(id) {
      events.push(`delete/${id}`);
      if (deletionError) throw deletionError;
      handles.delete(id);
    },
    onChange(status) {
      statuses.push(status);
    },
    text,
  });
  return {
    signature,
    handles,
    events,
    statuses,
    mode: (value: string) => (mode = value),
    deletionError: (value: (Error & { status?: number }) | undefined) => (deletionError = value),
    pollReply: (value: { promise: Promise<SignatureHandle> } | undefined) => (pollReply = value),
  };
}

const fail = (): never => {
  throw new Error("must not be called");
};

describe("signature", () => {
  it("a replacement cleans failed uploads before consuming another slot", async () => {
    const f = setup();
    f.mode("failed");
    for (let i = 0; i < 5; i += 1) {
      await expect(f.signature.replace("image")).rejects.toThrow(/validation failed/);
      expect(f.handles.size).toBe(1);
      expect(f.signature.status().state).toBe("failed");
    }
    f.mode("ready");
    await f.signature.replace("image");
    expect(await f.signature.ensureReady(fail)).toBe("6");
    expect(f.events.slice(-2)).toEqual(["delete/5", "upload:6"]);
  });

  it("a deletion failure preserves identity and prevents replacement; 404 allows clearing", async () => {
    const f = setup();
    await f.signature.replace("image");
    f.deletionError(Object.assign(new Error("busy"), { status: 409 }));
    await expect(f.signature.replace("other")).rejects.toThrow(/busy/);
    expect(f.signature.status().state).toBe("ready");
    expect(f.handles.size).toBe(1);
    expect(f.events.filter((event) => event.startsWith("upload")).length).toBe(1);
    f.deletionError(undefined);
    await f.signature.clear();
    expect(f.handles.size).toBe(0);
    expect(f.signature.status().state).toBe("empty");
    await f.signature.replace("image");
    f.deletionError(Object.assign(new Error("missing"), { status: 404 }));
    await f.signature.clear();
    expect(f.signature.status().state).toBe("empty");
  });

  it("delayed checks and ensureReady reuse the pending identity instead of uploading", async () => {
    const f = setup();
    f.mode("pending");
    await f.signature.replace("image");
    await expect(f.signature.ensureReady(fail)).rejects.toThrow(/has been checked/);
    expect(f.signature.status().canRetry).toBe(true);
    f.mode("ready");
    expect(await f.signature.ensureReady(fail)).toBe("1");
    expect(f.events.filter((event) => event.startsWith("upload")).length).toBe(1);
  });

  it("drawing invalidates a pending upload, and a queued retry cannot revive it", async () => {
    const f = setup();
    f.mode("pending");
    await f.signature.replace("image");
    f.signature.invalidate();
    f.mode("ready");
    await f.signature.retry();
    expect(f.signature.status().state).toBe("obsolete");
    expect(await f.signature.ensureReady(() => "drawing")).toBe("2");
    expect(f.events).toEqual(["upload:1", "delete/1", "upload:2"]);
  });

  it("late polling results stay obsolete and keep their cleanup handle", async () => {
    const f = setup();
    f.mode("pending");
    await f.signature.replace("image");
    const reply = deferred<SignatureHandle>();
    f.pollReply(reply);
    const retry = f.signature.retry();
    expect(f.signature.status().busy).toBe(true);
    await expect(f.signature.clear()).rejects.toThrow(/still being processed/);
    f.signature.invalidate();
    reply.resolve({ id: "1", state: "ready" });
    await expect(retry).rejects.toThrow(/signature changed/);
    expect(f.signature.status().state).toBe("obsolete");
    await f.signature.clear();
    expect(f.handles.size).toBe(0);
    expect(f.signature.status().busy).toBe(false);
    expect(f.statuses.at(-1)!.state).toBe("empty");
  });

  it("a drawing changed while being captured cannot be uploaded or submitted", async () => {
    const f = setup();
    const drawing = deferred<string>();
    const ready = f.signature.ensureReady(() => drawing.promise);
    // ensureReady first awaits cleanup, then requests the drawing.
    await Promise.resolve();
    f.signature.invalidate();
    drawing.resolve("old drawing");
    await expect(ready).rejects.toThrow(/signature changed/);
    expect(f.handles.size).toBe(0);
  });
});
