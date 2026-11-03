/**
 * Smoke P1/P2/P3: Google connect (mock), goals, weekly digest.
 * Uso na VPS: npx tsx scripts/test-p123-upgrade.ts
 */
import { and, eq, isNull } from "drizzle-orm";
import { getDb, closeDb } from "@/db/client";
import {
  conversations,
  memories,
  users,
  workspaces,
} from "@/db/schema";
import { beginGoogleOAuth, completeGoogleOAuth, getGoogleConnection } from "@/integrations/google/oauth";
import { syncWorkspaceToGoogleCalendar } from "@/integrations/google/calendar";
import { syncWorkspaceToGoogleSheets } from "@/integrations/google/sheets";
import { runWeeklyDigests, buildWeeklyDigestText } from "@/scheduler/weekly-digest";
import { getEnv } from "@/config/env";

async function main() {
  const db = getDb();
  const env = getEnv();
  console.log("APP_BASE_URL", env.APP_BASE_URL);
  console.log("GOOGLE_OAUTH_DEV_MOCK", env.GOOGLE_OAUTH_DEV_MOCK);
  console.log("GOOGLE_CLIENT_ID set", Boolean(env.GOOGLE_CLIENT_ID));

  const wsList = await db.query.workspaces.findMany({});
  const ws = wsList[0];
  if (!ws) throw new Error("no_workspace");
  const owner = await db.query.users.findFirst({
    where: eq(users.id, ws.ownerUserId),
  });
  if (!owner) throw new Error("no_owner");
  const conv = await db.query.conversations.findFirst({
    where: and(
      eq(conversations.workspaceId, ws.id),
      isNull(conversations.deletedAt)
    ),
    orderBy: (c, { desc }) => [desc(c.lastMessageAt)],
  });

  // 1) Google OAuth mock connect
  const started = await beginGoogleOAuth(db, {
    workspaceId: ws.id,
    userId: owner.id,
    conversationId: conv?.id,
  });
  if (!started.ok) throw new Error(started.error);
  const state = new URL(started.url).searchParams.get("state") || "";
  const code = new URL(started.url).searchParams.get("code") || "dev_mock";
  const done = await completeGoogleOAuth(db, { code, state });
  if (!done.ok) throw new Error(done.error);
  const conn = await getGoogleConnection(db, ws.id);
  console.log("google_connected", conn?.status, (conn?.metadata as { mock?: boolean })?.mock);

  const cal = await syncWorkspaceToGoogleCalendar(db, {
    workspaceId: ws.id,
    timezone: owner.timezone || "America/Sao_Paulo",
  });
  console.log("calendar_sync", cal);

  const sheets = await syncWorkspaceToGoogleSheets(db, {
    workspaceId: ws.id,
    timezone: owner.timezone || "America/Sao_Paulo",
  });
  console.log("sheets_sync", sheets);

  // 2) Spending goal
  await db.insert(memories).values({
    workspaceId: ws.id,
    createdByUserId: owner.id,
    conversationId: conv?.id,
    type: "fact",
    content: "Meta mensal de gastos: R$ 50.00",
    sourceType: "goal",
    status: "active",
    metadata: { kind: "spending_limit", monthly_limit: 50, category: null },
  });
  await db.insert(memories).values({
    workspaceId: ws.id,
    createdByUserId: owner.id,
    type: "fact",
    content: "Despesa teste meta: BRL 80.00",
    sourceType: "expense",
    status: "active",
    metadata: {
      kind: "expense",
      category: "mercado",
      amount: 80,
      currency: "BRL",
    },
  });
  console.log("goal_seeded_over_limit");

  // 3) Weekly digest (force)
  const digestText = await buildWeeklyDigestText(db, {
    workspaceId: ws.id,
    timezone: owner.timezone || "America/Sao_Paulo",
    userName: owner.fullName || owner.name,
  });
  console.log("digest_preview_len", digestText?.length || 0);
  console.log("---DIGEST---\n", digestText?.slice(0, 500));

  const digest = await runWeeklyDigests(db, {
    force: true,
    onlyWorkspaceId: ws.id,
  });
  console.log("digest_send", digest);

  await closeDb();
  console.log("P123_SMOKE_OK");
}

main().catch(async (e) => {
  console.error(e);
  await closeDb().catch(() => {});
  process.exit(1);
});
