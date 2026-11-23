/**
 * The operators' commands of the back office (the Django version's management
 * commands claim_status, purge_expired, reconcile_deliveries, retry_claim,
 * seed_demo, verify_storage and run_jobs; verify-setup is in setup-check.ts).
 * None prints addresses or banking details.
 */
import { once } from "node:events";
import os from "node:os";
import { parseArgs } from "node:util";
import { and, asc, count, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { config } from "../config";
import { claims, deliveries, formTemplates, forms, jobs, uploads } from "../db/schema";
import { atomic, q } from "../db/tx";
import {
  annotate,
  CHOICES,
  CLAIM_STATE_LABELS,
  forReference,
  of,
  STATUS,
  type AnnotatedClaim,
} from "../services/claim-status";
import { reconcile } from "../services/evidence";
import { claimReference } from "../services/documents";
import { ActionRefused, retry } from "../services/operations";
import * as queue from "../services/queue";
import { queueAgeSeconds } from "../services/readiness";
import { cleanup } from "../services/retention";
import { verify } from "../services/storage";
import { isEmail } from "@reimbursements/shared/email";
import { SetupCheck } from "../services/setup-check";
import { recipientApproved } from "../services/outbound";
import { runJobs } from "../worker";
import { CommandError, option, registerCommand } from "./registry";

export { CommandError };

const out = (line: string) => process.stdout.write(`${line}\n`);

/** Writes a line, waiting while stdout's buffer is full (a pipe to a slow reader). */
async function write(line: string): Promise<void> {
  if (!process.stdout.write(`${line}\n`)) await once(process.stdout, "drain");
}

/** How many claims claim-status reads at once (the Django version iterated in chunks of 100). */
export const claimStatusPage = { size: 100 };

/** The value of `name` that must be one of `choices`. */
function choice(args: string[], name: string, choices: readonly string[]): string | undefined {
  const value = option(args, name);
  if (value !== undefined && !choices.includes(value)) {
    throw new CommandError(`${name} must be one of ${choices.join(", ")}.`);
  }
  return value;
}

/** Positional arguments: those that are no option and no option's value. */
function positional(args: string[], valued: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (valued.includes(argument)) index += 1;
    else if (!argument.startsWith("--")) result.push(argument);
  }
  return result;
}

registerCommand("claim-status", {
  usage:
    "claim-status [<reference>] [--status <s>] [--state <s>] [--delivery-state <s>]  claims and queue as JSON lines",
  run: async (args) => {
    const [reference] = positional(args, ["--status", "--state", "--delivery-state"]);
    const status = choice(
      args,
      "--status",
      CHOICES.map(([code]) => code),
    );
    const state = choice(
      args,
      "--state",
      CLAIM_STATE_LABELS.map(([code]) => code),
    );
    const deliveryState = option(args, "--delivery-state");
    const conditions: SQL[] = [];
    if (reference) conditions.push(forReference(reference));
    if (status) conditions.push(sql`${STATUS} = ${status}`);
    if (state) conditions.push(eq(claims.state, state));
    if (deliveryState !== undefined) conditions.push(eq(deliveries.state, deliveryState));
    // A page at a time in the list's order, each after the last claim written;
    // its exact time comes from the database (a Date keeps milliseconds only).
    let after: SQL | undefined;
    for (;;) {
      const page = await q()
        .select({ id: claims.id, submittedAt: sql<string>`${claims.submittedAt}::text` })
        .from(claims)
        .leftJoin(deliveries, eq(deliveries.claimId, claims.id))
        .where(and(...conditions, after))
        .orderBy(asc(claims.submittedAt), asc(claims.id))
        .limit(claimStatusPage.size);
      if (page.length === 0) break;
      for (const claim of await annotate(
        inArray(
          claims.id,
          page.map((row) => row.id),
        ),
      )) {
        await writeClaim(claim);
      }
      if (page.length < claimStatusPage.size) break;
      const last = page.at(-1)!;
      after = sql`(${claims.submittedAt}, ${claims.id}) > (${last.submittedAt}::timestamptz, ${last.id}::uuid)`;
    }
    const jobsIn = async (value: string) =>
      Number((await q().select({ value: count() }).from(jobs).where(eq(jobs.state, value)))[0]?.value ?? 0);
    await write(
      JSON.stringify({
        pending_jobs: await jobsIn(queue.PENDING),
        failed_jobs: await jobsIn(queue.FAILED),
        oldest_job_age_seconds: await queueAgeSeconds(),
      }),
    );
  },
});

