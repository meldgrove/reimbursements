import { closeDb } from "./db/client";
import { CommandError, COMMANDS, UsageError } from "./commands";
import { flushErrorReports, tagRole } from "./error-reporting";
import { logger, logToStderr } from "./logger";
import { OperatorError } from "./operator-error";
import { SETTING_NAMES } from "./services/settings-audit";

/** Runs an operator command (commands/): `cli <command> [arguments]`, `cli help` lists them. */
export async function runCli(argv: string[]): Promise<number> {
  const [name, ...args] = argv;
  const command = name ? COMMANDS.get(name) : undefined;
  // Reports name the command, as 0.4 named the management command.
  if (command) tagRole(name!);
  if (!command) {
    const lines = [...COMMANDS.values()].map((entry) => `  ${entry.usage}`).join("\n");
    process.stdout.write(
      `Commands:\n${lines}\n\nSettings: ${SETTING_NAMES.join(", ")}. See \`cli settings help\` and docs/deployment.md (Operator commands).\n`,
    );
    return name && name !== "help" ? 2 : 0;
  }
  return (await command.run(args)) ?? 0;
}

/** Waits until `stream` has passed on everything written: a pipe may hold output when the process exits. */
function flushed(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => stream.write("", () => resolve()));
}

async function exit(code: number): Promise<never> {
  await closeDb();
  await flushErrorReports();
  await flushed(process.stdout);
  await flushed(process.stderr);
  process.exit(code);
}

// Stdout is the command's answer, such as the JSON of `cli settings show`.
logToStderr();
runCli(process.argv.slice(2))
  .then(exit)
  .catch(async (error: unknown) => {
    if (error instanceof CommandError || error instanceof OperatorError) {
      process.stderr.write(`${error.message}\n`);
      if (error instanceof UsageError) return exit(2);
    } else {
      // Its message can quote stored values (a query's parameters): the log keeps type and code only.
      logger.error({ err: error }, "command_failed");
      process.stderr.write("The command failed; the log above has the details.\n");
    }
    await exit(1);
  });
