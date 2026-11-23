/**
 * Which editor a form's address shows. A new form's editor gives its form an
 * address of its own after the first save (/admin/forms/new?template=1 →
 * /admin/forms/7); the route keeps that editor mounted, as Django's autosave
 * script replaced the address without a reload.
 */
const created = new Map<string, string>();

/** The editor of an address: a form by its id, or a new form of a template. */
export function editorKey(formId: string, template?: number): string {
  return created.get(formId) ?? (formId === "new" ? `new:${template ?? ""}` : `form:${formId}`);
}

/** The new form's editor (`key`) goes on showing the form it created. */
export function keepEditor(formId: number, key: string) {
  created.set(String(formId), key);
}

export function forgetEditor(formId: number) {
  created.delete(String(formId));
}
