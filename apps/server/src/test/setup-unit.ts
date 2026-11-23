import { afterEach } from "vitest";
import { resetConfigForTests } from "../config";

/** Settings a test changed (overrideConfigForTests) do not reach the next one. */
afterEach(() => {
  resetConfigForTests();
});
