import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { messages, whatsappIdentities } from "@/db/schema";
import { handleZernioWebhook } from "@/services/inbound-webhook";
import { claimJobs } from "@/domain/jobs";
import { processAgentJob } from "@/worker/process-job";
import { computeZernioSignature } from "@/channels/zernio";
import { pairIdentityToUser } from "@/domain/whatsapp-identities";

export type HarnessUser = {
  label: string;
  phone: string;
  bsuid?: string;
  userId?: string;
  workspaceId?: string;
  externalConversationId: string;
};

function buildPayload(user: HarnessUser, text: string) {
  return {
    id: `evt_${Math.random().toString(16).slice(2)}`,
    event: "message.received",
    timestamp: new Date().toISOString(),
    data: {
      account: { id: "acct_test" },
      conversation: { id: user.externalConversationId },
      contact: {
        phone: user.phone,
        bsuid: user.bsuid,
        name: user.label,
      },
      message: {
        id: `msg_${Math.random().toString(16).slice(2)}`,
        text,
        type: "text",
      },
    },
  };
}

/**
 * Conversation harness — real webhook → job → worker path without WhatsApp network.
 */
export function createConversationHarness(db: Db) {
  return {
    async sendAs(user: HarnessUser, text: string) {
      const payload = buildPayload(user, text);
      const rawBody = JSON.stringify(payload);
      const signature = computeZernioSignature(
        process.env.ZERNIO_WEBHOOK_SECRET || "test-zernio-webhook-secret",
        rawBody
      );
      const result = await handleZernioWebhook(db, { rawBody, signature });
      if (!result.ok) {
        throw new Error(`webhook_failed:${JSON.stringify(result.body)}`);
      }

      for (let i = 0; i < 8; i++) {
        const jobs = await claimJobs(db, {
          workerId: `harness_${user.label}`,
          limit: 5,
        });
        if (!jobs.length) break;
        for (const job of jobs) {
          await processAgentJob(db, job);
        }
      }

      const outbound = await db.query.messages.findMany({
        where: eq(messages.direction, "outbound"),
        orderBy: (m, { desc }) => [desc(m.createdAt)],
        limit: 5,
      });
      return {
        webhook: result.body,
        lastReply: outbound[0]?.bodyText || null,
        outbound,
      };
    },

    async pairExisting(
      user: HarnessUser,
      ids: { userId: string; workspaceId: string }
    ) {
      const identity = await db.query.whatsappIdentities.findFirst({
        where: eq(whatsappIdentities.phoneE164, user.phone),
      });
      if (!identity) throw new Error("identity_missing");
      await pairIdentityToUser(db, {
        identityId: identity.id,
        userId: ids.userId,
      });
      user.userId = ids.userId;
      user.workspaceId = ids.workspaceId;
    },
  };
}
