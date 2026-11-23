/**
 * A problem the operator must solve, such as a setting or a database the
 * migration refuses. Its message is written for them and holds no personal
 * data, so the log keeps it (src/logger.ts), unlike other errors' messages.
 */
export class OperatorError extends Error {
  override name = "OperatorError";
}
