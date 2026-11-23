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

export const COMMANDS = new Map<string, Command>();

export function registerCommand(name: string, command: Command) {
  COMMANDS.set(name, command);
}

/** The value after `name` in the arguments, e.g. option(args, "--to"). */
export function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}
