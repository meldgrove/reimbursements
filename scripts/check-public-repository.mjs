// Rejects private artifacts, unexpected contact domains and common credential
// formats in the tracked files. Run it before sharing a revision (CI does).
// Dependency and integration URLs below are intentional. This check cannot
// tell whether prose or synthetic-looking values are confidential; review
// those too.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PUBLIC_HOSTS = new Set([
  "api.github.com",
  "api.mailersend.com",
  // The license of the bundled DejaVu fonts, and a funding link in package-lock.json.
  "dejavu-fonts.github.io",
  "paulmillr.com",
  "docs.kernel.org",
  "www.apache.org",
  "admin.googleapis.com",
  "api.hubapi.com",
  "api.notion.com",
  "api.personio.de",
  "app.hubspot.com",
  "developers.google.com",
  "developers.hubspot.com",
  "developer.personio.de",
  "docs.docker.com",
  "docs.slack.dev",
  "github.com",
  "oauth2.googleapis.com",
  "registry.npmjs.org",
  "slack.com",
  "www.googleapis.com",
  "www.keycloak.org",
  "www.rfc-editor.org",
  "www.w3.org",
  "nodejs.org",
  "www.postgresql.org",
  "apt.postgresql.org",
  "orm.drizzle.team",
  "hono.dev",
  "openid.net",
  "datatracker.ietf.org",
  // Funding links of dependencies in package-lock.json.
  "polar.sh",
  "opencollective.com",
  "github.com",
  "tidelift.com",
  "paypal.me",
  "www.patreon.com",
  "patreon.com",
  "feross.org",
  "ko-fi.com",
  "buymeacoffee.com",
  "www.buymeacoffee.com",
  "liberapay.com",
  "dotenvx.com",
  "bevry.me",
  "thanks.dev",
  "tsx.hirok.io",
  "eslint.org",
]);
const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "web",
  "keycloak",
  "mailpit",
  "postgres",
  "database",
  "scanner",
  "updater",
  "REPLACE_WITH_DATABASE_HOST",
]);
const PRIVATE_SUFFIXES = new Set([
  ".db",
  ".sqlite3",
  ".dump",
  ".eml",
  ".pem",
  ".key",
  ".log",
  ".tar",
  ".zip",
]);
// Binary files that are part of the repository on purpose.
const REVIEWED_BINARIES = ["docs/screenshots/", "apps/server/assets/", "apps/web/public/"];
const TOKEN =
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}|\bAKIA[A-Z0-9]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}/;
const URL_PATTERN = /\b(?:https?|postgresql|postgres):\/\/[^\s"'<>`)]+/g;
const EMAIL = /\b[\w.+-]+@([\w.-]+\.[A-Za-z]{2,})\b/g;

function allowedHost(host) {
  return (
    PUBLIC_HOSTS.has(host) ||
    host === "www.notion.so" ||
    host.endsWith(".slack.com") ||
    LOCAL_HOSTS.has(host) ||
    host === "replace_with_database_host" ||
    host === "example.invalid" ||
    host.endsWith(".example.invalid")
  );
}

function check(name) {
  const base = path.basename(name);
  if (
    PRIVATE_SUFFIXES.has(path.extname(name).toLowerCase()) ||
    (base.startsWith(".env") && !base.endsWith(".example"))
  ) {
    return [`${name}: private artifact type`];
  }
  const bytes = readFileSync(path.join(ROOT, name));
  let content;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return REVIEWED_BINARIES.some((prefix) => name.startsWith(prefix))
      ? []
      : [`${name}: binary asset requires review`];
  }
  const errors = [];
  if (TOKEN.test(content)) errors.push(`${name}: credential-shaped value`);
  for (const match of content.matchAll(EMAIL)) {
    const host = match[1].toLowerCase();
    if (host !== "example.invalid" && !host.endsWith(".example.invalid"))
      errors.push(`${name}: non-example email domain (${host})`);
  }
  for (const match of content.matchAll(URL_PATTERN)) {
    let host;
    try {
      host = new URL(match[0]).hostname.toLowerCase();
    } catch {
      continue;
    }
    // A dot at the end of a sentence is no part of the host.
    host = host.replace(/^\[|\]$/g, "").replace(/\.+$/, "");
    if (host && host.replace(/\./g, "") && !allowedHost(host))
      errors.push(`${name}: unexpected URL host (${host})`);
  }
  return errors;
}

const names = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT }).toString().split("\0").filter(Boolean);
const errors = [...new Set(names.flatMap(check))].sort();
if (errors.length > 0) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`Public repository checks passed for ${names.length} tracked files.\n`);
