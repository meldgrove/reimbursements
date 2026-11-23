import { useSyncExternalStore } from "react";

/**
 * The name of the record a page shows (a claim's reference, a form's name),
 * for the breadcrumbs. A detail page sets it once it has loaded the record:
 * `useRecordName(form?.name)`.
 */
let current: { path: string; name: string } | null = null;
const listeners = new Set<() => void>();

export function setRecordName(path: string, name: string | null) {
  current = name ? { path, name } : null;
  for (const listener of listeners) listener();
}

export function useRecordNameFor(pathname: string): string | undefined {
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
  return value && value.path === pathname ? value.name : undefined;
}
