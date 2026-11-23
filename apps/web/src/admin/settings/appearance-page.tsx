import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@meldgrove/ui/alert";
import { Button } from "@meldgrove/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@meldgrove/ui/card";
import { Checkbox } from "@meldgrove/ui/checkbox";
import { FieldGroup } from "@meldgrove/ui/field";
import { Input } from "@meldgrove/ui/input";
import { Label } from "@meldgrove/ui/label";
import { Page, PageHeader } from "@meldgrove/ui/page";
import { ErrorState, LoadingState } from "@meldgrove/ui/states";
import { normalize, STANDARD_ACCENT } from "@reimbursements/shared/theme";
import type { AppearancePage as Appearance } from "@reimbursements/shared/api/admin";
import { apiUrl, ApiError, errorMessage, parseResponse } from "@/lib/api";
import { metaQuery } from "@/lib/meta";
import { appearanceQuery } from "../api";
import { FormRow, fieldErrors } from "../parts";

/** Admin › Appearance (template admins): the accent color and the favicon, on every page. */
export function AppearancePage() {
  const query = useQuery(appearanceQuery);
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return <AppearanceForm page={query.data} />;
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <span
        className="size-5 shrink-0 rounded border border-black/20"
        style={{ background: color }}
        aria-hidden="true"
      />
      {label} <code className="font-mono">{color}</code>
    </span>
  );
}

function AppearanceForm({ page }: { page: Appearance }) {
  const queryClient = useQueryClient();
  const [accent, setAccent] = useState(page.accentColor);
  const [remove, setRemove] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState("");
  const [warning, setWarning] = useState(page.warning ?? "");
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => setAccent(page.accentColor), [page.accentColor]);

  const submit = async () => {
    setBusy(true);
    setErrors({});
    setProblem("");
    setWarning("");
    try {
      const body = new FormData();
      body.set("accentColor", accent);
      if (remove) body.set("removeFavicon", "true");
      const chosen = file.current?.files?.[0];
      if (chosen) body.set("favicon", chosen);
      const response = await fetch(apiUrl("/admin/settings/appearance"), {
        method: "POST",
        credentials: "same-origin",
        headers: { accept: "application/json" },
        body,
      });
      const saved = await parseResponse<Appearance & { message: string }>(response);
      toast.success(saved.message);
      setWarning(saved.warning ?? "");
      setRemove(false);
      if (file.current) file.current.value = "";
      queryClient.setQueryData(appearanceQuery.queryKey, saved);
      await queryClient.invalidateQueries({ queryKey: metaQuery.queryKey });
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
      <PageHeader title="Appearance" description="How public pages and the admin area look." />
      {problem ? (
        <Alert variant="destructive" role="alert">
          <CircleAlert />
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      ) : null}
      {warning ? (
        <Alert>
          <TriangleAlert />
          <AlertDescription>{warning}</AlertDescription>
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
              <h2>Accent color</h2>
            </CardTitle>
            <CardDescription>
              Buttons, links, focus rings and selected items, on public pages and in the admin area.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <FormRow
                label="Hex code"
                help="Such as #0f766e. Leave empty for the colors every Meldgrove app shares. Dark mode lightens it as needed so it stays readable."
                error={errors.accentColor}
              >
                {(props) => (
                  <div className="flex items-center gap-2">
                    <Input
                      {...props}
                      className="max-w-40 font-mono"
                      placeholder={STANDARD_ACCENT}
                      value={accent}
                      onChange={(event) => setAccent(event.target.value)}
                    />
                    <input
                      type="color"
                      aria-label="Pick the accent color"
                      title="Pick a color"
                      value={normalize(accent) ?? STANDARD_ACCENT}
                      onChange={(event) => setAccent(event.target.value)}
                      className="border-input bg-background focus-visible:ring-ring/50 h-9 w-12 shrink-0 cursor-pointer rounded-md border p-1 shadow-xs outline-none focus-visible:ring-[3px]"
                    />
                  </div>
                )}
              </FormRow>
              <div className="grid gap-2 text-sm">
                <span className="text-muted-foreground">In use</span>
                <span>{page.inUse.custom ? "Custom color" : "Meldgrove standard"}</span>
                <span className="flex flex-wrap gap-x-6 gap-y-2">
                  <Swatch color={page.inUse.light} label="Light mode" />
                  <Swatch color={page.inUse.dark} label="Dark mode" />
                </span>
              </div>
            </FieldGroup>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Favicon</h2>
            </CardTitle>
            <CardDescription>
              The icon in browser tabs, on public pages and in the admin area.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <div className="grid gap-2 text-sm">
                <span className="text-muted-foreground">Current favicon</span>
                <span className="inline-flex items-center gap-3">
                  <img
                    src={page.favicon.url}
                    alt=""
                    width={32}
                    height={32}
                    className="bg-background size-8 rounded-md border object-contain"
                  />
                  {page.favicon.custom ? "Custom favicon" : "Standard favicon"}
                </span>
              </div>
              <FormRow
                label="New favicon"
                help="PNG, ICO, SVG or WebP, at most 100 KB. Square images of at least 32 × 32 pixels look best."
                error={errors.favicon}
              >
                {(props) => (
                  <Input
                    {...props}
                    ref={file}
                    type="file"
                    accept="image/png,image/x-icon,image/vnd.microsoft.icon,image/svg+xml,image/webp,.ico"
                  />
                )}
              </FormRow>
              {page.favicon.custom ? (
                <div className="flex items-center gap-3">
                  <Checkbox
                    id="remove-favicon"
                    checked={remove}
                    onCheckedChange={(value) => setRemove(value === true)}
                  />
                  <Label htmlFor="remove-favicon">Use the standard favicon</Label>
                </div>
              ) : null}
            </FieldGroup>
          </CardContent>
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
