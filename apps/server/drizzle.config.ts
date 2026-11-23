import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://reimbursement:reimbursement@127.0.0.1:55468/reimbursement",
  },
  strict: true,
  verbose: true,
});
