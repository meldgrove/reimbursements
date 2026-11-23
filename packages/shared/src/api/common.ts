import { z } from "zod";

/** Every error response: `{ error: { code, message, fields? } }`. Messages are shown to people. */
export const errorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    fields: z.record(z.string(), z.string()).optional(),
  }),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;

export const okSchema = z.object({ ok: z.literal(true) });

export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Optional text: blank becomes null. */
export const nullableText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? null : value),
    z.string().trim().max(max).nullable(),
  );
