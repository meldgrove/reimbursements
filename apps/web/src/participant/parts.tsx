import type { ReactNode } from "react";
import { cn } from "@meldgrove/ui/utils";
import { useT } from "@/i18n";

/**
 * Small parts of the participant pages: section headings, the progress
 * steps, field messages and text with paragraphs.
 */

/** The heading of a numbered section of the form (portal/section_heading.html). */
export function SectionHeading({
  number,
  id,
  title,
  text,
}: {
  number: ReactNode;
  id: string;
  title: string;
  text?: string;
}) {
  return (
    <div className="flex items-start gap-4 border-b p-5 sm:p-6">
      <span className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold">
        {number}
      </span>
      <div className="grid gap-1">
        <h2 id={id} className="text-lg font-semibold outline-none" tabIndex={-1}>
          {title}
        </h2>
        {text ? <p className="text-muted-foreground text-sm">{text}</p> : null}
      </div>
    </div>
  );
}

/** A card of the form. */
export function Panel({
  labelledBy,
  children,
  className,
}: {
  labelledBy: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn("panel bg-card text-card-foreground rounded-xl border shadow-sm", className)}
      aria-labelledby={labelledBy}
    >
      {children}
    </section>
  );
}

/** The three steps of a claim; `current` is 1, 2 or 3. */
export function Steps({ current }: { current: 1 | 2 | 3 }) {
  const t = useT();
  const steps = [t("Details & receipts"), t("Review & sign"), t("Submitted")];
  return (
    <ol className="steps flex flex-wrap items-center gap-2 text-sm sm:gap-3" aria-label={t("Progress")}>
      {steps.map((label, index) => {
        const active = index + 1 === current;
        return (
          <li
            key={label}
            id={index === 0 ? "step-details" : index === 1 ? "step-review" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-full border px-3 py-1",
              active
                ? "active border-primary bg-primary/10 text-foreground font-medium"
                : "text-muted-foreground",
            )}
            aria-current={active ? "step" : undefined}
          >
            <span
              className={cn(
                "flex size-5 items-center justify-center rounded-full text-xs",
                active ? "bg-primary text-primary-foreground" : "bg-muted",
              )}
            >
              {index + 1}
            </span>
            {label}
          </li>
        );
      })}
    </ol>
  );
}

/** A field's message: always present, so the field can name it (aria-describedby); polite when it changes. */
export function FieldMessage({
  id,
  message,
  className,
}: {
  id: string;
  message?: string;
  className?: string;
}) {
  return (
    <p id={id} className={cn("field-error text-destructive text-sm", className)} aria-live="polite">
      {message ?? ""}
    </p>
  );
}

/** Blank-line separated paragraphs; a paragraph starting with "# " is a heading (the `paragraphs` filter). */
export function Paragraphs({ text, className }: { text: string; className?: string }) {
  const blocks = (text || "")
    .replace(/\r\n/g, "\n")
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean);
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {blocks.map((block, index) =>
        block.startsWith("# ") ? (
          <h3 key={index} className="text-base font-semibold">
            {block.slice(2).trim()}
          </h3>
        ) : (
          <p key={index}>{block}</p>
        ),
      )}
    </div>
  );
}

/** Text with its line breaks (Django's linebreaksbr). */
export function Lines({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  return (
    <>
      {lines.map((line, index) => (
        <span key={index}>
          {index > 0 ? <br /> : null}
          {line}
        </span>
      ))}
    </>
  );
}
