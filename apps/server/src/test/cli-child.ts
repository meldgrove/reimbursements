/**
 * The CLI (src/cli.ts) with commands of its own, for src/cli.test.ts:
 *   node --import tsx src/test/cli-child.ts <fail-privately|refuse|flood>
 */
import { CommandError, registerCommand } from "../commands/registry";

registerCommand("fail-privately", {
  usage: "",
  run: async () => {
    // As a failed query's message quotes its parameters. Joined at run time: error
    // reports carry source lines around a frame, which would otherwise hold it.
    throw new Error(`Failed query: insert ... params: ${["SYNTHETIC", "PRIVATE", "REASON"].join("_")}`);
  },
});
registerCommand("refuse", {
  usage: "",
  run: async () => {
    throw new CommandError("Name the Finance inbox: --to <address>.");
  },
});
registerCommand("flood", {
  usage: "",
  run: async () => {
    for (let line = 0; line < 3000; line += 1) process.stdout.write(`${"x".repeat(999)}\n`);
  },
});

await import("../cli");