/** One claim-status line: no addresses, no banking details. */
async function writeClaim(claim: AnnotatedClaim): Promise<void> {
  const current = await of(claim);
  await write(
    JSON.stringify({
      reference: claimReference(claim),
      status: current.code,
      state: claim.state,
      submitted_at: claim.submittedAt.toISOString(),
      delivery_state: claim.delivery ? claim.delivery.state : null,
      error_code: current.errorCode,
      resolution_overdue: current.overdue,
      archived: current.archived,
    }),
  );
}

registerCommand("purge-expired", {
  usage: "purge-expired [--execute]               preview due deletions, or carry them out",
  run: async (args) => {
    out(JSON.stringify(await cleanup({ execute: args.includes("--execute") })));
  },
});

registerCommand("reconcile-deliveries", {
  usage: "reconcile-deliveries [--batch-size <n>]  ask MailerSend about unsettled emails; never resends",
  run: async (args) => {
    const raw = option(args, "--batch-size") ?? "100";
    const batchSize = /^-?\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!(batchSize >= 1 && batchSize <= 1000))
      throw new CommandError("batch-size must be between 1 and 1000");
    const counts = await reconcile(batchSize);
    out(JSON.stringify(counts));
    if (counts.failed) throw new CommandError(`Provider lookup failed for ${counts.failed} emails.`);
  },
});

/** retry-claim's messages for the refusals (retry_claim.py of the Django version). */
const RETRY_MESSAGES: Record<string, string> = {
  active_job: "This claim already has an active job.",
  duplicate_risk:
    "Check provider activity first. Use --acknowledge-duplicate-risk for an intentional resend.",
  not_retryable: "This claim cannot be retried in its current state.",
  pdf_removed: "The PDF of this claim was already deleted.",
};

function currentUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER ?? "operator";
  }
}

registerCommand("retry-claim", {
  usage:
    "retry-claim <reference> --reason <text> [--actor <name>] [--acknowledge-duplicate-risk]  build or send a claim's PDF again",
  run: async (args) => {
    const usage =
      "Usage: retry-claim <reference> --reason <text> [--actor <name>] [--acknowledge-duplicate-risk]";
    // Parsed once, as Django's argparse did: an option's missing value is an error, not the next flag.
    let parsed;
    try {
      parsed = parseArgs({
        args,
        allowPositionals: true,
        options: {
          reason: { type: "string" },
          actor: { type: "string" },
          "acknowledge-duplicate-risk": { type: "boolean" },
        },
      });
    } catch {
      throw new CommandError(usage);
    }
    const [reference, ...extra] = parsed.positionals;
    const { reason, actor } = parsed.values;
    if (!reference || extra.length || reason === undefined) throw new CommandError(usage);
    try {
      const claim = await retry(reference, {
        actor: actor ?? currentUser(),
        reason,
        acknowledgeDuplicateRisk: parsed.values["acknowledge-duplicate-risk"] ?? false,
      });
      out(`Queued retry for ${claimReference(claim)}.`);
    } catch (error) {
      if (error instanceof ActionRefused) throw new CommandError(RETRY_MESSAGES[error.code] ?? error.message);
      throw error;
    }
  },
});

const DEMO_PURPOSES = [
  "Teilnahme an der Werkstatt zur Förderung des bürgerschaftlichen Engagements",
  "Mitwirkung als Referent:in in der Werkstatt",
];

registerCommand("seed-demo", {
  usage: "seed-demo                               the demo form at /f/demo/ (local development only)",
  run: async () => {
    const settings = config();
    if (!settings.isDevelopment || settings.MAIL_DELIVERY_MODE !== "local") {
      throw new CommandError("Demo data is allowed only in local development.");
    }
    const created = await atomic(async () => {
      const [template] = await q()
        .select()
        .from(formTemplates)
        .where(eq(formTemplates.name, "Externe Erstattung"));
      if (!template) throw new CommandError("Run migrations first; they create the default template.");
      const [existing] = await q().select({ id: forms.id }).from(forms).where(eq(forms.slug, "demo"));
      if (existing) return false;
      await q()
        .insert(forms)
        .values({
          templateId: template.id,
          slug: "demo",
          name: "Demo-Veranstaltung",
          fieldValues: { kst: "DEMO", ktr: "DEMO-2026", id: "WS-1" },
          purposeOptions: DEMO_PURPOSES.join("\n"),
          instructions:
            "Reiche hier deine Auslagen für die Werkstatt ein. Bitte füge für jede Position alle zugehörigen Belegseiten hinzu.",
          recipient: "finance@example.invalid",
          supportEmail: "finance@example.invalid",
          status: "published",
        })
        .onConflictDoNothing({ target: forms.slug });
      return true;
    });
    out(`${created ? "Created" : "Kept"} demo form at /f/demo/.`);
  },
});

