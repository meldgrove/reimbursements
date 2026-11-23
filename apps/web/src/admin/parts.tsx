import { useEffect, useId, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Search, X } from "lucide-react";
import { Badge } from "@meldgrove/ui/badge";
import { Button } from "@meldgrove/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@meldgrove/ui/field";
import { Input } from "@meldgrove/ui/input";
import { NativeSelect, NativeSelectOption } from "@meldgrove/ui/native-select";
import { cn } from "@meldgrove/ui/utils";
import type { FilterOption } from "@reimbursements/shared/api/admin";
import { ApiError } from "@/lib/api";
import { setRecordName } from "./record-name";

/**
 * Parts the admin pages share: badges in the tones of the Django version's
 * status colors, the toolbar of a list (search, filters, count), labelled
 * detail rows and form fields with their errors.
 */

const TONES: Record<string, string> = {
  success: "border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
  warning: "border-transparent bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300",
  info: "border-transparent bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300",
};

/** A badge of a tone: success, warning, info, destructive, outline or secondary. */
export function ToneBadge({ tone, children }: { tone: string; children: ReactNode }) {
  if (tone === "destructive" || tone === "outline" || tone === "secondary" || tone === "default")
    return <Badge variant={tone}>{children}</Badge>;
  return <Badge className={TONES[tone] ?? ""}>{children}</Badge>;
}

/** The record a page shows, by name, for the breadcrumbs. */
export function useRecordName(path: string, name: string | null | undefined) {
  useEffect(() => {
    if (!name) return;
    setRecordName(path, name);
    return () => setRecordName(path, null);
  }, [path, name]);
}

/** A list's search box: sends the query on Enter, as Django's change list. */
export function ListSearch({
  value,
  placeholder,
  label,
  onSearch,
}: {
  value: string;
  placeholder: string;
  label: string;
  onSearch: (value: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const id = useId();
  return (
    <form
      role="search"
      className="relative w-full sm:w-72"
      onSubmit={(event) => {
        event.preventDefault();
        onSearch(text.trim());
      }}
    >
      <label className="sr-only" htmlFor={id}>
        {label}
      </label>
      <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
      <Input
        id={id}
        type="search"
        value={text}
        maxLength={200}
        placeholder={placeholder}
        className="h-8 pl-8"
        onChange={(event) => setText(event.target.value)}
      />
    </form>
  );
}

/** A filter of a list as a small select; the empty value is `all`. */
export function ListFilter({
  label,
  value,
  all,
  options,
  onChange,
}: {
  label: string;
  value: string;
  all: string;
  options: FilterOption[];
  onChange: (value: string) => void;
}) {
  return (
    <NativeSelect
      size="sm"
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      wrapperClassName="w-auto"
    >
      <NativeSelectOption value="">{all}</NativeSelectOption>
      {options.map((option) => (
        <NativeSelectOption key={option.value} value={option.value}>
          {option.label}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}

/** The toolbar above a list: search, filters, a reset of both, and the count. */
export function ListToolbar({
  children,
  active,
  onReset,
  count,
}: {
  children: ReactNode;
  active: boolean;
  onReset: () => void;
  count: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b p-3">
      {children}
      {active ? (
        <Button variant="ghost" size="sm" onClick={onReset}>
          Reset
          <X />
        </Button>
      ) : null}
      <span className="text-muted-foreground ml-auto text-sm">{count}</span>
    </div>
  );
}

/** Label and value rows, as Django's read-only fieldsets. */
export function DetailList({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid divide-y text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="grid gap-1 px-6 py-3 sm:grid-cols-[12rem_1fr]">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words">{value === "" || value === null ? "—" : value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A form field with its label, help and error. `children` gets the control's id and error state. */
export function FormRow({
  label,
  help,
  error,
  required,
  className,
  children,
}: {
  label: string;
  help?: ReactNode;
  error?: string;
  required?: boolean;
  className?: string;
  children: (props: { id: string; "aria-invalid"?: boolean; "aria-describedby"?: string }) => ReactNode;
}) {
  const id = useId();
  const described = [help ? `${id}-help` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ");
  return (
    <Field data-invalid={error ? true : undefined} className={className}>
      <FieldLabel htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true">*</span> : null}
      </FieldLabel>
      {children({ id, "aria-invalid": error ? true : undefined, "aria-describedby": described || undefined })}
      {help ? <FieldDescription id={`${id}-help`}>{help}</FieldDescription> : null}
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </Field>
  );
}

/** The field messages of an API error (422), by field. */
export function fieldErrors(error: unknown): Record<string, string> {
  return error instanceof ApiError && error.fields ? error.fields : {};
}

/** An internal link that looks like one. */
export function TextLink({
  to,
  children,
  className,
}: {
  to: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link to={to} className={cn("font-medium underline-offset-4 hover:underline", className)}>
      {children}
    </Link>
  );
}

/** "1 claim" or "2 claims". */
export function plural(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}
