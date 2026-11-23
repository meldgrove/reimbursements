import { eq } from "drizzle-orm";
import { runMigrations } from "../db/migrate";
import { users } from "../db/schema";
import { atomic, q } from "../db/tx";
import { config } from "../config";
import { option, registerCommand } from "./registry";

registerCommand("migrate", {
  usage: "migrate                                 apply database migrations",
  run: async () => {
    await runMigrations();
  },
});

registerCommand("create-superuser", {
  usage: "create-superuser --username <name> [--email <a>]  a template admin for the development sign-in",
  run: async (args) => {
    if (!config().isDevelopment) {
      throw new Error("Superusers are for development only: roles come from the sign-in provider.");
    }
    const username = (option(args, "--username") ?? "").trim();
    const email = (option(args, "--email") ?? "").trim();
    if (!username) throw new Error("Name the user: --username <name>.");
    await atomic(async () => {
      const [user] = await q().select().from(users).where(eq(users.username, username));
      if (user) {
        await q()
          .update(users)
          .set({ isSuperuser: true, isStaff: true, isActive: true, email })
          .where(eq(users.id, user.id));
      } else {
        await q().insert(users).values({ username, email, isSuperuser: true, isStaff: true });
      }
    });
    process.stdout.write(`Superuser ${username} is ready. Sign in at /admin/login with DEV_LOGIN=1.\n`);
  },
});
