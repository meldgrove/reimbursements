import { Lock } from "lucide-react";
import { Badge } from "@meldgrove/ui/badge";
import { useT } from "@/i18n";

/**
 * A form that takes no claims now (portal/templates/portal/closed.html): its
 * name for published forms only, and why, when it is open but cannot take
 * this participant.
 */
export function ClosedPage({ name, message }: { name: string | null; message: string | null }) {
  const t = useT();
  return (
    <section className="bg-card text-card-foreground flex flex-col items-center gap-4 rounded-xl border px-6 py-12 text-center shadow-sm">
      <span className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
        <Lock className="size-6" aria-hidden="true" />
      </span>
      {name ? <Badge variant="outline">{name}</Badge> : null}
      <h1 className="text-2xl font-semibold tracking-tight">{t("Form closed")}</h1>
      <p className="text-muted-foreground max-w-md">
        {message ??
          t(
            "This reimbursement form is not accepting new claims at the moment. If you have questions, please contact the contact given.",
          )}
      </p>
    </section>
  );
}
