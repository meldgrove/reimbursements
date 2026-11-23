import { useEffect, useRef, useState, type ReactNode } from "react";
import { useBlocker, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  CircleAlert,
  CircleCheck,
  Info,
  LoaderCircle,
  PenLine,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@meldgrove/ui/alert";
import { Button } from "@meldgrove/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@meldgrove/ui/card";
import { Checkbox } from "@meldgrove/ui/checkbox";
import { ConfirmDialog } from "@meldgrove/ui/confirm-dialog";
import { FieldGroup } from "@meldgrove/ui/field";
import { Input } from "@meldgrove/ui/input";
import { Label } from "@meldgrove/ui/label";
import { NativeSelect, NativeSelectOption } from "@meldgrove/ui/native-select";
import { Page, PageHeader } from "@meldgrove/ui/page";
import { ErrorState, LoadingState } from "@meldgrove/ui/states";
import { Textarea } from "@meldgrove/ui/textarea";
import { cn } from "@meldgrove/ui/utils";
import {
  FORM_STATUS_LABELS,
  FORM_STATUS_TONES,
  type DateTimeInput,
  type FormEditor,
  type FormStatus,
} from "@reimbursements/shared/api/admin";
import { api, errorMessage } from "@/lib/api";
import { formRoute } from "../routes";
import { formEditorQuery } from "../api";
import { FormRow, ToneBadge, useRecordName } from "../parts";
import { useFormAutosave, type SaveState } from "./autosave";
import { editorKey, forgetEditor, keepEditor } from "./editor-key";
import { NewFormPage } from "./new-form-page";

/**
 * A form's settings (the Django admin's form page), saved as one types:
 * name and link, start page and opening times, the internal values of its
 * template, the texts for participants, and where claims go. Publishing
 * needs complete settings; a draft may have gaps.
 */
export function FormPage() {
  const { formId } = formRoute.useParams();
  const { template } = formRoute.useSearch();
  if (formId === "new" && !template) return <NewFormPage />;
  return <EditorLoader formId={formId} template={template} />;
}

function EditorLoader({ formId, template }: { formId: string; template?: number }) {
  // The source stays when the first save gives a new form its address.
  const [source] = useState(() => (formId === "new" ? { template: template! } : { id: Number(formId) }));
  const query = useQuery(formEditorQuery(source));
  if (formId !== "new" && !/^\d+$/.test(formId)) return <ErrorState error={new Error("Not found")} />;
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return <Editor editor={query.data} editorKey={editorKey(formId, template)} />;
}

const SAVE_ICONS: Record<SaveState, ReactNode> = {
  idle: <Info className="size-4" />,
  pending: <PenLine className="size-4" />,
  saving: <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />,
  saved: <CircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" />,
  error: <CircleAlert className="text-destructive size-4" />,
};

function Editor({ editor, editorKey: key }: { editor: FormEditor; editorKey: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  /** Navigation the editor itself starts (its new address, after deleting): never asked about. */
  const ownNavigation = useRef(false);
  const own = (go: () => Promise<void>) => {
    ownNavigation.current = true;
    return go().finally(() => {
      ownNavigation.current = false;
    });
  };
  const autosave = useFormAutosave(editor, {
    onCreated: (form) => {
      keepEditor(form.id, key);
      void own(() =>
        navigate({
          to: "/admin/forms/$formId",
          params: { formId: String(form.id) },
          search: {},
          replace: true,
        }),
      );
    },
  });
  // Links, shortcuts and Back stay in the page: ask before they drop unsaved changes.
  const blocker = useBlocker({
    shouldBlockFn: () => !ownNavigation.current && autosave.unsaved(),
    enableBeforeUnload: false,
    withResolver: true,
  });
  const { settings, form, errors, update } = autosave;
  const [deleting, setDeleting] = useState(false);
  useRecordName(pathname, form ? settings.name || form.name : null);
  const formId = form?.id;
  useEffect(
    () => () => {
      if (formId) forgetEditor(formId);
    },
    [formId],
  );
  const status: FormStatus = form?.status ?? "draft";
  const archived = status === "archived";

  const remove = async () => {
    try {
      await api.delete(`/admin/forms/${form!.id}`);
      toast.success(`The ${archived ? "archived form" : "draft"} “${form!.name}” was deleted.`);
      await queryClient.invalidateQueries({ queryKey: ["admin"] });
      await own(() => navigate({ to: "/admin/forms" }));
    } catch (error) {
      toast.error(errorMessage(error));
      throw error;
    }
  };

  const valueError = (key: string) => errors[`values.${key}`];
  const time = (name: "opensAt" | "closesAt", part: keyof DateTimeInput, value: string) =>
    update({ [name]: { ...settings[name], [part]: value } });

  return (
    <Page className="max-w-4xl">
      <PageHeader
        title={settings.name || form?.name || "Add form"}
        description="Form"
        actions={
          <>
            {archived ? null : (
              <Button
                size="sm"
                disabled={autosave.publishing}
                onClick={() => autosave.publish(status === "published" ? "unpublish" : "publish")}
              >
                {status === "published" ? "Unpublish" : "Publish"}
              </Button>
            )}
            {form ? (
              <Button variant="outline" size="sm" asChild>
                <a href={form.link} target="_blank" rel="noopener">
                  Preview
                </a>
              </Button>
            ) : null}
            {form ? (
              <Button
                variant="outline"
                size="sm"
                disabled={autosave.publishing}
                onClick={() => autosave.publish(archived ? "unarchive" : "archive")}
              >
                {archived ? <ArchiveRestore /> : <Archive />}
                {archived ? "Unarchive" : "Archive"}
              </Button>
            ) : null}
            {form?.canDelete ? (
              <Button variant="outline" size="sm" onClick={() => setDeleting(true)}>
                <Trash2 />
                Delete
              </Button>
            ) : null}
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <ToneBadge tone={FORM_STATUS_TONES[status]}>{FORM_STATUS_LABELS[status]}</ToneBadge>
        <span
          className={cn(
            "text-muted-foreground inline-flex items-center gap-1.5 text-sm",
            autosave.state === "error" && "text-destructive",
          )}
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-save-state={autosave.state}
        >
          {SAVE_ICONS[autosave.state]}
          <span>{autosave.message}</span>
        </span>
        {autosave.retryVisible ? (
          <Button variant="outline" size="sm" onClick={autosave.retry}>
            Try again
          </Button>
        ) : null}
      </div>
      {autosave.summary ? (
        <Alert variant="destructive" role="alert">
          <CircleAlert />
          <AlertDescription>{autosave.summary}</AlertDescription>
        </Alert>
      ) : null}
      {editor.invalidValues.length > 0 && status === "published" ? (
        <Alert>
          <TriangleAlert />
          <AlertDescription>
            The template was changed. The form stays closed until these internal values fit:{" "}
            {editor.invalidValues.join(", ")}.
          </AlertDescription>
        </Alert>
      ) : null}
      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          autosave.saveNow();
        }}
      >
        <Card>
          <CardContent>
            <FieldGroup>
              <div className="grid gap-1 text-sm">
                <span className="text-muted-foreground">Template</span>
                <span className="font-medium">{editor.template.name}</span>
              </div>
              <FormRow label="Name" required help="Visible to participants." error={errors.name}>
                {(props) => (
                  <Input
                    {...props}
                    name="name"
                    maxLength={200}
                    value={settings.name}
                    onChange={(event) => update({ name: event.target.value })}
                  />
                )}
              </FormRow>
              <FormRow
                label="Short name for the link"
                required
                help="The link is /f/short-name/. Do not change it once shared."
                error={errors.slug}
              >
                {(props) => (
                  <Input
                    {...props}
                    name="slug"
                    maxLength={50}
                    value={settings.slug}
                    onChange={(event) => update({ slug: event.target.value })}
                  />
                )}
              </FormRow>
              <div className="flex items-start gap-3">
                <Checkbox
                  id="form-primary"
                  name="primary"
                  checked={settings.primary}
                  disabled={!editor.canChoosePrimary}
                  onCheckedChange={(value) => update({ primary: value === true })}
                />
                <div className="grid gap-1">
                  <Label htmlFor="form-primary">Start page</Label>
                  <p className="text-muted-foreground text-sm">
                    The start page redirects to this form while it is open. Only one form can be the start
                    page.
                    {editor.canChoosePrimary ? "" : " Only template admins choose it."}
                  </p>
                </div>
              </div>
              <TimeRow
                label="Opens"
                value={settings.opensAt}
                error={errors.opensAt}
                editor={editor}
                onChange={(part, value) => time("opensAt", part, value)}
              />
              <TimeRow
                label="Closes"
                value={settings.closesAt}
                error={errors.closesAt}
                editor={editor}
                onChange={(part, value) => time("closesAt", part, value)}
              />
              {form ? (
                <div className="grid gap-1 text-sm">
                  <span className="text-muted-foreground">Link</span>
                  <a
                    href={form.link}
                    target="_blank"
                    rel="noopener"
                    className="font-medium break-all underline-offset-4 hover:underline"
                  >
                    {new URL(form.link, window.location.origin).href}
                  </a>
                </div>
              ) : null}
            </FieldGroup>
          </CardContent>
        </Card>
        {editor.template.fields.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>Internal values</h2>
              </CardTitle>
              <CardDescription>Not visible to participants; printed in the PDF.</CardDescription>
            </CardHeader>
            <CardContent>
              <FieldGroup>
                {editor.template.fields.map((field) => (
                  <FormRow
                    key={field.key}
                    label={field.label}
                    required={field.required}
                    error={valueError(field.key)}
                  >
                    {(props) =>
                      field.kind === "choice" ? (
                        <NativeSelect
                          {...props}
                          name={`values.${field.key}`}
                          value={settings.values[field.key] ?? ""}
                          onChange={(event) =>
                            update({ values: { ...settings.values, [field.key]: event.target.value } })
                          }
                        >
                          <NativeSelectOption value="">—</NativeSelectOption>
                          {field.options.map((option) => (
                            <NativeSelectOption key={option} value={option}>
                              {option}
                            </NativeSelectOption>
                          ))}
                        </NativeSelect>
                      ) : (
                        <Input
                          {...props}
                          name={`values.${field.key}`}
                          maxLength={200}
                          value={settings.values[field.key] ?? ""}
                          onChange={(event) =>
                            update({ values: { ...settings.values, [field.key]: event.target.value } })
                          }
                        />
                      )
                    }
                  </FormRow>
                ))}
              </FieldGroup>
            </CardContent>
          </Card>
        ) : null}
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>For participants</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <FormRow
                label="Title"
                help="Heading above the form. Leave empty for the standard title."
                error={errors.title}
              >
                {(props) => (
                  <Input
                    {...props}
                    name="title"
                    maxLength={200}
                    placeholder={editor.standardTitle}
                    value={settings.title}
                    onChange={(event) => update({ title: event.target.value })}
                  />
                )}
              </FormRow>
              <FormRow
                label="Description"
                help="Text below the title. Leave empty for the standard description."
                error={errors.description}
              >
                {(props) => (
                  <Textarea
                    {...props}
                    name="description"
                    rows={3}
                    placeholder={editor.standardDescription}
                    value={settings.description}
                    onChange={(event) => update({ description: event.target.value })}
                  />
                )}
              </FormRow>
              <FormRow label="Notes for participants" error={errors.instructions}>
                {(props) => (
                  <Textarea
                    {...props}
                    name="instructions"
                    rows={3}
                    value={settings.instructions}
                    onChange={(event) => update({ instructions: event.target.value })}
                  />
                )}
              </FormRow>
              <FormRow
                label="Preset purposes"
                help="One option per line. A single preset is shown as text; with several, participants choose one. Additional details are optional. Leave empty for free text."
                error={errors.purposeOptions}
              >
                {(props) => (
                  <Textarea
                    {...props}
                    name="purposeOptions"
                    rows={3}
                    value={settings.purposeOptions}
                    onChange={(event) => update({ purposeOptions: event.target.value })}
                  />
                )}
              </FormRow>
              {editor.template.travel !== "off" ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormRow label="Trip start (preset)" error={errors.tripStart}>
                    {(props) => (
                      <Input
                        {...props}
                        name="tripStart"
                        inputMode="numeric"
                        placeholder={editor.datePattern}
                        value={settings.tripStart}
                        onChange={(event) => update({ tripStart: event.target.value })}
                      />
                    )}
                  </FormRow>
                  <FormRow label="Trip end (preset)" error={errors.tripEnd}>
                    {(props) => (
                      <Input
                        {...props}
                        name="tripEnd"
                        inputMode="numeric"
                        placeholder={editor.datePattern}
                        value={settings.tripEnd}
                        onChange={(event) => update({ tripEnd: event.target.value })}
                      />
                    )}
                  </FormRow>
                </div>
              ) : null}
            </FieldGroup>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Delivery and contact</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <FormRow label="Receiving inbox (accounting)" required error={errors.recipient}>
                {(props) => (
                  <NativeSelect
                    {...props}
                    name="recipient"
                    value={settings.recipient}
                    onChange={(event) => update({ recipient: event.target.value })}
                  >
                    <NativeSelectOption value="">—</NativeSelectOption>
                    {editor.recipients.map((address) => (
                      <NativeSelectOption key={address} value={address}>
                        {address}
                      </NativeSelectOption>
                    ))}
                    {settings.recipient && !editor.recipients.includes(settings.recipient) ? (
                      <NativeSelectOption value={settings.recipient}>
                        {settings.recipient} (not approved)
                      </NativeSelectOption>
                    ) : null}
                  </NativeSelect>
                )}
              </FormRow>
              <FormRow label="Contact for questions" required error={errors.supportEmail}>
                {(props) => (
                  <Input
                    {...props}
                    name="supportEmail"
                    type="email"
                    maxLength={254}
                    value={settings.supportEmail}
                    onChange={(event) => update({ supportEmail: event.target.value })}
                  />
                )}
              </FormRow>
            </FieldGroup>
          </CardContent>
        </Card>
      </form>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete “${form?.name ?? ""}” for good?`}
        description={`The ${archived ? "archived form" : "draft"} and its form link are deleted permanently. This cannot be undone.`}
        confirmLabel={`Delete ${archived ? "archived form" : "draft"} for good`}
        destructive
        onConfirm={remove}
      />
      <ConfirmDialog
        open={blocker.status === "blocked"}
        onOpenChange={(open) => {
          if (!open) blocker.reset?.();
        }}
        title="Leave without saving?"
        description="Your latest changes are not saved yet. If you leave this page now, they are lost."
        confirmLabel="Leave without saving"
        destructive
        onConfirm={() => blocker.proceed?.()}
      />
    </Page>
  );
}

/** An opening time: the date in the app date format and the time, in the app timezone. */
function TimeRow({
  label,
  value,
  error,
  editor,
  onChange,
}: {
  label: string;
  value: DateTimeInput;
  error?: string;
  editor: FormEditor;
  onChange: (part: keyof DateTimeInput, value: string) => void;
}) {
  return (
    <FormRow
      label={label}
      help={`Date (${editor.datePattern}) and time, in ${editor.timezone}.`}
      error={error}
    >
      {(props) => (
        <div className="flex flex-wrap gap-2">
          <Input
            {...props}
            aria-label={`${label}: date`}
            inputMode="numeric"
            className="w-40"
            placeholder={editor.datePattern}
            value={value.date}
            onChange={(event) => onChange("date", event.target.value)}
          />
          <Input
            aria-label={`${label}: time`}
            aria-invalid={props["aria-invalid"]}
            inputMode="numeric"
            className="w-28"
            placeholder="HH:MM"
            value={value.time}
            onChange={(event) => onChange("time", event.target.value)}
          />
        </div>
      )}
    </FormRow>
  );
}
