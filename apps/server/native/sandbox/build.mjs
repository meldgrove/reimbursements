// Builds the document sandbox: the launcher (launcher.c) and the Node add-on
// (sandbox.c) into native/build/. Needs a C compiler and the Node
// headers, which official Node releases and images ship next to the binary
// (include/node); NODE_INCLUDE_DIR overrides the folder. No node-gyp, no
// libseccomp headers: the add-on loads libseccomp.so.2 when it runs.
//
//   node native/sandbox/build.mjs [--if-missing]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const output = path.join(here, "..", "build");
const sources = ["launcher.c", "sandbox.c"].map((name) => path.join(here, name));
const targets = { launcher: path.join(output, "launcher"), addon: path.join(output, "sandbox.node") };

if (process.argv.includes("--if-missing")) {
  const newest = Math.max(...sources.map((source) => statSync(source).mtimeMs));
  const current = Object.values(targets).every(
    (target) => existsSync(target) && statSync(target).mtimeMs >= newest,
  );
  if (current) process.exit(0);
}

const include =
  process.env.NODE_INCLUDE_DIR ?? path.resolve(path.dirname(process.execPath), "..", "include", "node");
if (!existsSync(path.join(include, "node_api.h"))) {
  process.stderr.write(`The Node headers are missing (${include}); set NODE_INCLUDE_DIR.\n`);
  process.exit(1);
}
const compiler = process.env.CC ?? "cc";
const flags = ["-O2", "-Wall", "-Wextra", "-Werror", "-D_FORTIFY_SOURCE=2", "-fstack-protector-strong"];
mkdirSync(output, { recursive: true });
// Each output is written beside its target and renamed, so builds running at
// the same time (parallel test runs) never load a half-written file.
const temporary = (target) => `${target}.${process.pid}.tmp`;
execFileSync(compiler, [...flags, "-o", temporary(targets.launcher), path.join(here, "launcher.c")], {
  stdio: "inherit",
});
execFileSync(
  compiler,
  [
    ...flags,
    "-shared",
    "-fPIC",
    `-I${include}`,
    "-o",
    temporary(targets.addon),
    path.join(here, "sandbox.c"),
    "-ldl",
  ],
  { stdio: "inherit" },
);
for (const target of Object.values(targets)) renameSync(temporary(target), target);
process.stdout.write(`document sandbox built in ${path.relative(process.cwd(), output) || "."}\n`);
