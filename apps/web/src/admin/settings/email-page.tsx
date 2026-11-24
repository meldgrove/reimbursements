import { useEffect, useId, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Send } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@meldgrove/ui/alert";
import { Button } from "@meldgrove/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@meldgrove/ui/card";
import { Checkbox } from "@meldgrove/ui/checkbox";
import { FieldError, FieldGroup } from "@meldgrove/ui/field";
import { Input } from "@meldgrove/ui/input";
import { Label } from "@meldgrove/ui/label";
import { NativeSelect, NativeSelectOption } from "@meldgrove/ui/native-select";
import { Page, PageHeader } from "@meldgrove/ui/page";
import { SecretInput } from "@meldgrove/ui/secret-input";
import { ErrorState, LoadingState } from "@meldgrove/ui/states";
import { Textarea } from "@meldgrove/ui/textarea";
import type {
  EmailSecretName,
  EmailSettingsForm,
  EmailSettingsPage,
  EmailTestAnswer,
  FilterOption,
} from "@reimbursements/shared/api/admin";
import { api, ApiError, errorMessage } from "@/lib/api";
import { emailQuery } from "../api";
import { FormRow, ToneBadge, fieldErrors } from "../parts";

/**
 * Admin › Email (template admins): the provider that sends email to Finance and to
 * participants, its credentials, the participant confirmation, and a test email
 * (portal/admin_email.py of the Django version). A saved secret is never shown again:
 * its field stays empty, and typing a new one replaces it. The operator sets the same
 * settings with `cli settings apply email`.
 */
export function EmailPage() {
  const query = useQuery(emailQuery);
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return <EmailSettings page={query.data} />;
}

type Values = {
  provider: string;
  fromAddress: string;
  replyToAddress: string;
  smtpHost: string;
  smtpPort: string;
  smtpSecurity: string;
  smtpUsername: string;
  confirmationEnabled: boolean;
  confirmation: Record<string, { subject: string; body: string }>;
};

const SECRET_LABELS: Record<EmailSecretName, [label: string, deleteLabel: string]> = {
  mailersendToken: ["API token", "Delete the saved API token"],
  webhookSecret: ["Webhook signing secret", "Delete the saved signing secret"],
  smtpPassword: ["Password", "Delete the saved password"],
};
const DELETE_FIELDS = {
  mailersendToken: "deleteMailersendToken",
  webhookSecret: "deleteWebhookSecret",
  smtpPassword: "deleteSmtpPassword",
} as const satisfies Record<EmailSecretName, keyof EmailSettingsForm>;
const NO_SECRETS: Record<EmailSecretName, string> = {
  mailersendToken: "",
  webhookSecret: "",
  smtpPassword: "",
};
const NO_DELETIONS: Record<EmailSecretName, boolean> = {
  mailersendToken: false,
  webhookSecret: false,
  smtpPassword: false,
};
const STATUS_TONES = { local: "secondary", ready: "success", not_set_up: "warning" } as const;

function valuesOf(page: EmailSettingsPage): Values {
  return { ...page.settings, smtpPort: String(page.settings.smtpPort) };
}

