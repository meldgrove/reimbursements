import { config } from "./config";
import { sandboxReady } from "./services/documents";
import { boundedWorkspace } from "./services/readiness";

/**
 * What every process needs outside development before it starts (portal/checks.py
 * and PortalConfig.ready of the Django version, which refused to start without
 * them): the document sandbox, and the document workspace as a private,
 * bounded tmpfs. /-/readyz keeps reporting both while the app runs.
 */
export async function productionChecks(): Promise<string[]> {
  const settings = config();
  if (settings.isDevelopment) return [];
  const problems: string[] = [];
  if (!settings.DOCUMENT_SANDBOX_ENABLED || !(await sandboxReady())) {
    problems.push("Document sandbox requires Linux Landlock ABI 3+ and libseccomp2.");
  }
  if (!boundedWorkspace()) {
    problems.push("Mount private/work as a private, bounded tmpfs of at most 750 MB.");
  }
  return problems;
}
