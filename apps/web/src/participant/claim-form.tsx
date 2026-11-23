import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useBlocker, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  CalendarDays,
  Eye,
  Info,
  Paperclip,
  PenLine,
  Plus,
  ShieldCheck,
  TriangleAlert,
  Upload,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@meldgrove/ui/alert";
import { Badge } from "@meldgrove/ui/badge";
import { Button } from "@meldgrove/ui/button";
import { Checkbox } from "@meldgrove/ui/checkbox";
import { Input } from "@meldgrove/ui/input";
import { NativeSelect, NativeSelectOption } from "@meldgrove/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@meldgrove/ui/radio-group";
import { Textarea } from "@meldgrove/ui/textarea";
import { cn } from "@meldgrove/ui/utils";
import type { FieldErrors, FormPage, SubmitAnswer, ValidateAnswer } from "@reimbursements/shared/api/public";
import { useT } from "@/i18n";
import { ExpenseCard, type Row, type RowFile } from "./expense-card";
import {
  FormRequestError,
  cents as parseCents,
  deleteUpload,
  formRequest,
  formatDate,
  money as formatMoney,
  pollUpload,
  say as sayText,
  uploadFile,
  type UploadUpdate,
} from "./form-api";
import { FieldMessage, Lines, Panel, Paragraphs, SectionHeading, Steps } from "./parts";
import { createSignature, type SignatureStatus } from "./signature";

/**
 * The claim form (portal/templates/portal/form.html and portal/static/portal/form.js
 * of the Django version): the details and receipts, then the review with the
 * declaration, signature and privacy notice, then submission.
 *
 * Element IDs, classes and data attributes are the Django version's, so the
 * browser checks (tests/browser) find the same parts.
 */

const CLAIM_FIELDS = [
  "full_name",
  "email",
  "street",
  "postal_code",
  "city",
  "country",
  "account_holder",
  "iban",
  "bic",
  "purpose",
  "purpose_details",
  "trip_destination",
  "trip_start",
  "trip_end",
] as const;
type ClaimField = (typeof CLAIM_FIELDS)[number];

const TRIP_FIELDS: ClaimField[] = ["trip_destination", "trip_start", "trip_end"];

/** Fields whose rules depend on another one: changing the key rechecks them. */
const DEPENDENCIES: Partial<Record<string, string[]>> = {
  full_name: ["account_holder"],
  country: ["postal_code"],
  iban: ["bic"],
  trip_start: ["trip_end"],
};

function newRow(kind: Row["kind"], page: FormPage): Row {
  return {
    id: crypto.randomUUID(),
    kind,
    values:
      kind === "mileage"
        ? {
            travel_date: page.form.tripStart,
            return_date: page.form.tripEnd,
            vehicle_registration: "",
            route_from: "",
            route_to: "",
            distance_km: "",
            round_trip: false,
          }
        : { merchant: "", receipt_reference: "", amount: "" },
    files: [],
    uploading: false,
    removing: false,
  };
}

/** A state value with a ref that always holds its latest value, for async work. */
function useLatest<T>(initial: T) {
  const [value, setValue] = useState(initial);
  const ref = useRef(value);
  const set = useCallback((next: T | ((previous: T) => T)) => {
    const resolved = typeof next === "function" ? (next as (previous: T) => T)(ref.current) : next;
    ref.current = resolved;
    setValue(resolved);
  }, []);
  return [value, set, ref] as const;
}