registerCommand("verify-storage", {
  usage: "verify-storage                          check stored files against the database (read-only)",
  run: async () => {
    let checked = 0;
    let failures = 0;
    const PAGE = 100;
    for (let offset = 0; ; offset += PAGE) {
      const page = await q().select().from(uploads).orderBy(uploads.id).limit(PAGE).offset(offset);
      for (const upload of page) {
        const checks: Array<[string, number, string | null]> = [
          [upload.sourceKey, upload.size, upload.checksum],
        ];
        if (upload.normalizedKey && upload.normalizedKey !== upload.sourceKey) {
          checks.push([upload.normalizedKey, upload.normalizedSize, null]);
        }
        for (const [key, size, checksum] of checks) {
          checked += 1;
          if (!(await verify(key, { size, checksum }))) failures += 1;
        }
      }
      if (page.length < PAGE) break;
    }
    for (let offset = 0; ; offset += PAGE) {
      const page = await q()
        .select({ pdfKey: claims.pdfKey, pdfSize: claims.pdfSize, pdfHash: claims.pdfHash })
        .from(claims)
        .where(ne(claims.pdfKey, ""))
        .orderBy(claims.id)
        .limit(PAGE)
        .offset(offset);
      for (const claim of page) {
        checked += 1;
        if (!(await verify(claim.pdfKey, { size: claim.pdfSize, checksum: claim.pdfHash }))) failures += 1;
      }
      if (page.length < PAGE) break;
    }
    out(JSON.stringify({ files_checked: checked, failures }));
    if (failures) throw new CommandError("Private storage verification failed.");
  },
});

registerCommand("run-jobs", {
  usage:
    "run-jobs [--once|--drain]               the worker in the foreground (the image's role is `worker`)",
  run: async (args) => {
    let stopping = false;
    const stop = () => {
      stopping = true;
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    await runJobs({ once: args.includes("--once"), drain: args.includes("--drain") }, () => stopping);
  },
});

registerCommand("verify-setup", {
  usage:
    "verify-setup --to <finance inbox> [--confirmation-to <address>] [--timeout <s>]  end-to-end check with a synthetic claim",
  run: async (args) => {
    const finance = (option(args, "--to") ?? "").trim().toLowerCase();
    if (!finance) throw new CommandError("Name the Finance inbox: --to <address>.");
    const participant = (option(args, "--confirmation-to") ?? finance).trim().toLowerCase();
    for (const address of new Set([finance, participant])) {
      if (!isEmail(address)) throw new CommandError(`'${address}' is not an email address.`);
    }
    if (!recipientApproved(finance)) {
      throw new CommandError(
        `${finance} is not in APPROVED_DELIVERY_RECIPIENTS. Use an approved Finance inbox.`,
      );
    }
    const allowlist = config().TEST_RECIPIENT_ALLOWLIST;
    const blocked = [...new Set([finance, participant])]
      .filter((address) => allowlist.length && !allowlist.includes(address))
      .sort();
    if (blocked.length)
      throw new CommandError(`TEST_RECIPIENT_ALLOWLIST does not include ${blocked.join(", ")}.`);
    const raw = option(args, "--timeout") ?? "300";
    const timeout = /^-?\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!(timeout >= 1)) throw new CommandError("--timeout must be at least 1 second.");
    out(`Setup check (${config().DEPLOYMENT_ENV}, email by ${config().MAIL_DELIVERY_MODE})`);
    const check = new SetupCheck({
      finance,
      participant,
      timeout,
      report: (status, title, detail) => {
        out(`  ${status.padEnd(4)}  ${title}`);
        if (detail) out(`        ${detail}`);
      },
    });
    if (!(await check.run())) {
      const problems = `${check.failures} problem${check.failures !== 1 ? "s" : ""}`;
      throw new CommandError(`Setup check failed: ${problems}.`);
    }
    out("Setup check passed.");
  },
});
