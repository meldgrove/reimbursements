import { TEST_DATABASE_URL } from "./env";
import { recreateDatabase } from "./databases";

/** Creates a fresh test database (TEST_DATABASE_URL) and applies the migrations. */
export default async function setup() {
  await recreateDatabase(TEST_DATABASE_URL);
}