export function ClaimForm({ page, slug }: { page: FormPage; slug: string }) {
  const t = useT();
  const navigate = useNavigate();
  const { config, terms, form } = page;
  const preview = page.state === "preview";
  const context = useMemo(
    () => ({
      config,
      token: page.draft?.token ?? "",
      slug,
      draftId: page.draft?.id ?? "",
      preview,
    }),
    [config, page.draft, slug, preview],
  );
  const say = useCallback(
    (key: string, values?: Record<string, string | number>) => sayText(config, key, values),
    [config],
  );
  const amountFormat = useMemo(() => new RegExp(`^(?:${config.amount_pattern})$`), [config.amount_pattern]);
  const rateCents = terms.mileageRate ? parseCents(amountFormat, terms.mileageRate) : null;
  const money = useCallback((amount: bigint) => formatMoney(config, amount), [config]);

  const [values, setValues, valuesRef] = useLatest<Record<ClaimField, string>>({
    full_name: "",
    email: "",
    street: "",
    postal_code: "",
    city: "",
    country: "DE",
    account_holder: "",
    iban: "",
    bic: "",
    purpose: terms.fixedPurpose ?? "",
    purpose_details: "",
    trip_destination: "",
    trip_start: form.tripStart,
    trip_end: form.tripEnd,
  });
  const accountHolderEdited = useRef(false);
  const [rows, setRows, rowsRef] = useLatest<Row[]>([]);
  const [tripOpen, setTripOpen, tripOpenRef] = useLatest(false);
  const [messages, setMessages, messagesRef] = useLatest<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [step, setStep] = useState<"details" | "review">("details");
  const [reviewing, setReviewing] = useState(false);
  const [declaration, setDeclaration] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [submitting, setSubmitting, submittingRef] = useLatest(false);
  const [website, setWebsite] = useState("");
  const accepted = useRef(false);

  const detailsRef = useRef<HTMLDivElement>(null);
  const reviewRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const addExpenseRef = useRef<HTMLButtonElement>(null);
  const touched = useRef(new Set<string>());
  const validation = useRef({ version: 0, request: 0, timer: 0 as unknown as ReturnType<typeof setTimeout> });

  const hasMileage = rows.some((row) => row.kind === "mileage");
  const travelShown = terms.travel !== "off" && rows.length > 0 && !hasMileage;
  const tripNeeded = travelShown && (terms.travel === "required" || tripOpen);

  /** Whether the trip fields take part now (as `updateTravel` set their disabled state). */
  const tripNeededNow = () => {
    const current = rowsRef.current;
    const shown =
      terms.travel !== "off" && current.length > 0 && !current.some((row) => row.kind === "mileage");
    return shown && (terms.travel === "required" || tripOpenRef.current);
  };

  const rowData = (row: Row) => row.values;

  const rowAmount = useCallback(
    (row: Row): bigint | null => {
      const data = rowData(row);
      if (row.kind !== "mileage") return parseCents(amountFormat, String(data.amount ?? ""));
      const distance = String(data.distance_km ?? "").trim();
      if (!/^\d{1,5}$/.test(distance) || rateCents === null) return null;
      const kilometres = BigInt(distance);
      if (kilometres < 1n || kilometres > BigInt(config.max_distance_km)) return null;
      return kilometres * (data.round_trip ? 2n : 1n) * rateCents;
    },
    [amountFormat, rateCents, config.max_distance_km],
  );

  const total = rows.reduce((sum, row) => sum + (rowAmount(row) ?? 0n), 0n);
  const duplicateReference = (() => {
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.kind === "mileage") continue;
      const reference = String(row.values.receipt_reference ?? "")
        .trim()
        .toLocaleLowerCase(config.locale);
      if (reference && seen.has(reference)) return true;
      seen.add(reference);
    }
    return false;
  })();

  // -- errors -------------------------------------------------------------------

  /** Focuses the first invalid field of the visible panel, or the error box. */
  const focusInvalid = useCallback(() => {
    // After React has shown the panel the error belongs to.
    setTimeout(() => {
      const panel = detailsRef.current && !detailsRef.current.hidden ? detailsRef.current : reviewRef.current;
      const invalid = panel?.querySelector<HTMLElement>('[aria-invalid="true"]');
      if (invalid && invalid.getClientRects().length) invalid.focus();
      else errorRef.current?.focus();
    }, 0);
  }, []);

  const showError = useCallback(
    (message: string, fields: FieldErrors = {}) => {
      const texts = Object.values(fields)
        .flat()
        .map((error) => error.message);
      setFormError([message, ...texts].join(" "));
      setMessages((previous) => {
        const next = { ...previous };
        for (const [name, errors] of Object.entries(fields))
          next[`error-${name}`] = errors.map((error) => error.message).join(" ");
        return next;
      });
      focusInvalid();
    },
    [setMessages, focusInvalid],
  );

  const clearErrors = useCallback(() => {
    setFormError("");
    setMessages({});
  }, [setMessages]);

  // -- live validation -------------------------------------------------------------

  const expenseData = useCallback(
    () =>
      rowsRef.current.map((row) => ({
        id: row.id,
        kind: row.kind,
        ...row.values,
        uploads: row.files.filter((file) => file.id).map((file) => file.id),
      })),
    [rowsRef],
  );

  const detailData = useCallback(() => {
    const data: Record<string, unknown> = {};
    for (const name of CLAIM_FIELDS) data[name] = valuesRef.current[name];
    return { ...data, draft_id: page.draft?.id ?? "", expenses: expenseData(), is_trip: tripNeededNow() };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads the refs at call time
  }, [expenseData, page.draft, valuesRef]);

  /** The message the browser itself would give a field, as form.js's localFeedback. */
  const localFeedback = useCallback(
    (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string => {
      if (element.disabled) return "";
      let message = element.validationMessage;
      if (element.required && element.type !== "radio" && !element.value.trim())
        message = say("field_required");
      if (element.dataset.field === "amount") {
        const amount = parseCents(amountFormat, element.value);
        if (amount === null || amount <= 0n) message = say("amount_invalid");
      }
      if (element.dataset.field === "return_date") {
        const row = rowsRef.current.find((candidate) => element.id === `expense-${candidate.id}-return_date`);
        const outward = String(row?.values.travel_date ?? "");
        if (element.value && outward && element.value < outward) message = say("return_before_outward");
      }
      return message;
    },
    [say, amountFormat, rowsRef],
  );

  const validateDetails = useCallback(
    async (all = false): Promise<boolean> => {
      const version = validation.current.version;
      const request = ++validation.current.request;
      let fields: FieldErrors = {};
      if (!preview) {
        try {
          fields = (
            await formRequest<ValidateAnswer>(
              context,
              `/api/v1/public/forms/${encodeURIComponent(slug)}/validate`,
              {
                method: "POST",
                body: detailData(),
              },
            )
          ).fields;
        } catch (error) {
          // Background checks stay quiet on connection failures. Review must retry.
          if (all && version === validation.current.version) showError((error as Error).message);
          return false;
        }
      }
      const panel = detailsRef.current;
      if (version !== validation.current.version || request !== validation.current.request || !panel)
        return false;
      let valid = true;
      const next: Record<string, string> = { ...messagesRef.current };
      for (const element of panel.querySelectorAll<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >("input,textarea,select")) {
        if (["file", "hidden"].includes(element.type) || element.dataset.honeypot) continue;
        const key = element.name || element.id;
        if (!all && !touched.current.has(key)) continue;
        const message = element.disabled
          ? ""
          : fields[key]?.map((error) => error.message).join(" ") || localFeedback(element);
        next[element.dataset.errorId || `error-${element.name}`] = message;
        if (message) valid = false;
      }
      // Choices that are not inputs (the purpose radios): the server's message.
      if (terms.purposeOptions.length && !terms.fixedPurpose && (all || touched.current.has("purpose"))) {
        const message = fields.purpose?.map((error) => error.message).join(" ") || "";
        next["error-purpose"] = message;
        if (message) valid = false;
      }
      for (const row of rowsRef.current) {
        const target = `error-expense-${row.id}-__all__`;
        if (all || next[target])
          next[target] = fields[`expense-${row.id}-__all__`]?.map((error) => error.message).join(" ") || "";
      }
      next["error-__all__"] = rowsRef.current.length
        ? fields.__all__?.map((error) => error.message).join(" ") || ""
        : "";
      setMessages(next);
      if (all && Object.keys(fields).length) {
        showError(say("check_marked"), fields);
        valid = false;
      }
      return valid;
    },
    [
      preview,
      context,
      slug,
      detailData,
      showError,
      messagesRef,
      localFeedback,
      terms,
      rowsRef,
      setMessages,
      say,
    ],
  );

  const scheduleValidation = useCallback(
    (key: string) => {
      touched.current.add(key);
      for (const name of DEPENDENCIES[key] ?? []) {
        if (name === "bic" || valuesRef.current[name as ClaimField]) touched.current.add(name);
      }
      const rowField = /^expense-(.+)-(travel_date|round_trip)$/.exec(key);
      if (rowField) touched.current.add(`expense-${rowField[1]}-return_date`);
      validation.current.version += 1;
      clearTimeout(validation.current.timer);
      validation.current.timer = setTimeout(() => void validateDetails(), 650);
    },
    [validateDetails, valuesRef],
  );

  const rescheduleAfterArrange = useCallback(() => {
    validation.current.version += 1;
    clearTimeout(validation.current.timer);
    if (touched.current.size) validation.current.timer = setTimeout(() => void validateDetails(), 650);
  }, [validateDetails]);

  useEffect(() => () => clearTimeout(validation.current.timer), []);

  function setField(name: ClaimField, value: string) {
    setValues((previous) => {
      const next = { ...previous, [name]: value };
      if (name === "full_name" && !accountHolderEdited.current) next.account_holder = value;
      if (name === "account_holder") accountHolderEdited.current = value !== "";
      return next;
    });
    scheduleValidation(name);
  }

  // -- rows ---------------------------------------------------------------------------

  const updateRow = useCallback(
    (id: string, change: (row: Row) => Row) =>
      setRows((previous) => previous.map((row) => (row.id === id ? change(row) : row))),
    [setRows],
  );
  const updateFile = useCallback(
    (rowId: string, key: string, update: Partial<RowFile>) =>
      updateRow(rowId, (row) => ({
        ...row,
        files: row.files.map((file) => (file.key === key ? { ...file, ...update } : file)),
      })),
    [updateRow],
  );

  function addRow(kind: Row["kind"]) {
    if (rowsRef.current.length >= config.limits.expenses) return;
    clearErrors();
    setRows((previous) => [...previous, newRow(kind, page)]);
    rescheduleAfterArrange();
  }

  function moveRow(index: number, delta: -1 | 1) {
    const other = index + delta;
    setRows((previous) => {
      if (other < 0 || other >= previous.length) return previous;
      const next = [...previous];
      [next[index], next[other]] = [next[other]!, next[index]!];
      return next;
    });
    rescheduleAfterArrange();
  }

  async function removeRow(row: Row) {
    const current = rowsRef.current.find((candidate) => candidate.id === row.id);
    if (!current || current.uploading || current.removing) return;
    updateRow(row.id, (value) => ({ ...value, removing: true }));
    try {
      for (const file of [...current.files]) {
        await deleteUpload(context, file.id);
        updateRow(row.id, (value) => ({
          ...value,
          files: value.files.filter((item) => item.key !== file.key),
        }));
      }
      setRows((previous) => previous.filter((value) => value.id !== row.id));
      rescheduleAfterArrange();
    } catch (error) {
      showError((error as Error).message);
      updateRow(row.id, (value) => ({ ...value, removing: false }));
    }
  }

  async function addFiles(row: Row, selected: File[]) {
    const current = rowsRef.current.find((candidate) => candidate.id === row.id);
    if (!current || current.uploading || current.removing) return;
    if (selected.length + current.files.length > config.limits.files_per_expense) {
      showError(config.messages.files_per_expense_exceeded!);
      return;
    }
    const existing = rowsRef.current.flatMap((item) => item.files).reduce((sum, file) => sum + file.size, 0);
    if (existing + selected.reduce((sum, file) => sum + file.size, 0) > config.limits.submission_bytes) {
      showError(config.messages.submission_too_large!);
      return;
    }
    updateRow(row.id, (value) => ({ ...value, uploading: true }));
    try {
      for (const selectedFile of selected) {
        if (!selectedFile.size || selectedFile.size > config.limits.receipt_bytes) {
          showError(config.messages.receipt_size!);
          continue;
        }
        const key = crypto.randomUUID();
        const file: RowFile = {
          key,
          name: selectedFile.name,
          size: selectedFile.size,
          state: "uploading",
          polling: true,
        };
        updateRow(row.id, (value) => ({ ...value, files: [...value.files, file] }));
        try {
          const result = await uploadFile(context, selectedFile, "receipt", row.id, (update: UploadUpdate) =>
            updateFile(row.id, key, update),
          );
          updateFile(row.id, key, result);
        } catch (error) {
          updateFile(row.id, key, { state: "failed", message: (error as Error).message });
        }
        updateFile(row.id, key, { polling: false });
      }
    } finally {
      updateRow(row.id, (value) => ({ ...value, uploading: false }));
    }
  }

  async function removeFile(row: Row, file: RowFile) {
    const current = rowsRef.current.find((candidate) => candidate.id === row.id);
    if (!current || current.removing) return;
    updateRow(row.id, (value) => ({ ...value, removing: true }));
    try {
      await deleteUpload(context, file.id);
      updateRow(row.id, (value) => ({
        ...value,
        files: value.files.filter((item) => item.key !== file.key),
      }));
    } catch (error) {
      showError((error as Error).message);
    } finally {
      updateRow(row.id, (value) => ({ ...value, removing: false }));
    }
  }

  async function retryFile(row: Row, file: RowFile) {
    if (!file.id) return;
    updateFile(row.id, file.key, { polling: true });
    try {
      const result = await pollUpload(context, { id: file.id, name: file.name, size: file.size }, (update) =>
        updateFile(row.id, file.key, update),
      );
      updateFile(row.id, file.key, result);
    } catch (error) {
      updateFile(row.id, file.key, { state: "failed", message: (error as Error).message });
    } finally {
      updateFile(row.id, file.key, { polling: false });
    }
  }

  function moveFile(row: Row, index: number, delta: -1 | 1) {
    updateRow(row.id, (value) => {
      const other = index + delta;
      if (other < 0 || other >= value.files.length) return value;
      const files = [...value.files];
      [files[index], files[other]] = [files[other]!, files[index]!];
      return { ...value, files };
    });
  }

  function changeRow(row: Row, field: string, value: string | boolean) {
    updateRow(row.id, (current) => ({ ...current, values: { ...current.values, [field]: value } }));
    scheduleValidation(`expense-${row.id}-${field}`);
  }

  // -- signature ----------------------------------------------------------------------

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const signatureFileRef = useRef<HTMLInputElement>(null);
  const drawing = useRef(false);
  const hasInk = useRef(false);
  const [signatureStatus, setSignatureStatus] = useState<SignatureStatus>({
    state: "empty",
    busy: false,
    canRetry: false,
    message: "",
  });
  const [signatureText, setSignatureText] = useState(config.messages.signature_hint ?? "");
  const [signatureViewBusy, setSignatureViewBusy, signatureViewBusyRef] = useLatest(false);

  const resetSignatureView = useCallback(() => {
    const canvas = canvasRef.current;
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    hasInk.current = false;
    if (signatureFileRef.current) signatureFileRef.current.value = "";
    setSignatureText(config.messages.signature_hint ?? "");
  }, [config]);

  const signature = useMemo(
    () =>
      createSignature<Blob>({
        upload: (blob, update) => uploadFile(context, blob, "signature", null, update),
        poll: (handle, update) => pollUpload(context, { id: handle.id! }, update),
        remove: (id) => deleteUpload(context, id),
        text: config.text,
        onChange(status) {
          setSignatureStatus(status);
          if (status.state === "replacing") {
            resetSignatureView();
            setSignatureText(sayText(config, "signature_uploading"));
          } else if (status.state === "ready") setSignatureText(sayText(config, "signature_ready"));
          else if (status.message) setSignatureText(status.message);
        },
      }),
    [context, config, resetSignatureView],
  );

  const signatureDisabled = signatureStatus.busy || signatureViewBusy || submitting;

  async function signatureAction(action: () => Promise<void>): Promise<boolean> {
    if (signature.status().busy || signatureViewBusyRef.current || submittingRef.current) return false;
    clearErrors();
    setSignatureViewBusy(true);
    try {
      await action();
      return true;
    } catch (error) {
      showError((error as Error).message);
      setSignatureText(say("signature_retry"));
      return false;
    } finally {
      setSignatureViewBusy(false);
    }
  }

  async function clearSignature() {
    await signature.clear();
    resetSignatureView();
  }

  function position(event: React.PointerEvent<HTMLCanvasElement>): [number, number] {
    const canvas = canvasRef.current!;
    const bounds = canvas.getBoundingClientRect();
    return [
      ((event.clientX - bounds.left) * canvas.width) / bounds.width,
      ((event.clientY - bounds.top) * canvas.height) / bounds.height,
    ];
  }

  function pointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (submittingRef.current || signatureViewBusyRef.current || signature.status().busy) return;
    const canvas = canvasRef.current!;
    const context2d = canvas.getContext("2d")!;
    if (signature.status().state !== "empty" && !hasInk.current)
      context2d.clearRect(0, 0, canvas.width, canvas.height);
    signature.invalidate();
    canvas.setPointerCapture?.(event.pointerId);
    const [x, y] = position(event);
    context2d.beginPath();
    context2d.moveTo(x, y);
    context2d.lineWidth = 3;
    context2d.lineCap = "round";
    context2d.strokeStyle = "#134e4a";
    drawing.current = true;
  }

  function pointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const context2d = canvasRef.current!.getContext("2d")!;
    const [x, y] = position(event);
    context2d.lineTo(x, y);
    context2d.stroke();
    hasInk.current = true;
    setSignatureText(say("signature_drawn"));
  }

  async function signatureFile(file: File | undefined) {
    if (!file) return;
    if (file.size > config.limits.signature_bytes || !file.size) {
      showError(config.messages.signature_too_large!);
      return;
    }
    await signatureAction(async () => {
      setSignatureText(say("signature_uploading"));
      await signature.replace(file);
      resetSignatureView();
      setSignatureText(
        signature.status().state === "ready"
          ? say("signature_ready_file", { name: file.name })
          : signature.status().message,
      );
      const canvas = canvasRef.current;
      if (!canvas || typeof createImageBitmap !== "function") return;
      const image = await createImageBitmap(file);
      const scale = Math.min(canvas.width / image.width, canvas.height / image.height);
      canvas
        .getContext("2d")
        ?.drawImage(
          image,
          (canvas.width - image.width * scale) / 2,
          (canvas.height - image.height * scale) / 2,
          image.width * scale,
          image.height * scale,
        );
      image.close();
    });
  }

  // -- review and submission ---------------------------------------------------------------

  async function startReview() {
    if (reviewing) return;
    clearTimeout(validation.current.timer);
    clearErrors();
    if (!rowsRef.current.length) {
      showError(config.messages.expense_count!);
      addExpenseRef.current?.focus();
      return;
    }
    setReviewing(true);
    let valid: boolean;
    try {
      valid = await validateDetails(true);
    } finally {
      setReviewing(false);
    }
    if (!valid) {
      focusInvalid();
      return;
    }
    const current = rowsRef.current;
    if (
      current.some(
        (row) =>
          row.uploading ||
          row.removing ||
          (row.kind !== "mileage" && !row.files.length) ||
          row.files.some((file) => file.state !== "ready"),
      )
    ) {
      showError(say("receipts_missing"));
      return;
    }
    if (
      current.some((row) => {
        const amount = rowAmount(row);
        return amount === null || amount <= 0n;
      })
    ) {
      showError(say("amounts_invalid"));
      return;
    }
    if (
      current.flatMap((row) => row.files).reduce((sum, file) => sum + (file.pages || 0), 0) >
      config.limits.claim_pages
    ) {
      showError(config.messages.claim_pages!);
      return;
    }
    setStep("review");
    setTimeout(() => {
      reviewRef.current?.querySelector<HTMLElement>("h2")?.focus();
      reviewRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    }, 0);
  }

  async function editDetails() {
    clearErrors();
    if (!(await signatureAction(clearSignature))) return;
    setDeclaration(false);
    setPrivacy(false);
    setStep("details");
    setTimeout(() => detailsRef.current?.scrollIntoView?.({ behavior: "smooth" }), 0);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submittingRef.current || signatureViewBusyRef.current || signature.status().busy || step !== "review")
      return;
    clearErrors();
    if (!declaration || !privacy) {
      showError(say("consent_missing"));
      return;
    }
    if (!hasInk.current && !["ready", "pending"].includes(signature.status().state)) {
      showError(say("signature_required"));
      return;
    }
    setSubmitting(true);
    try {
      const signatureId = await signature.ensureReady(
        () => new Promise<Blob | null>((resolve) => canvasRef.current!.toBlob(resolve, "image/png")),
      );
      const result = await formRequest<SubmitAnswer>(
        context,
        `/api/v1/public/forms/${encodeURIComponent(slug)}/submit`,
        {
          method: "POST",
          body: {
            ...detailData(),
            token: context.token,
            signature: signatureId,
            declaration: true,
            privacy_acknowledged: true,
            website,
          },
        },
      );
      accepted.current = true;
      await navigate({ to: "/received/$claimId", params: { claimId: result.claimId } });
    } catch (error) {
      const fields = error instanceof FormRequestError ? error.fields : undefined;
      if (fields && Object.keys(fields).length) {
        try {
          await clearSignature();
        } catch {
          signature.invalidate();
          resetSignatureView();
        }
        setDeclaration(false);
        setPrivacy(false);
        setStep("details");
      }
      showError((error as Error).message, fields);
      setSubmitting(false);
    }
  }

  // Leaving with files or a name entered asks first: the browser for a reload
  // or another site, a confirmation for links inside the app (the footer's privacy link).
  const unsaved = useCallback(
    () =>
      !accepted.current &&
      (rowsRef.current.some((row) => row.files.length) || Boolean(valuesRef.current.full_name)),
    [rowsRef, valuesRef],
  );
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (unsaved()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);
  useBlocker({
    shouldBlockFn: () =>
      unsaved() && !window.confirm(t("Leave this page? Your entries and receipts will be lost.")),
    enableBeforeUnload: false,
  });

  // -- rendering ------------------------------------------------------------------------------

  const field = (
    name: ClaimField,
    label: string,
    options: {
      hint?: string;
      required?: boolean;
      wide?: boolean;
      type?: string;
      autoComplete?: string;
      maxLength?: number;
      spellCheck?: boolean;
      disabled?: boolean;
      multiline?: number;
    } = {},
  ) => {
    const id = `id_${name}`;
    const errorId = `error-${name}`;
    const describedBy = [errorId, options.hint ? `hint-${name}` : ""].filter(Boolean).join(" ");
    const common = {
      id,
      name,
      value: values[name],
      required: options.required !== false,
      disabled: options.disabled,
      "aria-describedby": describedBy,
      "aria-invalid": messages[errorId] ? true : undefined,
      maxLength: options.maxLength,
    };
    return (
      <div className={cn("field flex flex-col gap-1.5", options.wide && "sm:col-span-2")}>
        <label htmlFor={id} className="text-sm font-medium">
          {label}
          {options.required !== false ? (
            <span className="required-mark text-destructive" aria-hidden="true">
              {" "}
              *
            </span>
          ) : null}
        </label>
        {options.multiline ? (
          <Textarea
            {...common}
            rows={options.multiline}
            onChange={(event) => setField(name, event.target.value)}
          />
        ) : (
          <Input
            {...common}
            type={options.type ?? "text"}
            autoComplete={options.autoComplete}
            spellCheck={options.spellCheck}
            onChange={(event) => setField(name, event.target.value)}
          />
        )}
        {options.hint ? (
          <small id={`hint-${name}`} className="text-muted-foreground text-xs">
            {options.hint}
          </small>
        ) : null}
        <FieldMessage id={errorId} message={messages[errorId]} />
      </div>
    );
  };

  const purposeLabel = t("Occasion/connection to the project or event");
  const detailsHint = t("Optional: describe the connection in more detail if needed.");
  const tripFields = (
    <div className="grid gap-5 pt-4 sm:grid-cols-2" id="trip-fields">
      {field("trip_destination", t("Destination"), { wide: true, disabled: !tripNeeded, maxLength: 200 })}
      {field("trip_start", t("Trip start"), { type: "date", disabled: !tripNeeded })}
      {field("trip_end", t("Trip end"), { type: "date", disabled: !tripNeeded })}
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      {page.development ? (
        <Alert>
          <TriangleAlert aria-hidden="true" />
          <AlertDescription>
            {t("Test environment · Please use sample data only. No real emails are sent.")}
          </AlertDescription>
        </Alert>
      ) : null}
      {preview ? (
        <Alert>
          <Eye aria-hidden="true" />
          <AlertDescription>
            {t("Preview · This form is not open. Uploading and submitting are not possible.")}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-col items-start gap-3">
        <Badge variant="outline">{form.name}</Badge>
        <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{form.title}</h1>
        <p className="text-muted-foreground sm:text-lg">
          <Lines text={form.description} />
        </p>
        {form.deadline ? (
          <p className="inline-flex items-center gap-2 text-sm font-medium">
            <CalendarDays className="text-muted-foreground size-4" aria-hidden="true" />
            {form.deadline}
          </p>
        ) : null}
      </div>

      <Alert>
        <Info aria-hidden="true" />
        <AlertTitle>{t("For private individuals only.")}</AlertTitle>
        <AlertDescription>
          {t(
            "This form is for expenses you paid yourself. Organisations and companies, please send us an invoice.",
          )}
        </AlertDescription>
      </Alert>

      <Steps current={step === "details" ? 1 : 2} />

      {form.intro || form.instructions ? (
        <aside className="bg-card flex flex-col gap-2 rounded-xl border p-5 text-sm leading-relaxed shadow-sm">
          {form.intro ? (
            <p>
              <Lines text={form.intro} />
            </p>
          ) : null}
          {form.instructions ? (
            <p>
              <Lines text={form.instructions} />
            </p>
          ) : null}
        </aside>
      ) : null}

      <div
        id="form-error"
        ref={errorRef}
        className="border-destructive/40 bg-destructive/5 text-destructive rounded-lg border px-4 py-3 text-sm font-medium outline-none"
        role="alert"
        tabIndex={-1}
        hidden={!formError}
      >
        {formError}
      </div>

      <form id="claim-form" className="flex flex-col gap-6" noValidate onSubmit={submit}>
        <div className="sr-only" aria-hidden="true">
          <label>
            Website
            <input
              name="website"
              tabIndex={-1}
              autoComplete="off"
              data-honeypot="true"
              value={website}
              onChange={(event) => setWebsite(event.target.value)}
            />
          </label>
        </div>

        <div id="details-panel" ref={detailsRef} className="flex flex-col gap-6" hidden={step !== "details"}>
          <Panel labelledBy="section-details">
            <SectionHeading
              number="01"
              id="section-details"
              title={t("Your details")}
              text={t("For assigning and transferring your reimbursement.")}
            />
            <div className="grid gap-5 p-5 sm:grid-cols-2 sm:p-6">
              {field("full_name", t("First and last name"), { autoComplete: "name", maxLength: 200 })}
              {field("email", t("Email address"), {
                type: "email",
                autoComplete: "email",
                maxLength: 254,
                hint: t("For the confirmation of receipt and questions about your claim."),
              })}
              {field("street", t("Street and house number"), {
                wide: true,
                autoComplete: "address-line1",
                maxLength: 200,
              })}
              <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-4">
                {field("postal_code", t("Postcode"), { autoComplete: "postal-code", maxLength: 12 })}
                {field("city", t("Town or city"), { autoComplete: "address-level2", maxLength: 100 })}
              </div>
              <div className="field flex flex-col gap-1.5">
                <label htmlFor="id_country" className="text-sm font-medium">
                  {t("Country")}
                  <span className="required-mark text-destructive" aria-hidden="true">
                    {" "}
                    *
                  </span>
                </label>
                <NativeSelect
                  id="id_country"
                  name="country"
                  autoComplete="country"
                  value={values.country}
                  required
                  aria-describedby="error-country"
                  aria-invalid={messages["error-country"] ? true : undefined}
                  onChange={(event) => setField("country", event.target.value)}
                >
                  {page.countries.map(([code, name]) => (
                    <NativeSelectOption key={code} value={code}>
                      {name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <FieldMessage id="error-country" message={messages["error-country"]} />
              </div>
              {field("account_holder", t("Account holder"), {
                autoComplete: "off",
                maxLength: 200,
                hint: t("The name the account is held in."),
              })}
              {field("iban", t("IBAN"), {
                autoComplete: "off",
                spellCheck: false,
                maxLength: 60,
                hint: t("IBANs from other countries are possible too."),
              })}
              {field("bic", t("BIC"), {
                autoComplete: "off",
                spellCheck: false,
                maxLength: 20,
                required: false,
                hint: t("Only needed for accounts outside the SEPA area."),
              })}
            </div>
          </Panel>

          <Panel labelledBy="section-purpose">
            <SectionHeading
              number="02"
              id="section-purpose"
              title={t("Reason for the reimbursement")}
              text={t("What were the expenses for?")}
            />
            <div className="flex flex-col gap-5 p-5 sm:p-6">
              {terms.fixedPurpose ? (
                <>
                  <div className="field flex flex-col gap-1.5">
                    <span className="text-sm font-medium">{purposeLabel}</span>
                    <p className="bg-muted/50 rounded-lg p-4">{terms.fixedPurpose}</p>
                    <input type="hidden" name="purpose" id="id_purpose" value={terms.fixedPurpose} />
                    <FieldMessage id="error-purpose" message={messages["error-purpose"]} />
                  </div>
                  {field("purpose_details", t("Additional details (optional)"), {
                    required: false,
                    multiline: 3,
                    maxLength: 3000,
                    hint: detailsHint,
                  })}
                </>
              ) : terms.purposeOptions.length ? (
                <>
                  <fieldset className="field choice-list flex flex-col gap-3">
                    <legend id="purpose-legend" className="mb-3 text-sm font-medium">
                      {purposeLabel}{" "}
                      <span className="required-mark text-destructive" aria-hidden="true">
                        *
                      </span>
                    </legend>
                    <RadioGroup
                      name="purpose"
                      required
                      value={values.purpose}
                      aria-labelledby="purpose-legend"
                      aria-describedby="error-purpose"
                      aria-invalid={messages["error-purpose"] ? true : undefined}
                      onValueChange={(value) => setField("purpose", value)}
                    >
                      {terms.purposeOptions.map((option, index) => (
                        <div key={option} className="flex items-center gap-2">
                          <RadioGroupItem id={`id_purpose_${index}`} value={option} />
                          <label htmlFor={`id_purpose_${index}`} className="text-sm">
                            {option}
                          </label>
                        </div>
                      ))}
                    </RadioGroup>
                    <FieldMessage id="error-purpose" message={messages["error-purpose"]} />
                  </fieldset>
                  {field("purpose_details", t("Additional details (optional)"), {
                    required: false,
                    multiline: 3,
                    maxLength: 3000,
                    hint: detailsHint,
                  })}
                </>
              ) : (
                field("purpose", purposeLabel, { multiline: 4, maxLength: 3000 })
              )}
            </div>
          </Panel>

          <Panel labelledBy="section-expenses">
            <SectionHeading
              number="03"
              id="section-expenses"
              title={t("Expenses & receipts")}
              text={t("Add one or more items. All amounts in euros.")}
            />
            <div className="flex flex-col gap-4 p-5 sm:p-6">
              <p className="text-muted-foreground flex items-start gap-2 text-sm">
                <Paperclip className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>{config.messages.upload_hint}</span>
              </p>
              {rows.length ? null : (
                <p id="expenses-empty" className="text-muted-foreground text-sm">
                  {terms.mileageRate ? say("expenses_empty_mileage") : say("expenses_empty")}
                </p>
              )}
              <div id="expenses" className="flex flex-col gap-4">
                {rows.map((row, index) => (
                  <ExpenseCard
                    key={row.id}
                    row={row}
                    index={index}
                    count={rows.length}
                    config={config}
                    messages={messages}
                    mileageText={mileageText(row)}
                    onChange={(name, value) => changeRow(row, name, value)}
                    onMove={(delta) => moveRow(index, delta)}
                    onRemove={() => void removeRow(row)}
                    onFiles={(files) => void addFiles(row, files)}
                    onMoveFile={(position, delta) => moveFile(row, position, delta)}
                    onRemoveFile={(file) => void removeFile(row, file)}
                    onRetryFile={(file) => void retryFile(row, file)}
                  />
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  ref={addExpenseRef}
                  type="button"
                  variant="outline"
                  id="add-expense"
                  disabled={rows.length >= config.limits.expenses}
                  onClick={() => addRow("receipt")}
                >
                  <Plus aria-hidden="true" />
                  {t("Expense with receipt")}
                </Button>
                {terms.mileageRate ? (
                  <Button
                    type="button"
                    variant="outline"
                    id="add-mileage"
                    disabled={rows.length >= config.limits.expenses}
                    onClick={() => addRow("mileage")}
                  >
                    <Plus aria-hidden="true" />
                    {t("Mileage claim")}
                  </Button>
                ) : null}
              </div>
              {terms.travel === "optional" ? (
                <details
                  id="receipt-travel"
                  className="rounded-lg border p-4"
                  hidden={!travelShown}
                  open={tripOpen}
                  onToggle={(event) => {
                    setTripOpen((event.currentTarget as HTMLDetailsElement).open);
                    validation.current.version += 1;
                    clearTimeout(validation.current.timer);
                    validation.current.timer = setTimeout(() => void validateDetails(), 650);
                  }}
                >
                  <summary className="cursor-pointer text-sm font-medium">
                    {t("Add travel details for expenses with receipts (optional)")}
                  </summary>
                  {tripFields}
                </details>
              ) : terms.travel === "required" ? (
                <div id="receipt-travel" className="rounded-lg border p-4" hidden={!travelShown}>
                  <p className="text-sm font-medium">{t("Travel details for expenses with receipts")}</p>
                  {tripFields}
                </div>
              ) : null}
              <div className="totals flex flex-col gap-1 border-t pt-4" id="totals" aria-live="polite">
                <div className="flex items-center justify-between gap-4 font-semibold">
                  <span className="total-caption">{say("total")}</span>
                  <span>{money(total)}</span>
                </div>
                {duplicateReference ? (
                  <p className="text-muted-foreground text-sm">{say("duplicate_reference")}</p>
                ) : null}
              </div>
              <FieldMessage id="error-__all__" message={messages["error-__all__"]} />
            </div>
          </Panel>

          <div className="flex flex-col-reverse items-start justify-between gap-4 sm:flex-row sm:items-center">
            <TrustedText
              as="p"
              className="text-muted-foreground text-sm"
              html={t(
                '<span aria-hidden="true">*</span> Required fields<br>Until you submit, your details stay only in this open form.',
              )}
            />
            <Button
              type="button"
              size="lg"
              id="review-button"
              className="w-full px-6 sm:w-auto"
              disabled={reviewing}
              onClick={() => void startReview()}
            >
              <TrustedText html={t('Review details <span aria-hidden="true">→</span>')} />
            </Button>
          </div>
        </div>

        <div id="review-panel" ref={reviewRef} className="flex flex-col gap-6" hidden={step !== "review"}>
          <Panel labelledBy="section-review">
            <SectionHeading
              number="04"
              id="section-review"
              title={t("Check your details")}
              text={t("Once submitted, you can no longer change the claim.")}
            />
            <div className="flex flex-col gap-4 p-5 sm:p-6">
              <div id="review-content">{step === "review" ? <ReviewContent /> : null}</div>
              <Button
                type="button"
                variant="outline"
                id="edit-button"
                className="w-fit"
                disabled={signatureDisabled}
                onClick={() => void editDetails()}
              >
                <ArrowLeft aria-hidden="true" />
                {t("Edit details")}
              </Button>
            </div>
          </Panel>

          <Panel labelledBy="section-declaration">
            <SectionHeading
              number={<PenLine className="size-4" aria-hidden="true" />}
              id="section-declaration"
              title={t("Declaration & signature")}
            />
            <div className="flex flex-col gap-5 p-5 sm:p-6">
              <p className="declaration-text bg-muted/60 rounded-lg p-4 text-sm leading-relaxed">
                {terms.declaration}
              </p>
              <div className="flex items-start gap-2">
                <Checkbox
                  id="declaration"
                  name="declaration"
                  required
                  checked={declaration}
                  disabled={submitting}
                  onCheckedChange={(checked) => setDeclaration(checked === true)}
                />
                <label htmlFor="declaration" className="text-sm font-medium">
                  {t("I confirm the declaration. *")}
                </label>
              </div>
              <div className="signature-section flex flex-col gap-2">
                <label className="text-sm font-medium" htmlFor="signature-canvas">
                  {t("Sign here")}
                </label>
                <canvas
                  id="signature-canvas"
                  ref={canvasRef}
                  width={800}
                  height={240}
                  aria-label={t("Drawing area for your signature")}
                  className="bg-background w-full touch-none rounded-lg border"
                  style={{ aspectRatio: "800 / 240" }}
                  onPointerDown={pointerDown}
                  onPointerMove={pointerMove}
                  onPointerUp={() => (drawing.current = false)}
                  onPointerCancel={() => (drawing.current = false)}
                />
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <Button
                    type="button"
                    variant="link"
                    id="clear-signature"
                    className="text-button h-auto p-0"
                    disabled={signatureDisabled}
                    onClick={() => void signatureAction(clearSignature)}
                  >
                    {t("Clear signature")}
                  </Button>
                  <label
                    className={cn(
                      "signature-file border-input bg-background hover:bg-accent inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium shadow-xs",
                      "focus-within:ring-ring/50 focus-within:ring-[3px]",
                      signatureDisabled && "pointer-events-none opacity-50",
                    )}
                  >
                    <Upload className="size-4" aria-hidden="true" />
                    {t("Or upload it as an image")}
                    <input
                      ref={signatureFileRef}
                      type="file"
                      id="signature-file"
                      accept="image/png,image/jpeg"
                      className="sr-only"
                      disabled={signatureDisabled}
                      onChange={(event) => void signatureFile(event.target.files?.[0])}
                    />
                  </label>
                </div>
                <Button
                  type="button"
                  variant="link"
                  id="retry-signature"
                  className="text-button h-auto w-fit p-0"
                  hidden={!signatureStatus.canRetry}
                  disabled={signatureDisabled}
                  onClick={() => void signatureAction(() => signature.retry())}
                >
                  {t("Check status again")}
                </Button>
                <p id="signature-status" className="text-muted-foreground text-sm" aria-live="polite">
                  {signatureText}
                </p>
              </div>
            </div>
          </Panel>

          <Panel labelledBy="section-privacy" className="privacy">
            <SectionHeading
              number={<ShieldCheck className="size-4" aria-hidden="true" />}
              id="section-privacy"
              title={t("Privacy")}
            />
            <div className="flex flex-col gap-4 p-5 text-sm leading-relaxed sm:p-6">
              <p>
                {t(
                  "We process your details, receipts and signature to reimburse your expenses. We delete the PDF 7 days after it reaches accounting, and all other data in the portal 90 days after submission.",
                )}
              </p>
              <details className="group rounded-lg border">
                <summary className="hover:bg-accent/50 cursor-pointer px-4 py-3 font-medium">
                  {t("Read the full privacy notice")}
                </summary>
                <div className="privacy-text max-h-96 overflow-y-auto border-t px-4 py-4">
                  <Paragraphs text={terms.privacyText} />
                </div>
              </details>
              <div className="flex items-start gap-2">
                <Checkbox
                  id="privacy_acknowledged"
                  name="privacy_acknowledged"
                  required
                  checked={privacy}
                  disabled={submitting}
                  onCheckedChange={(checked) => setPrivacy(checked === true)}
                />
                <label htmlFor="privacy_acknowledged" className="font-medium">
                  <PrivacyConsent />
                </label>
              </div>
            </div>
          </Panel>

          <div className="flex flex-col-reverse items-start justify-between gap-4 sm:flex-row sm:items-center">
            <p className="text-muted-foreground text-sm">
              {t("Submitting makes your claim binding. Accounting reviews it and makes the payment.")}
            </p>
            <Button
              type="submit"
              size="lg"
              id="submit-button"
              className="w-full px-6 sm:w-auto"
              disabled={preview || submitting || signatureStatus.busy || signatureViewBusy}
            >
              {submitting ? (
                say("submitting")
              ) : (
                <TrustedText html={t('Submit claim <span aria-hidden="true">→</span>')} />
              )}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );

  function mileageText(row: Row): string {
    if (row.kind !== "mileage" || rateCents === null) return "";
    const amount = rowAmount(row);
    if (amount === null) return "";
    const distance = Number(row.values.distance_km) * (row.values.round_trip ? 2 : 1);
    return `${distance} km × ${money(rateCents)} = ${money(amount)}`;
  }

  function ReviewContent() {
    const entries: Array<[string, string]> = [];
    for (const name of CLAIM_FIELDS) {
      if (TRIP_FIELDS.includes(name) && !tripNeeded) continue;
      let value = values[name];
      if (name === "country") value = page.countries.find(([code]) => code === value)?.[1] ?? value;
      else if ((name === "trip_start" || name === "trip_end") && value)
        value = formatDate(config.date_format, value);
      // The name's label is "review_name" (0.4 showed the key "review_full_name" here).
      if (value) entries.push([say(name === "full_name" ? "review_name" : `review_${name}`), value]);
    }
    return (
      <div className="flex flex-col gap-4 text-sm">
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          {entries.map(([label, value]) => (
            <ReviewEntry key={label} label={label} value={value} />
          ))}
        </dl>
        {rows.map((row, index) => {
          const amount = money(rowAmount(row) ?? 0n);
          const data = row.values;
          return (
            <div key={row.id} className="review-expense bg-muted/40 flex flex-col gap-1 rounded-lg p-3">
              {row.kind === "mileage" ? (
                <>
                  <p className="review-title font-medium">
                    {`${index + 1}. ${say(data.round_trip ? "review_trip_return" : "review_trip", {
                      start: String(data.route_from),
                      end: String(data.route_to),
                    })} · ${amount}`}
                  </p>
                  <p>
                    {[
                      say("review_outward", {
                        date: formatDate(config.date_format, String(data.travel_date)),
                      }),
                      ...(data.round_trip
                        ? [
                            say("review_return", {
                              date: formatDate(config.date_format, String(data.return_date)),
                            }),
                          ]
                        : []),
                      say("review_registration", { plate: String(data.vehicle_registration) }),
                    ].join(" · ")}
                  </p>
                </>
              ) : (
                <>
                  <p className="review-title font-medium">{`${index + 1}. ${String(data.merchant)} · ${amount}`}</p>
                  {String(data.receipt_reference).trim() ? (
                    <p>{say("review_reference", { reference: String(data.receipt_reference) })}</p>
                  ) : null}
                </>
              )}
              {row.files.length ? (
                <small className="text-muted-foreground">
                  {row.files.map((file) => file.name).join(" · ")}
                </small>
              ) : null}
            </div>
          );
        })}
        <p className="totals font-semibold">{say("review_total", { amount: money(total) })}</p>
      </div>
    );
  }
}

function ReviewEntry({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-words">{value}</dd>
    </>
  );
}

/** "I have read the privacy notice. *" with the notice linked (it opens in a new tab). */
function PrivacyConsent() {
  const t = useT();
  return (
    <TrustedText
      className="[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4"
      html={t(
        'I have read the <a class="ui-link" href="{url}" target="_blank" rel="noopener">privacy notice</a>. *',
        {
          url: "/datenschutz/",
        },
      )}
    />
  );
}

/**
 * A text of the app's own dictionary with its markup (Django's t_html): the
 * markup is the app's, never a participant's or an admin's.
 */
function TrustedText({
  html,
  className,
  as = "span",
}: {
  html: string;
  className?: string;
  as?: "span" | "p";
}) {
  const Element = as;
  return <Element className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
