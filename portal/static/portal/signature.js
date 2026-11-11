"use strict";
// The Signature lifecycle has no DOM dependency. The form supplies network access
// and renders a read-only status; the upload handle never escapes this module.
((root) => {
  // `text` holds the messages in the app language; a missing one shows its key.
  function createSignature({ upload, poll, remove, onChange = () => {}, text = {} }) {
    let current = null, busy = false, generation = 0;
    const say = (key) => text[key] || key;
    const changed = () => new Error(say("signature_changed"));
    function status() {
      return Object.freeze({
        state: current?.state || "empty", busy,
        canRetry: !busy && current?.state === "pending",
        message: current?.message || "",
      });
    }
    function notify() { onChange(status()); }
    async function run(action) {
      if (busy) throw new Error(say("signature_busy"));
      busy = true;
      notify();
      try { return await action(); }
      finally { busy = false; notify(); }
    }
    async function discard() {
      if (current?.delete_url) {
        try { await remove(current.delete_url); }
        catch (error) { if (error.status !== 404) throw error; }
      }
      current = null;
    }
    async function receive(action) {
      const version = generation;
      function update(value) {
        if (value.id || current) {
          current = { ...current, ...value };
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
          current.message = error.message;
          notify();
        }
        throw error;
      }
    }
    async function resume() {
      if (current?.state !== "pending" || !current.status_url) return;
      const handle = { ...current };
      await receive((update) => poll(handle, update));
    }
    return Object.freeze({
      status,
      invalidate() {
        generation++;
        if (current) current.state = "obsolete";
        notify();
      },
      clear() {
        return run(async () => { generation++; await discard(); });
      },
      replace(blob) {
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
      retry() { return run(resume); },
      ensureReady(getDrawing) {
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
          if (current?.state !== "ready")
            throw new Error(current?.message || say("signature_wait"));
          return current.id;
        });
      },
    });
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { createSignature };
  else root.PortalSignature = { createSignature };
})(globalThis);
