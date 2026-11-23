import type { ChangeEvent } from "react";
import { ArrowDown, ArrowUp, Upload } from "lucide-react";
import { Button } from "@meldgrove/ui/button";
import { Checkbox } from "@meldgrove/ui/checkbox";
import { Input } from "@meldgrove/ui/input";
import { cn } from "@meldgrove/ui/utils";
import type { FormPage } from "@reimbursements/shared/api/public";
import { useT } from "@/i18n";
import { say, type FileState } from "./form-api";
import { FieldMessage } from "./parts";

/** A file of a row, with a key of its own while it has no upload ID yet. */
export type RowFile = FileState & { key: string };

/** An expense row: a receipt with its files, or a mileage claim. */
export type Row = {
  id: string;
  kind: "receipt" | "mileage";
  values: Record<string, string | boolean>;
  files: RowFile[];
  uploading: boolean;
  removing: boolean;
};

type Props = {
  row: Row;
  index: number;
  count: number;
  config: FormPage["config"];
  messages: Record<string, string>;
  mileageText: string;
  onChange: (field: string, value: string | boolean) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  onFiles: (files: File[]) => void;
  onMoveFile: (index: number, delta: -1 | 1) => void;
  onRemoveFile: (file: RowFile) => void;
  onRetryFile: (file: RowFile) => void;
};

const fieldId = (row: Row, field: string) => `expense-${row.id}-${field}`;

