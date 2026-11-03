#!/usr/bin/env tsx
/**
 * Envia aviso ao número de homologação (dev) via Zernio.
 * Uso: npx tsx scripts/notify-dev-whatsapp.ts "mensagem"
 */
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { getDb, closeDb } from "@/db/client";
import { conversations, whatsappIdentities } from "@/db/schema";
import { sendProactiveMessage } from "@/channels/zernio/proactive";
import {
  DEV_MASTER_PHONE,
  getDevMasterPhoneVariants,
} from "@/domain/dev-notifications";

async function main() {
  const message = process.argv.slice(2).join(" ").trim();
  if (!message) {
    console.error("Usage: notify-dev-whatsapp.ts <message>");
    process.exit(1);
  }
  const db = getDb();
  const phones = getDevMasterPhoneVariants();
  const digitsList = phones.map((p) => p.replace(/\D/g, ""));

  const identity = await db.query.whatsappIdentities.findFirst({
    where: and(
      isNull(whatsappIdentities.deletedAt),
      or(
        ...phones.map((p) => eq(whatsappIdentities.phoneE164, p)),
        ...digitsList.map(
          (d) =>
            sql`regexp_replace(coalesce(${whatsappIdentities.phoneE164}, ''), '\\D', '', 'g') = ${d}`
        )
      )
    ),
  });

  const conv = identity
    ? await db.query.conversations.findFirst({
        where: and(
          eq(conversations.whatsappIdentityId, identity.id),
          isNull(conversations.deletedAt)
        ),
        orderBy: (c, { desc }) => [desc(c.lastMessageAt)],
      })
    : null;
  const externalId = conv?.externalConversationId || null;

  if (!externalId) {
    console.error("dev_master_conversation_not_found", DEV_MASTER_PHONE);
    await closeDb();
    process.exit(3);
  }

  const send = await sendProactiveMessage(db, {
    conversationId: externalId,
    message,
    idempotencyKey: `dev-notify:${Date.now()}`,
    withinCustomerCareWindow: true,
  });
  console.log(
    JSON.stringify({
      ok: send.ok,
      mode: send.mode,
      error: send.error,
      externalMessageId: send.externalMessageId,
      phone: identity?.phoneE164 || DEV_MASTER_PHONE,
      externalConversationId: externalId,
    })
  );
  await closeDb();
  process.exit(send.ok ? 0 : 4);
}

main().catch(async (e) => {
  console.error(e);
  await closeDb();
  process.exit(1);
});
