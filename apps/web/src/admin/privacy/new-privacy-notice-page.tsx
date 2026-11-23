import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@meldgrove/ui/button";
import { Card, CardContent } from "@meldgrove/ui/card";
import { Page, PageHeader } from "@meldgrove/ui/page";
import { ErrorState, LoadingState } from "@meldgrove/ui/states";
import { Textarea } from "@meldgrove/ui/textarea";
import { api, errorMessage } from "@/lib/api";
import { newPrivacyNoticeQuery } from "../api";
import { FormRow, fieldErrors } from "../parts";

/** A new version of the privacy notice, starting from the current text. */
export function NewPrivacyNoticePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = useQuery(newPrivacyNoticeQuery);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (query.data && text === null) setText(query.data.text);
  }, [query.data, text]);
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const created = await api.post<{ version: number }>("/admin/privacy-notices", { text: text ?? "" });
      toast.success(`Version ${created.version} of the privacy notice was saved.`);
      await queryClient.invalidateQueries({ queryKey: ["admin"] });
      await navigate({ to: "/admin/privacy-notice" });
    } catch (failure) {
      setError(fieldErrors(failure).text ?? errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page className="max-w-4xl">
      <PageHeader title="New version" description="Privacy notice. Participants see it at once." />
      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Card>
          <CardContent>
            <FormRow
              label="Text"
              required
              help="A blank line separates paragraphs. A line starting with “# ” becomes a heading."
              error={error}
            >
              {(props) => (
                <Textarea
                  {...props}
                  rows={18}
                  value={text ?? ""}
                  onChange={(event) => setText(event.target.value)}
                />
              )}
            </FormRow>
          </CardContent>
        </Card>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>
            Save
          </Button>
          <Button variant="outline" asChild>
            <Link to="/admin/privacy-notice">Cancel</Link>
          </Button>
        </div>
      </form>
    </Page>
  );
}
