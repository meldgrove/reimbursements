/**
 * Commands for operators (the Django version's management commands,
 * docs/operations.md). In the image: `docker compose run --rm web cli <command>`.
 * Each command module registers its commands here; commands/index.ts imports them.
 */
export type Command = {
  /** One line for `cli help`, e.g. "claim-status <reference>  show a claim's status". */
  usage: string;
  /** The exit code (0 when it returns nothing). */
  run: (args: string[]) => Promise<number | void>;
};

/**
 * A command's refusal, written for the operator without personal data: the CLI
 * prints its message and exits with 1 (Django's CommandError). Any other error
 * goes to the log without its message, which can quote stored values.
 */
export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandError";
  }
}

export const COMMANDS = new Map<string, Command>();

export function registerCommand(name: string, command: Command) {
  COMMANDS.set(name, command);
}

/** The value after `name` in the arguments, e.g. option(args, "--to"). */
export function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}