/** One expense item of the form (the expense and mileage templates of portal/templates/portal/form.html). */
export function ExpenseCard(props: Props) {
  const { row, index, count, config, messages } = props;
  const t = useT();
  const busy = row.uploading || row.removing;
  const lengths = config.field_lengths;

  function text(
    field: string,
    label: string,
    options: {
      required?: boolean;
      placeholder?: string;
      maxLength?: number;
      type?: string;
      inputMode?: "decimal" | "numeric";
      pattern?: string;
      min?: number | string;
      max?: number;
      step?: number;
      disabled?: boolean;
    } = {},
  ) {
    const id = fieldId(row, field);
    const errorId = `error-${id}`;
    const value = row.values[field];
    return (
      <div className="field flex flex-col gap-1.5">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <Input
          id={id}
          data-field={field}
          data-error-id={errorId}
          aria-describedby={errorId}
          aria-invalid={messages[errorId] ? true : undefined}
          value={typeof value === "string" ? value : ""}
          onChange={(event: ChangeEvent<HTMLInputElement>) => props.onChange(field, event.target.value)}
          required={options.required}
          placeholder={options.placeholder}
          maxLength={options.maxLength}
          type={options.type ?? "text"}
          inputMode={options.inputMode}
          pattern={options.pattern}
          min={options.min}
          max={options.max}
          step={options.step}
          disabled={options.disabled}
        />
        <FieldMessage id={errorId} message={messages[errorId]} />
      </div>
    );
  }

  const roundTrip = row.values.round_trip === true;
  return (
    <article
      className="expense-card bg-background flex flex-col gap-4 rounded-lg border p-4"
      data-kind={row.kind}
      aria-labelledby={`${fieldId(row, "title")}`}
    >
      <div className="expense-top flex flex-wrap items-center justify-between gap-2">
        <h3 id={fieldId(row, "title")} className="font-semibold">
          <span className="row-number">{index + 1}</span>{" "}
          {row.kind === "mileage" ? t("Mileage claim") : t("Expense with receipt")}
        </h3>
        <div className="row-actions flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-action="up"
            aria-label={t("Move item up")}
            disabled={index === 0}
            onClick={() => props.onMove(-1)}
          >
            <ArrowUp aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-action="down"
            aria-label={t("Move item down")}
            disabled={index === count - 1}
            onClick={() => props.onMove(1)}
          >
            <ArrowDown aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-action="remove"
            className="remove-row text-destructive"
            disabled={busy}
            onClick={props.onRemove}
          >
            {t("Remove")}
          </Button>
        </div>
      </div>
      {row.kind === "mileage" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {text("travel_date", t("Date of the outward journey *"), { type: "date", required: true })}
          {text("vehicle_registration", t("Registration *"), {
            required: true,
            maxLength: lengths.vehicle_registration,
            placeholder: t("e.g. B-AB 123"),
          })}
          {text("route_from", t("From *"), {
            required: true,
            maxLength: lengths.route_from,
            placeholder: t("Place"),
          })}
          {text("route_to", t("To *"), {
            required: true,
            maxLength: lengths.route_to,
            placeholder: t("Place"),
          })}
          {text("distance_km", t("Distance (one way, km) *"), {
            type: "number",
            inputMode: "numeric",
            min: 1,
            max: config.max_distance_km,
            step: 1,
            required: true,
          })}
          <div className="field flex flex-col justify-end gap-1.5">
            <div className="flex items-center gap-2">
              <Checkbox
                id={fieldId(row, "round_trip")}
                data-field="round_trip"
                aria-describedby={`error-${fieldId(row, "round_trip")}`}
                checked={roundTrip}
                onCheckedChange={(checked) => props.onChange("round_trip", checked === true)}
              />
              <label htmlFor={fieldId(row, "round_trip")} className="text-sm font-medium">
                {t("Return journey")}
              </label>
            </div>
            <p className="mileage-amount text-muted-foreground text-sm" aria-live="polite">
              {props.mileageText}
            </p>
            <FieldMessage
              id={`error-${fieldId(row, "round_trip")}`}
              message={messages[`error-${fieldId(row, "round_trip")}`]}
            />
          </div>
          {roundTrip ? (
            <div className="return-date">
              {text("return_date", t("Date of the return journey *"), {
                type: "date",
                required: true,
                min: typeof row.values.travel_date === "string" ? row.values.travel_date : undefined,
              })}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {text("merchant", t("Business partner *"), {
            required: true,
            maxLength: lengths.merchant,
            placeholder: t("e.g. ticket office"),
          })}
          {text("receipt_reference", t("Reference/invoice no."), {
            maxLength: lengths.receipt_reference,
            placeholder: t("if available"),
          })}
          {text("amount", t("Amount in EUR *"), {
            required: true,
            inputMode: "decimal",
            placeholder: config.amount_placeholder,
            pattern: config.amount_pattern,
          })}
        </div>
      )}
      <div className="receipt-zone flex flex-col gap-2 rounded-lg border border-dashed p-3">
        <label
          className={cn(
            "upload-button border-input bg-background hover:bg-accent inline-flex w-fit cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium shadow-xs",
            "focus-within:ring-ring/50 focus-within:ring-[3px]",
            busy && "pointer-events-none opacity-50",
          )}
        >
          <Upload className="size-4" aria-hidden="true" />
          {row.kind === "mileage" ? t("Add supporting file (optional)") : t("Add receipt")}
          <input
            type="file"
            className="receipt-input sr-only"
            accept="application/pdf,image/jpeg,image/png"
            multiple
            disabled={busy}
            onChange={(event) => {
              const selected = [...(event.target.files ?? [])];
              event.target.value = "";
              props.onFiles(selected);
            }}
          />
        </label>
        <small className="text-muted-foreground text-xs">
          {row.kind === "mileage"
            ? t("For example, a screenshot of the route.")
            : config.messages.receipt_hint}
        </small>
        <ul className="file-list flex flex-col gap-1" aria-live="polite">
          {row.files.map((file, position) => (
            <li key={file.key} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="file-name min-w-0 flex-1 truncate font-medium">{file.name}</span>
              <span
                className={cn(
                  "file-status",
                  file.state,
                  file.state === "ready" && "text-foreground",
                  file.state === "failed" && "text-destructive",
                  file.state !== "ready" && file.state !== "failed" && "text-muted-foreground",
                )}
              >
                {file.message || say(config, `file_${file.state}`)}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={say(config, "move_receipt_up")}
                disabled={row.removing || position === 0}
                onClick={() => props.onMoveFile(position, -1)}
              >
                <ArrowUp aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={say(config, "move_receipt_down")}
                disabled={row.removing || position === row.files.length - 1}
                onClick={() => props.onMoveFile(position, 1)}
              >
                <ArrowDown aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={row.removing || file.state === "uploading"}
                onClick={() => props.onRemoveFile(file)}
              >
                {say(config, "remove")}
              </Button>
              {file.state === "pending" && !file.polling ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={row.removing}
                  onClick={() => props.onRetryFile(file)}
                >
                  {say(config, "check_again")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
      <FieldMessage
        id={`error-expense-${row.id}-__all__`}
        message={messages[`error-expense-${row.id}-__all__`]}
      />
    </article>
  );
}
