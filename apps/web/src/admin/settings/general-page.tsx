import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@meldgrove/ui/alert";
import { Button } from "@meldgrove/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@meldgrove/ui/card";
import { FieldGroup } from "@meldgrove/ui/field";
import { NativeSelect, NativeSelectOption } from "@meldgrove/ui/native-select";
import { Page, PageHeader } from "@meldgrove/ui/page";
import { ErrorState, LoadingState } from "@meldgrove/ui/states";
import type {
  FilterOption,
  GeneralSettingsForm,
  GeneralSettingsPage,
} from "@reimbursements/shared/api/admin";
import { api, ApiError, errorMessage } from "@/lib/api";
import { metaQuery } from "@/lib/meta";
import { generalQuery } from "../api";
import { DetailList, FormRow, fieldErrors } from "../parts";

/** Admin › General (template admins): the app language, timezone, date and number format. */
export function GeneralPage() {
  const query = useQuery(generalQuery);
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return <General page={query.data} />;
}

function Select({
  label,
  help,
  error,
  value,
  options,
  onChange,
}: {
  label: string;
  help: string;
  error?: string;
  value: string;
  options: FilterOption[];
  onChange: (value: string) => void;
}) {
  return (
    <FormRow label={label} help={help} error={error}>
      {(props) => (
        <NativeSelect {...props} value={value} onChange={(event) => onChange(event.target.value)}>
          {options.map((option) => (
            <NativeSelectOption key={option.value} value={option.value}>
              {option.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      )}
    </FormRow>
  );
}

function General({ page }: { page: GeneralSettingsPage }) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<GeneralSettingsForm>(page.settings);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setValues(page.settings), [page.settings]);
  const set = (changes: Partial<GeneralSettingsForm>) => setValues((current) => ({ ...current, ...changes }));

  const submit = async () => {
    setBusy(true);
    setErrors({});
    setProblem("");
    try {
      const saved = await api.put<GeneralSettingsPage & { message: string }>(
        "/admin/settings/general",
        values,
      );
      toast.success(saved.message);
      queryClient.setQueryData(generalQuery.queryKey, saved);
      await queryClient.invalidateQueries({ queryKey: metaQuery.queryKey });
      await queryClient.invalidateQueries({ queryKey: ["admin"] });
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

  return (
    <Page className="max-w-3xl">
      <PageHeader
        title="General"
        description="Settings for the whole app. The admin area is always in English."
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
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Language and formats</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Select
                label="App language"
                help="For public forms, emails to participants and Finance, and the claim PDF. The admin area is always in English."
                error={errors.language}
                value={values.language}
                options={page.choices.languages}
                onChange={(language) => set({ language: language as GeneralSettingsForm["language"] })}
              />
              <Select
                label="Timezone"
                help="Times are shown in this timezone, and form opening times are entered in it."
                error={errors.timezone}
                value={values.timezone}
                options={page.choices.timezones}
                onChange={(timezone) => set({ timezone })}
              />
              <Select
                label="Date format"
                help="For dates everywhere, including the admin area and the claim PDF."
                error={errors.dateFormat}
                value={values.dateFormat}
                options={page.choices.dateFormats}
                onChange={(dateFormat) => set({ dateFormat })}
              />
              <Select
                label="Number format"
                help="The decimal separator of amounts everywhere, including the admin area and the claim PDF. Participants may type amounts with either separator."
                error={errors.numberFormat}
                value={values.numberFormat}
                options={page.choices.numberFormats}
                onChange={(numberFormat) => set({ numberFormat })}
              />
            </FieldGroup>
          </CardContent>
        </Card>
        <Card className="gap-0 pb-0">
          <CardHeader className="border-b pb-4">
            <CardTitle>
              <h2>Version</h2>
            </CardTitle>
          </CardHeader>
          <DetailList rows={[["Running version", page.version]]} />
        </Card>
        <div>
          <Button type="submit" disabled={busy}>
            Save
          </Button>
        </div>
      </form>
    </Page>
  );
}
