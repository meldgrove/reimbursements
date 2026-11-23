/**
 * Every command module; importing one registers its commands (registry.ts).
 *
 * TODO(BACK OFFICE): claim-status, purge-expired, reconcile-deliveries,
 * retry-claim, seed-demo, verify-setup, verify-storage (the Django version's
 * management commands).
 */
import "./basics";

export { COMMANDS, option, registerCommand, type Command } from "./registry";
