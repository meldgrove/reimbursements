/**
 * Every command module; importing one registers its commands (registry.ts).
 */
import "./basics";
import "./back-office";
import "./settings";

export { CommandError, COMMANDS, option, registerCommand, UsageError, type Command } from "./registry";
