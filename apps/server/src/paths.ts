import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const parts = here.split(path.sep);
const bundle = parts.lastIndexOf("dist");
const sources = parts.lastIndexOf("src");

/**
 * True when running the production bundle (dist/, or a shared chunk in
 * dist/chunks/), false when running the TypeScript sources (development, tests).
 */
export const IS_BUNDLED = bundle > sources;

/** apps/server: the folder that holds src/ and dist/. */
export const SERVER_ROOT =
  Math.max(bundle, sources) > 0
    ? parts.slice(0, Math.max(bundle, sources)).join(path.sep)
    : path.resolve(here, "..");
