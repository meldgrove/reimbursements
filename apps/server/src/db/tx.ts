import { AsyncLocalStorage } from "node:async_hooks";
import { getDb, type DbOrTx, type Tx } from "./client";
import { logger } from "../logger";

/**
 * Transactions as the engine uses them: `atomic(fn)` runs `fn` in a
 * transaction, or in a savepoint when one is already open, and `q()` is the
 * database handle of the code running now (the open transaction, or the
 * pool). `onCommit(fn)` runs `fn` once the outermost transaction commits,
 * and never when it, or the savepoint the callback was registered in, rolls
 * back; outside a transaction it runs at once.
 */

type Scope = { tx: Tx; callbacks: (() => unknown)[] };

const storage = new AsyncLocalStorage<Scope>();

/** The handle for queries: the open transaction, or the pool. */
export function q(): DbOrTx {
  return storage.getStore()?.tx ?? getDb();
}

export function inTransaction(): boolean {
  return storage.getStore() !== undefined;
}

export async function atomic<T>(fn: () => Promise<T>): Promise<T> {
  const outer = storage.getStore();
  const callbacks: (() => unknown)[] = [];
  if (outer) {
    const result = await outer.tx.transaction((tx) => storage.run({ tx, callbacks }, fn));
    outer.callbacks.push(...callbacks);
    return result;
  }
  const result = await getDb().transaction((tx) => storage.run({ tx, callbacks }, fn));
  for (const callback of callbacks) {
    try {
      await callback();
    } catch (error) {
      logger.error({ err: error }, "a callback after a commit failed");
    }
  }
  return result;
}

export function onCommit(fn: () => unknown): void {
  const scope = storage.getStore();
  if (scope) {
    scope.callbacks.push(fn);
    return;
  }
  void Promise.resolve()
    .then(fn)
    .catch((error: unknown) => logger.error({ err: error }, "a callback failed"));
}

/** Whether the error is PostgreSQL's unique violation, also when Drizzle wrapped it (`cause`). */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current instanceof Error; depth += 1) {
    if ((current as { code?: unknown }).code === "23505") return true;
    current = current.cause;
  }
  return false;
}
