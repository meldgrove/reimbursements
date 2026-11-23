// Writes debug IDs into built bundles and their source maps:
//   node scripts/inject-debug-ids.mjs <directory>...
// Error reports carry the IDs, and Sentry finds the matching source maps by
// them, which release builds upload (Dockerfile). Uploads nothing.
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const directories = process.argv.slice(2);
if (directories.length === 0) throw new Error("Name the directories with the bundles.");

for (const directory of directories) {
  execFileSync(path.join(root, "node_modules/.bin/sentry"), ["sourcemap", "inject", directory], {
    stdio: "inherit",
    env: { ...process.env, SENTRY_CLI_NO_TELEMETRY: "1", SENTRY_CLI_NO_UPDATE_CHECK: "1" },
  });
}
