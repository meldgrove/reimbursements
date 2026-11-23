import { useState } from "react";
import { useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, CircleAlert, Plus, Trash2, X } from "lucide-react";
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
import {
  TRAVEL_LABELS,
  type TemplateDetail,
  type TemplateFieldInput,
  type TemplateInput,
  type Travel,
} from "@reimbursements/shared/api/admin";
import { api, ApiError, errorMessage } from "@/lib/api";
import { templateQuery } from "../api";
import { FormRow, fieldErrors, useRecordName } from "../parts";

/** A template and its fields (template admins; the list is in the Admin group). */
export function TemplatePage() {
  const params = useParams({ strict: false }) as { templateId?: string };
  const id = params.templateId ? Number(params.templateId) : null;
  const query = useQuery(templateQuery(id));
  if (id !== null && !Number.isInteger(id)) return <ErrorState error={new Error("Not found")} />;
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return <TemplateEditor key={id ?? "new"} detail={query.data} />;
}

const emptyField = (position: number): TemplateFieldInput => ({
  position,
  label: "",
  key: "",
  kind: "text",
  choices: "",
  pattern: "",
  required: true,
});

function TemplateEditor({ detail }: { detail: TemplateDetail }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [values, setValues] = useState<TemplateInput>(detail.template);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  useRecordName(pathname, detail.id ? detail.template.name : null);
  const readOnly = !detail.canChange;
  const set = (changes: Partial<TemplateInput>) => setValues((current) => ({ ...current, ...changes }));
  const setField = (index: number, changes: Partial<TemplateFieldInput>) =>
    set({ fields: values.fields.map((field, at) => (at === index ? { ...field, ...changes } : field)) });
  const move = (index: number, by: number) => {
    const fields = [...values.fields];
    const [field] = fields.splice(index, 1);
    fields.splice(index + by, 0, field!);
    set({ fields: fields.map((item, position) => ({ ...item, position })) });
  };
  const fieldError = (index: number, name: string) => errors[`fields.${index}.${name}`];

  const submit = async () => {
    setBusy(true);
    setErrors({});
    setProblem("");
    try {
      const saved = detail.id
        ? await api.put<TemplateDetail>(`/admin/templates/${detail.id}`, values)
        : await api.post<TemplateDetail>("/admin/templates", values);
      toast.success(`The template “${saved.template.name}” was saved.`);
      await queryClient.invalidateQueries({ queryKey: ["admin"] });
      if (!detail.id)
        await navigate({ to: "/admin/templates/$templateId", params: { templateId: String(saved.id) } });
      else setValues(saved.template);
    } catch (error) {
      setErrors(fieldErrors(error));
      setProblem(
        error instanceof ApiError && error.status === 422
          ? "Please correct the errors below."
          : errorMessage(error),
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    try {
      await api.delete(`/admin/templates/${detail.id}`);
      toast.success(`The template “${detail.template.name}” was deleted.`);
      await queryClient.invalidateQueries({ queryKey: ["admin"] });
      await navigate({ to: "/admin/templates" });
    } catch (error) {
      toast.error(errorMessage(error));
      throw error;
    }
  };

  return (
    <Page className="max-w-5xl">
      <PageHeader
        title={detail.id ? detail.template.name : "Add template"}
        description={
          detail.id
            ? `Template · used by ${detail.forms} ${detail.forms === 1 ? "form" : "forms"}`
            : "Template"
        }
        actions={
          detail.canDelete ? (
            <Button variant="outline" size="sm" onClick={() => setDeleting(true)}>
              <Trash2 />
              Delete
            </Button>
          ) : null
        }
      />
      {problem ? (
        <Alert variant="destructive" role="alert">
          <CircleAlert />
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      ) : null}
      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <fieldset disabled={readOnly} className="contents">
          <Card>
            <CardContent>
              <FieldGroup>
                <FormRow label="Name" required error={errors.name}>
                  {(props) => (
                    <Input
                      {...props}
                      maxLength={200}
                      value={values.name}
                      onChange={(event) => set({ name: event.target.value })}
                    />
                  )}
                </FormRow>
                <FormRow label="Internal description" error={errors.description}>
                  {(props) => (
                    <Textarea
                      {...props}
                      rows={3}
                      value={values.description}
                      onChange={(event) => set({ description: event.target.value })}
                    />
                  )}
                </FormRow>
              </FieldGroup>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>For participants</h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <FieldGroup>
                <FormRow
                  label="Notes for participants"
                  help="Shown at the top of every form of this template."
                  error={errors.intro}
                >
                  {(props) => (
                    <Textarea
                      {...props}
                      rows={3}
                      value={values.intro}
                      onChange={(event) => set({ intro: event.target.value })}
                    />
                  )}
                </FormRow>
                <FormRow label="Travel details (destination, dates)" error={errors.travel}>
                  {(props) => (
                    <NativeSelect
                      {...props}
                      value={values.travel}
                      onChange={(event) => set({ travel: event.target.value as Travel })}
                    >
                      {(Object.keys(TRAVEL_LABELS) as Travel[]).map((travel) => (
                        <NativeSelectOption key={travel} value={travel}>
                          {TRAVEL_LABELS[travel]}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  )}
                </FormRow>
                <div className="flex items-center gap-3">
                  <Checkbox
                    id="template-mileage"
                    checked={values.mileageEnabled}
                    onCheckedChange={(value) => set({ mileageEnabled: value === true })}
                  />
                  <Label htmlFor="template-mileage">Allow mileage reimbursement</Label>
                </div>
                <FormRow label="Mileage rate in EUR" required error={errors.mileageRate}>
                  {(props) => (
                    <Input
                      {...props}
                      inputMode="decimal"
                      className="w-32"
                      value={values.mileageRate}
                      onChange={(event) => set({ mileageRate: event.target.value })}
                    />
                  )}
                </FormRow>
              </FieldGroup>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>Declaration</h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <FieldGroup>
                <FormRow label="Declaration" required error={errors.declaration}>
                  {(props) => (
                    <Textarea
                      {...props}
                      rows={4}
                      value={values.declaration}
                      onChange={(event) => set({ declaration: event.target.value })}
                    />
                  )}
                </FormRow>
                <FormRow label="Declaration version" required error={errors.declarationVersion}>
                  {(props) => (
                    <Input
                      {...props}
                      maxLength={80}
                      value={values.declarationVersion}
                      onChange={(event) => set({ declarationVersion: event.target.value })}
                    />
                  )}
                </FormRow>
              </FieldGroup>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>Fields</h2>
              </CardTitle>
              <CardDescription>
                Internal values each form of this template sets, e.g. KST, KTR or an ID. Participants never
                see them; they are printed in the PDF.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {values.fields.length === 0 ? (
                <p className="text-muted-foreground text-sm">No fields yet.</p>
              ) : null}
              {values.fields.map((field, index) => (
                <fieldset key={field.id ?? `new-${index}`} className="grid gap-4 rounded-lg border p-4">
                  <legend className="sr-only">Field {index + 1}</legend>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <FormRow
                      label="Label"
                      required
                      help="e.g. Kostenstelle (KST)"
                      error={fieldError(index, "label")}
                    >
                      {(props) => (
                        <Input
                          {...props}
                          maxLength={80}
                          value={field.label}
                          onChange={(event) => setField(index, { label: event.target.value })}
                        />
                      )}
                    </FormRow>
                    <FormRow
                      label="Key"
                      required
                      help="Technical name, e.g. kst. Do not change it later."
                      error={fieldError(index, "key")}
                    >
                      {(props) => (
                        <Input
                          {...props}
                          maxLength={40}
                          value={field.key}
                          onChange={(event) => setField(index, { key: event.target.value })}
                        />
                      )}
                    </FormRow>
                    <FormRow label="Type" error={fieldError(index, "kind")}>
                      {(props) => (
                        <NativeSelect
                          {...props}
                          value={field.kind}
                          onChange={(event) =>
                            setField(index, { kind: event.target.value as "text" | "choice" })
                          }
                        >
                          <NativeSelectOption value="text">Text</NativeSelectOption>
                          <NativeSelectOption value="choice">Choice</NativeSelectOption>
                        </NativeSelect>
                      )}
                    </FormRow>
                    <FormRow
                      label="Format (regular expression)"
                      help="Optional, e.g. \d{4} for four-digit numbers."
                      error={fieldError(index, "pattern")}
                    >
                      {(props) => (
                        <Input
                          {...props}
                          maxLength={200}
                          className="font-mono"
                          value={field.pattern}
                          onChange={(event) => setField(index, { pattern: event.target.value })}
                        />
                      )}
                    </FormRow>
                  </div>
                  {field.kind === "choice" ? (
                    <FormRow
                      label="Options"
                      help="Only for choices: one option per line."
                      error={fieldError(index, "choices")}
                    >
                      {(props) => (
                        <Textarea
                          {...props}
                          rows={3}
                          value={field.choices}
                          onChange={(event) => setField(index, { choices: event.target.value })}
                        />
                      )}
                    </FormRow>
                  ) : null}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-3">
                      <Checkbox
                        id={`field-required-${index}`}
                        checked={field.required}
                        onCheckedChange={(value) => setField(index, { required: value === true })}
                      />
                      <Label htmlFor={`field-required-${index}`}>Required</Label>
                    </div>
                    <div className="flex gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                      >
                        <ArrowUp />
                        <span className="sr-only">Move field {index + 1} up</span>
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={index === values.fields.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        <ArrowDown />
                        <span className="sr-only">Move field {index + 1} down</span>
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          set({
                            fields: values.fields
                              .filter((_, at) => at !== index)
                              .map((item, position) => ({ ...item, position })),
                          })
                        }
                      >
                        <X />
                        Remove
                      </Button>
                    </div>
                  </div>
                </fieldset>
              ))}
              {readOnly ? null : (
                <div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => set({ fields: [...values.fields, emptyField(values.fields.length)] })}
                  >
                    <Plus />
                    Add field
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </fieldset>
        {readOnly ? null : (
          <div>
            <Button type="submit" disabled={busy}>
              Save
            </Button>
          </div>
        )}
      </form>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete “${detail.template.name}”?`}
        description="The template and its fields are deleted permanently. This cannot be undone."
        confirmLabel="Delete template"
        destructive
        onConfirm={remove}
      />
    </Page>
  );
}