function Select({
  label,
  help,
  error,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  help?: string;
  error?: string;
  value: string;
  options: FilterOption[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <FormRow label={label} help={help} error={error}>
      {(props) => (
        <NativeSelect
          {...props}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
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

/** A labelled checkbox with its error. */
function CheckboxRow({
  label,
  checked,
  error,
  onChange,
}: {
  label: string;
  checked: boolean;
  error?: string;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-3">
        <Checkbox
          id={id}
          checked={checked}
          aria-invalid={error ? true : undefined}
          onCheckedChange={(value) => onChange(value === true)}
        />
        <Label htmlFor={id}>{label}</Label>
      </div>
      {error ? <FieldError>{error}</FieldError> : null}
    </div>
  );
}

/** A text with the webhook address in code, as the Django page showed it. */
function WithCode({ text, code }: { text: string; code: string }) {
  const at = code ? text.indexOf(code) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <code className="font-mono break-all">{code}</code>
      {text.slice(at + code.length)}
    </>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{title}</h2>
        </CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>
        <FieldGroup>{children}</FieldGroup>
      </CardContent>
    </Card>
  );
}

function EmailSettings({ page }: { page: EmailSettingsPage }) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Values>(() => valuesOf(page));
  const [secrets, setSecrets] = useState(NO_SECRETS);
  const [deletions, setDeletions] = useState(NO_DELETIONS);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setValues(valuesOf(page)), [page]);
  const set = (changes: Partial<Values>) => setValues((current) => ({ ...current, ...changes }));
  const setText = (code: string, part: "subject" | "body", text: string) =>
    setValues((current) => ({
      ...current,
      confirmation: {
        ...current.confirmation,
        [code]: { ...(current.confirmation[code] ?? { subject: "", body: "" }), [part]: text },
      },
    }));

  const submit = async () => {
    setBusy(true);
    setErrors({});
    setProblem("");
    const body: EmailSettingsForm = {
      ...values,
      ...secrets,
      deleteMailersendToken: deletions.mailersendToken,
      deleteWebhookSecret: deletions.webhookSecret,
      deleteSmtpPassword: deletions.smtpPassword,
    };
    try {
      const saved = await api.put<EmailSettingsPage>("/admin/settings/email", body);
      toast.success(saved.message ?? "The email settings were saved.");
      setSecrets(NO_SECRETS);
      setDeletions(NO_DELETIONS);
      queryClient.setQueryData(emailQuery.queryKey, saved);
      // The forms list says whether forms take claims, which depends on email.
      await queryClient.invalidateQueries({ queryKey: ["admin", "forms"] });
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

  const secretField = (name: EmailSecretName) => {
    const state = page.secrets[name];
    const [label, deleteLabel] = SECRET_LABELS[name];
    return (
      <div key={name} className="grid gap-3">
        <FormRow label={label} error={errors[name]}>
          {(props) => (
            <SecretInput
              {...props}
              name={name}
              autoComplete="new-password"
              maxLength={1000}
              placeholder={state.placeholder || undefined}
              value={secrets[name]}
              onChange={(event) => setSecrets((current) => ({ ...current, [name]: event.target.value }))}
            />
          )}
        </FormRow>
        {state.deletable ? (
          <CheckboxRow
            label={deleteLabel}
            checked={deletions[name]}
            error={errors[DELETE_FIELDS[name]]}
            onChange={(checked) => setDeletions((current) => ({ ...current, [name]: checked }))}
          />
        ) : null}
      </div>
    );
  };

  const languages = page.choices.languages;
  return (
    <Page className="max-w-3xl">
      <PageHeader title="Email" description="How the app sends email to Finance and to participants." />
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
        <Section title="Status">
          <div className="flex flex-col items-start gap-2 text-sm" data-testid="email-status">
            <ToneBadge tone={STATUS_TONES[page.status.state]}>{page.status.label}</ToneBadge>
            <span>{page.status.text}</span>
            {page.status.warning ? (
              <span className="text-muted-foreground">{page.status.warning}</span>
            ) : null}
            {page.status.unreadable ? (
              <span className="text-destructive">{page.status.unreadable}</span>
            ) : null}
            {page.environmentNote ? (
              <span className="text-muted-foreground" data-testid="environment-note">
                {page.environmentNote}
              </span>
            ) : null}
          </div>
        </Section>

        <Section title="Sending">
          <Select
            label="Send email with"
            error={errors.provider}
            value={values.provider}
            options={page.choices.providers}
            onChange={(provider) => set({ provider })}
          />
          <FormRow
            label="Sender address"
            help="Every email comes from this address. With MailerSend, it must be on a verified domain."
            error={errors.fromAddress}
          >
            {(props) => (
              <Input
                {...props}
                type="email"
                maxLength={254}
                value={values.fromAddress}
                onChange={(event) => set({ fromAddress: event.target.value })}
              />
            )}
          </FormRow>
          <FormRow
            label="Reply address for Finance"
            help="Replies to claim emails sent to Finance go here. Replies to participant confirmations go to each form's contact."
            error={errors.replyToAddress}
          >
            {(props) => (
              <Input
                {...props}
                type="email"
                maxLength={254}
                value={values.replyToAddress}
                onChange={(event) => set({ replyToAddress: event.target.value })}
              />
            )}
          </FormRow>
        </Section>

        {values.provider === "mailersend" ? (
          <Section
            title="MailerSend"
            description="Sends through the MailerSend API and learns from its webhook whether each email was delivered."
          >
            <div className="grid gap-2 text-sm">
              <span className="font-medium">Webhook</span>
              <span className="text-muted-foreground">
                <WithCode text={page.webhook.text} code={page.webhook.url} />
              </span>
            </div>
            {secretField("mailersendToken")}
            {secretField("webhookSecret")}
          </Section>
        ) : null}

        {values.provider === "smtp" ? (
          <Section
            title="SMTP server"
            description="SMTP reports no deliveries or bounces back to the app: an email counts as delivered once the server accepts it, and bounces go to the sender address."
          >
            <FormRow label="Server" help="Such as smtp.example.org." error={errors.smtpHost}>
              {(props) => (
                <Input
                  {...props}
                  maxLength={253}
                  autoComplete="off"
                  spellCheck={false}
                  value={values.smtpHost}
                  onChange={(event) => set({ smtpHost: event.target.value })}
                />
              )}
            </FormRow>
            <FormRow label="Port" error={errors.smtpPort}>
              {(props) => (
                <Input
                  {...props}
                  type="number"
                  min={1}
                  max={65535}
                  className="max-w-32"
                  value={values.smtpPort}
                  onChange={(event) => set({ smtpPort: event.target.value })}
                />
              )}
            </FormRow>
            <Select
              label="Encryption"
              error={errors.smtpSecurity}
              value={values.smtpSecurity}
              options={page.choices.securities}
              onChange={(smtpSecurity) => set({ smtpSecurity })}
            />
            <FormRow
              label="Username"
              help="Leave empty for a server without login."
              error={errors.smtpUsername}
            >
              {(props) => (
                <Input
                  {...props}
                  maxLength={254}
                  autoComplete="off"
                  spellCheck={false}
                  value={values.smtpUsername}
                  onChange={(event) => set({ smtpUsername: event.target.value })}
                />
              )}
            </FormRow>
            {secretField("smtpPassword")}
          </Section>
        ) : null}

        <Section
          title="Confirmation of receipt"
          description={
            <>
              Participants receive it once their claim is accepted, in the language they saw, without receipts
              or banking details. Placeholders:{" "}
              {page.placeholders.map((placeholder, index) => (
                <span key={placeholder.name}>
                  {index ? ", " : ""}
                  <code className="font-mono">{`{${placeholder.name}}`}</code> {placeholder.description}
                </span>
              ))}
              .
            </>
          }
        >
          <CheckboxRow
            label="Send participants a confirmation of receipt"
            checked={values.confirmationEnabled}
            error={errors.confirmationEnabled}
            onChange={(confirmationEnabled) => set({ confirmationEnabled })}
          />
          {languages.map((language) => {
            const texts = values.confirmation[language.value] ?? { subject: "", body: "" };
            return (
              <div key={language.value} className="grid gap-6">
                <FormRow
                  label={`Subject (${language.label})`}
                  help="Empty restores the standard subject."
                  error={errors[`confirmation.${language.value}.subject`]}
                >
                  {(props) => (
                    <Input
                      {...props}
                      maxLength={200}
                      value={texts.subject}
                      onChange={(event) => setText(language.value, "subject", event.target.value)}
                    />
                  )}
                </FormRow>
                <FormRow
                  label={`Text (${language.label})`}
                  help="Empty restores the standard text."
                  error={errors[`confirmation.${language.value}.body`]}
                >
                  {(props) => (
                    <Textarea
                      {...props}
                      rows={14}
                      maxLength={5000}
                      value={texts.body}
                      onChange={(event) => setText(language.value, "body", event.target.value)}
                    />
                  )}
                </FormRow>
              </div>
            );
          })}
        </Section>
        <div>
          <Button type="submit" disabled={busy}>
            Save
          </Button>
        </div>
      </form>
      <TestEmail recipient={page.testRecipient} />
    </Page>
  );
}

/** The test email: its own form, so it sends with what is saved. */
function TestEmail({ recipient }: { recipient: string }) {
  const [to, setTo] = useState(recipient);
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState<EmailTestAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();

  const send = async () => {
    setBusy(true);
    setError("");
    setOutcome(null);
    try {
      const answer = await api.post<EmailTestAnswer>("/admin/settings/email/test", { to });
      if (answer.reached) toast.success(answer.message);
      setOutcome(answer);
    } catch (failure) {
      const fields = fieldErrors(failure);
      setError(fields.to ?? errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Test email</h2>
          </CardTitle>
          <CardDescription>
            Sends one email with the saved settings, so save your changes first.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Label htmlFor={id}>Send a test email to</Label>
              <Input
                id={id}
                type="email"
                required
                aria-invalid={error ? true : undefined}
                value={to}
                onChange={(event) => setTo(event.target.value)}
              />
            </div>
            <Button type="submit" variant="outline" disabled={busy}>
              <Send />
              Send test email
            </Button>
          </div>
          {error ? <FieldError>{error}</FieldError> : null}
          {outcome && !outcome.reached ? (
            <Alert variant="destructive" role="alert">
              <CircleAlert />
              <AlertDescription>{outcome.message}</AlertDescription>
            </Alert>
          ) : null}
          {outcome?.reached ? (
            <p className="text-muted-foreground text-sm" role="status">
              {outcome.message}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </form>
  );
}
