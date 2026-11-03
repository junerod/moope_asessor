/**
 * Envia mensagem de status para o número do dev (homologação).
 * Uso: npx tsx scripts/notify-dev.ts "texto da mensagem"
 */
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { getDb, closeDb } from "@/db/client";
import { conversations, whatsappIdentities } from "@/db/schema";
import { createZernioClient } from "@/channels/zernio";
import { resolveZernioRuntimeConfig } from "@/domain/providers";
import {
  DEV_MASTER_PHONE,
  getDevMasterPhoneVariants,
} from "@/domain/dev-notifications";

async function main() {
  const message = process.argv.slice(2).join(" ").trim();
  if (!message) {
    console.error("usage: notify-dev.ts <message>");
    process.exit(1);
  }
  const phones = getDevMasterPhoneVariants();
  const digitsList = phones.map((phone) => phone.replace(/\D/g, ""));
  const db = getDb();
  const cfg = await resolveZernioRuntimeConfig(db);
  const client = createZernioClient({
    mock: cfg.mock,
    apiKey: cfg.apiKey,
    apiUrl: cfg.apiUrl,
    accountId: cfg.accountId,
  });

  const identities = await db.query.whatsappIdentities.findMany({
    where: and(
      isNull(whatsappIdentities.deletedAt),
      or(
        ...phones.map((phone) => eq(whatsappIdentities.phoneE164, phone)),
        ...digitsList.map(
          (digits) =>
            sql`regexp_replace(coalesce(${whatsappIdentities.phoneE164}, ''), '\\D', '', 'g') = ${digits}`
        )
      )
    ),
    limit: 5,
  });

  let externalConversationId: string | null = null;
  for (const id of identities) {
    const conv = await db.query.conversations.findFirst({
      where: and(
        eq(conversations.whatsappIdentityId, id.id),
        isNull(conversations.deletedAt)
      ),
      orderBy: (c, { desc }) => [desc(c.updatedAt)],
    });
    if (conv?.externalConversationId) {
      externalConversationId = conv.externalConversationId;
      break;
    }
  }

  if (!externalConversationId) {
    console.error("dev_master_conversation_not_found", DEV_MASTER_PHONE);
    await closeDb();
    process.exit(1);
  }

  const send = await client.sendText({
    conversationId: externalConversationId,
    message,
    idempotencyKey: `notify-dev:${Date.now()}`,
    accountId: cfg.accountId || undefined,
  });
  console.log(JSON.stringify({ ok: send.ok, phone: DEV_MASTER_PHONE, externalConversationId, error: send.error }));
  await closeDb();
  process.exit(send.ok ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await closeDb().catch(() => {});
  process.exit(1);
});
