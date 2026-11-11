const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createSignature } = require("../../portal/static/portal/signature.js");

// The form passes these messages in the app language.
const text = {
  signature_changed: "The signature changed. Please try again.",
  signature_busy: "The signature is still being processed.",
  signature_missing: "Please draw or upload a signature.",
  signature_wait: "Please wait until the signature has been checked.",
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function setup() {
  const handles = new Set(), events = [], statuses = [];
  let count = 0, mode = "ready", deletionError, pollReply;
  const signature = createSignature({
    async upload(blob, update) {
      const handle = { id: String(++count), delete_url: `delete/${count}`, status_url: `status/${count}`, state: "pending" };
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
    async remove(url) {
      events.push(url);
      if (deletionError) throw deletionError;
      handles.delete(url.split("/")[1]);
    },
    onChange(status) { statuses.push(status); },
    text,
  });
  return {
    signature, handles, events, statuses,
    mode(value) { mode = value; },
    deletionError(value) { deletionError = value; },
    pollReply(value) { pollReply = value; },
  };
}

test("replacement cleans failed uploads before consuming another slot", async () => {
  const f = setup();
  f.mode("failed");
  for (let i = 0; i < 5; i++) {
    await assert.rejects(f.signature.replace("image"), /validation failed/);
    assert.equal(f.handles.size, 1);
    assert.equal(f.signature.status().state, "failed");
  }
  f.mode("ready");
  await f.signature.replace("image");
  assert.equal(await f.signature.ensureReady(() => assert.fail("must reuse ready upload")), "6");
  assert.deepEqual(f.events.slice(-2), ["delete/5", "upload:6"]);
});

test("deletion failure preserves identity and prevents replacement; 404 allows clearing", async () => {
  const f = setup();
  await f.signature.replace("image");
  f.deletionError(Object.assign(new Error("busy"), { status: 409 }));
  await assert.rejects(f.signature.replace("other"), /busy/);
  assert.equal(f.signature.status().state, "ready");
  assert.equal(f.handles.size, 1);
  assert.equal(f.events.filter((e) => e.startsWith("upload")).length, 1);
  f.deletionError(undefined);
  await f.signature.clear();
  assert.equal(f.handles.size, 0);
  assert.equal(f.signature.status().state, "empty");
  await f.signature.replace("image");
  f.deletionError(Object.assign(new Error("missing"), { status: 404 }));
  await f.signature.clear();
  assert.equal(f.signature.status().state, "empty");
});

test("delayed checks and ensureReady reuse pending identity instead of uploading", async () => {
  const f = setup();
  f.mode("pending");
  await f.signature.replace("image");
  await assert.rejects(f.signature.ensureReady(() => assert.fail("must not upload")), /has been checked/);
  assert.equal(f.signature.status().canRetry, true);
  f.mode("ready");
  assert.equal(await f.signature.ensureReady(() => assert.fail("must reuse pending upload")), "1");
  assert.equal(f.events.filter((e) => e.startsWith("upload")).length, 1);
});

test("drawing invalidates a pending upload, and queued retry cannot revive it", async () => {
  const f = setup();
  f.mode("pending");
  await f.signature.replace("image");
  f.signature.invalidate();
  f.mode("ready");
  await f.signature.retry();
  assert.equal(f.signature.status().state, "obsolete");
  assert.equal(await f.signature.ensureReady(() => "drawing"), "2");
  assert.deepEqual(f.events, ["upload:1", "delete/1", "upload:2"]);
});

test("late polling results stay obsolete and retain their cleanup handle", async () => {
  const f = setup();
  f.mode("pending");
  await f.signature.replace("image");
  const reply = deferred();
  f.pollReply(reply);
  const retry = f.signature.retry();
  assert.equal(f.signature.status().busy, true);
  await assert.rejects(f.signature.clear(), /still being processed/);
  f.signature.invalidate();
  reply.resolve({ id: "1", state: "ready" });
  await assert.rejects(retry, /signature changed/);
  assert.equal(f.signature.status().state, "obsolete");
  await f.signature.clear();
  assert.equal(f.handles.size, 0);
  assert.equal(f.signature.status().busy, false);
  assert.equal(f.statuses.at(-1).state, "empty");
});

test("a drawing changed while being captured cannot be uploaded or submitted", async () => {
  const f = setup(), drawing = deferred();
  const ready = f.signature.ensureReady(() => drawing.promise);
  // ensureReady first awaits cleanup, then requests the drawing.
  await Promise.resolve();
  f.signature.invalidate();
  drawing.resolve("old drawing");
  await assert.rejects(ready, /signature changed/);
  assert.equal(f.handles.size, 0);
});
