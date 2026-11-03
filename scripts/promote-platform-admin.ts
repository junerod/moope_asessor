/**
 * Promote an existing user to platform_admin.
 * Usage: npx tsx scripts/promote-platform-admin.ts user@example.com
 */
import { eq } from "drizzle-orm";
import { getDb, closeDb } from "@/db/client";
import { users } from "@/db/schema";
import { ensurePlatformAdmin } from "@/domain/platform-admin";

async function main() {
  const email = (process.argv[2] || "").trim().toLowerCase();
  if (!email) {
    console.error("Usage: tsx scripts/promote-platform-admin.ts <email>");
    process.exit(1);
  }
  const db = getDb();
  const user = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (!user) {
    console.error("user_not_found");
    process.exit(1);
  }
  const admin = await ensurePlatformAdmin(db, user.id, "super_admin");
  console.log(JSON.stringify({ ok: true, user_id: user.id, role: admin.role }));
  await closeDb();
}

main().catch(async (e) => {
  console.error(e);
  await closeDb();
  process.exit(1);
});
