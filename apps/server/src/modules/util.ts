import type { Hono } from "hono";
import type { AppEnv } from "../http/env";

export type Router = Hono<AppEnv>;

export const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);
