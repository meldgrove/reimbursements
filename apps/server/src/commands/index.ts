/**
 * Every command module; importing one registers its commands (registry.ts).
 */
import "./basics";
import "./back-office";

export { COMMANDS, option, registerCommand, type Command } from "./registry";
