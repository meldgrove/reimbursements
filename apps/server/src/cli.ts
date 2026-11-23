import { closeDb } from "./db/client";
import { COMMANDS } from "./commands";

/** Runs an operator command (commands/): `cli <command> [arguments]`, `cli help` lists them. */
export async function runCli(argv: string[]): Promise<number> {
  const [name, ...args] = argv;
  const command = name ? COMMANDS.get(name) : undefined;
  if (!command) {
    const lines = [...COMMANDS.values()].map((entry) => `  ${entry.usage}`).join("\n");
    process.stdout.write(`Commands:\n${lines}\n`);
    return name && name !== "help" ? 2 : 0;
  }
  return (await command.run(args)) ?? 0;
}

runCli(process.argv.slice(2))
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  })
  .catch(async (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    await closeDb();
    process.exit(1);
  });
