/**
 * Reprocessa a última imagem inbound do WhatsApp (fix parser attachments).
 * Uso na VPS: npx tsx scripts/replay-last-image.ts
 */
import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agentJobs, conversations, webhookEvents } from "@/db/schema";
import { enqueueAgentJob } from "@/domain/jobs";
import { parseZernioWebhook } from "@/channels/zernio/parse";

async function main() {
  const db = getDb();
  const events = await db.query.webhookEvents.findMany({
    where: eq(webhookEvents.eventType, "message.received"),
    orderBy: [desc(webhookEvents.createdAt)],
    limit: 30,
  });
  const event = events.find((e) => {
    const p = e.payload as Record<string, unknown>;
    const msg = (p?.message || {}) as Record<string, unknown>;
    return Array.isArray(msg.attachments) && msg.attachments.length > 0;
  });
  if (!event) {
    console.error("no_image_webhook_found");
    process.exit(1);
  }
  const normalized = parseZernioWebhook(event.payload);
  if (!normalized?.mediaUrl) {
    console.error("parse_still_missing_media");
    process.exit(1);
  }

  const linkedJob = await db.query.agentJobs.findFirst({
    where: eq(agentJobs.webhookEventId, event.id),
  });
  let conversationId = linkedJob?.conversationId || null;
  let workspaceId = linkedJob?.workspaceId || null;
  if (!conversationId) {
    const conv = await db.query.conversations.findFirst({
      where: sql`${conversations.workspaceId} is not null`,
      orderBy: [desc(conversations.updatedAt)],
    });
    conversationId = conv?.id || null;
    workspaceId = conv?.workspaceId || null;
  }
  if (!conversationId || !workspaceId) {
    console.error("conversation_not_found");
    process.exit(1);
  }

  const { job } = await enqueueAgentJob(db, {
    jobType: "inbound_message",
    workspaceId,
    conversationId,
    webhookEventId: event.id,
    idempotencyKey: `replay-image:${event.id}:${Date.now()}`,
    payload: {
      paired: true,
      text:
        normalized.text ||
        "Registra essa receita de remédio para dormir (reprocessamento)",
      media_url: normalized.mediaUrl,
      media_mime_type: normalized.mediaMimeType || "image/jpeg",
      content_type: normalized.contentType || "image",
    },
  });

  console.log(
    JSON.stringify({
      ok: true,
      job_id: job.id,
      conversation_id: conversationId,
      media_url: normalized.mediaUrl.slice(0, 90),
      mime: normalized.mediaMimeType,
    })
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
