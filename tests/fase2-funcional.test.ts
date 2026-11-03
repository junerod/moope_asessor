import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createTestDb,
  truncateAll,
  signedBody,
  inboundPayload,
} from "./helpers/db";
import { handleZernioWebhook } from "@/services/inbound-webhook";
import { claimJobs } from "@/domain/jobs";
import { processAgentJob } from "@/worker/process-job";
import { registerUser } from "@/lib/auth";
import {
  upsertUnknownIdentity,
  pairIdentityToUser,
  startIdentityVerification,
  verifyIdentityCode,
} from "@/domain/whatsapp-identities";
import { handleOnboardingTurn } from "@/domain/onboarding";
import { getMockEmails, resetEmailMock } from "@/lib/email/provider";
import { evaluateToolPolicy } from "@/agent/policy/engine";
import { runAgentTurn } from "@/agent/runtime";
import { getTool } from "@/agent/tools";
import "@/agent/tools";
import { createConversationHarness } from "@/testing/conversation-harness";
import { queueDueReminders } from "@/scheduler/queue-reminders";
import { ingestInboundDocument, processDocumentJob } from "@/domain/documents";
import { assertSafeRemoteUrl } from "@/channels/zernio/media";
import {
  conversations,
  memories,
  reminders,
  appointments,
  documents,
  documentChunks,
  whatsappIdentities,
  workspaces,
  agentJobs,
} from "@/db/schema";
import { getZernioMockSends, resetZernioMock } from "@/channels/zernio";
import { DateTime } from "luxon";
import type { Db } from "@/db/client";
import type postgres from "postgres";

describe("Fase 2 — Assessor funcional", () => {
  let db: Db;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await truncateAll(sql);
    resetZernioMock();
    resetEmailMock();
  });

  async function drainJobs(workerId = "w2") {
    for (let i = 0; i < 10; i++) {
      const jobs = await claimJobs(db, { workerId, limit: 10 });
      if (!jobs.length) break;
      for (const job of jobs) await processAgentJob(db, job);
    }
  }

  describe("Onboarding", () => {
    it("1-8) máquina de estados, verificação e workspace único", async () => {
      const payload = inboundPayload({
        phone: "+5561911000001",
        text: "Oi",
        conversationId: "onb_conv_1",
      });
      const { rawBody, signature } = signedBody(payload);
      const first = await handleZernioWebhook(db, { rawBody, signature });
      expect(first.ok).toBe(true);
      expect(first.body.paired).toBe(false);
      await drainJobs("onb1");

      const conv = await db.query.conversations.findFirst({
        where: eq(conversations.externalConversationId, "onb_conv_1"),
      });
      expect(conv?.onboardingStep).toBe("awaiting_name");

      let turn = await handleOnboardingTurn(db, {
        conversation: conv!,
        identityId: conv!.whatsappIdentityId,
        text: "João Silva",
      });
      expect(turn.reply).toMatch(/e-mail/i);

      const conv2 = await db.query.conversations.findFirst({
        where: eq(conversations.id, conv!.id),
      });
      expect(conv2?.onboardingStep).toBe("awaiting_email");

      turn = await handleOnboardingTurn(db, {
        conversation: conv2!,
        identityId: conv2!.whatsappIdentityId,
        text: "email-invalido",
      });
      expect(turn.reply).toMatch(/não parece válido/i);
      expect(
        (
          await db.query.conversations.findFirst({
            where: eq(conversations.id, conv!.id),
          })
        )?.onboardingStep
      ).toBe("awaiting_email");

      turn = await handleOnboardingTurn(db, {
        conversation: (
          await db.query.conversations.findFirst({
            where: eq(conversations.id, conv!.id),
          })
        )!,
        identityId: conv!.whatsappIdentityId,
        text: "joao@email.com",
      });
      expect(turn.reply).toMatch(/código/i);
      const emails = getMockEmails();
      expect(emails[0]?.to).toBe("joao@email.com");
      const code = emails[0].body.match(/código é (\d{6})/i)?.[1];
      expect(code).toMatch(/^\d{6}$/);

      // wrong code
      turn = await handleOnboardingTurn(db, {
        conversation: (
          await db.query.conversations.findFirst({
            where: eq(conversations.id, conv!.id),
          })
        )!,
        identityId: conv!.whatsappIdentityId,
        text: "000000",
      });
      expect(turn.completed).toBe(false);

      // expired
      await db
        .update(whatsappIdentities)
        .set({ verificationExpiresAt: new Date(Date.now() - 1000) })
        .where(eq(whatsappIdentities.id, conv!.whatsappIdentityId));
      const expiredOk = await verifyIdentityCode(
        db,
        conv!.whatsappIdentityId,
        code!
      );
      expect(expiredOk).toBe(false);

      // fresh code
      const { code: code2 } = await startIdentityVerification(
        db,
        conv!.whatsappIdentityId
      );
      await db
        .update(conversations)
        .set({ onboardingStep: "awaiting_verification" })
        .where(eq(conversations.id, conv!.id));

      turn = await handleOnboardingTurn(db, {
        conversation: (
          await db.query.conversations.findFirst({
            where: eq(conversations.id, conv!.id),
          })
        )!,
        identityId: conv!.whatsappIdentityId,
        text: code2,
      });
      expect(turn.reply).toMatch(/aceito/i);

      // replay code fails
      const replay = await verifyIdentityCode(
        db,
        conv!.whatsappIdentityId,
        code2
      );
      expect(replay).toBe(false);

      turn = await handleOnboardingTurn(db, {
        conversation: (
          await db.query.conversations.findFirst({
            where: eq(conversations.id, conv!.id),
          })
        )!,
        identityId: conv!.whatsappIdentityId,
        text: "aceito",
      });
      expect(turn.completed).toBe(true);
      expect(turn.workspaceId).toBeTruthy();
      expect(turn.userId).toBeTruthy();
      const ownerId = turn.userId!;

      const wsCount = await sql`
        select count(*)::int as c from workspaces where owner_user_id = ${ownerId}
      `;
      expect(wsCount[0].c).toBe(1);

      // complete again shouldn't duplicate workspace
      const again = await handleOnboardingTurn(db, {
        conversation: (
          await db.query.conversations.findFirst({
            where: eq(conversations.id, conv!.id),
          })
        )!,
        identityId: conv!.whatsappIdentityId,
        text: "aceito",
      });
      expect(again.completed).toBe(true);
      const wsCount2 = await sql`
        select count(*)::int as c from workspaces where owner_user_id = ${ownerId}
      `;
      expect(wsCount2[0].c).toBe(1);
    });
  });

  describe("Memória / tools / isolamento", () => {
    it("9-15) memória, policy, múltiplas tools, workspace do contexto", async () => {
      expect(evaluateToolPolicy("unknown_tool_xyz")).toBe("DENY");
      expect(evaluateToolPolicy("save_memory")).toBe("ALLOW");

      const a = await registerUser(db, {
        email: "mem-a@example.com",
        name: "User A",
        password: "senha-segura-123",
      });
      const b = await registerUser(db, {
        email: "mem-b@example.com",
        name: "User B",
        password: "senha-segura-123",
      });

      const harness = createConversationHarness(db);
      const userA = {
        label: "A",
        phone: "+5561922000001",
        externalConversationId: "conv_mem_a",
      };
      const userB = {
        label: "B",
        phone: "+5561922000002",
        externalConversationId: "conv_mem_b",
      };

      // seed identities paired
      for (const [u, reg] of [
        [userA, a],
        [userB, b],
      ] as const) {
        const id = await upsertUnknownIdentity(db, { phoneE164: u.phone });
        await pairIdentityToUser(db, {
          identityId: id.id,
          userId: reg.user.id,
        });
        await db.insert(conversations).values({
          workspaceId: reg.workspace.id,
          userId: reg.user.id,
          whatsappIdentityId: id.id,
          externalConversationId: u.externalConversationId,
          status: "active",
          onboardingStep: "completed",
        });
      }

      const save = await harness.sendAs(
        userA,
        "Guarda que meu contador se chama Marcos."
      );
      expect(save.lastReply?.toLowerCase()).toMatch(/marcos|anotei|memória|contador/);

      const ask = await harness.sendAs(userA, "Quem é meu contador?");
      expect(ask.lastReply?.toLowerCase()).toContain("marcos");

      const askB = await harness.sendAs(userB, "Quem é meu contador?");
      expect(askB.lastReply?.toLowerCase() || "").not.toContain("marcos");

      const multi = await harness.sendAs(
        userA,
        "Carlos pediu 10% de desconto. Me lembra amanhã às 9h de responder."
      );
      expect(multi.lastReply).toBeTruthy();

      const mems = await db.query.memories.findMany({
        where: eq(memories.workspaceId, a.workspace.id),
      });
      expect(mems.some((m) => /carlos|10%/i.test(m.content))).toBe(true);
      const rems = await db.query.reminders.findMany({
        where: eq(reminders.workspaceId, a.workspace.id),
      });
      expect(rems.length).toBeGreaterThanOrEqual(1);

      // tool cannot switch workspace even if args try
      const tool = getTool("save_memory")!;
      const conv = await db.query.conversations.findFirst({
        where: eq(conversations.externalConversationId, "conv_mem_a"),
      });
      await tool.handler(
        {
          db,
          userId: a.user.id,
          workspaceId: a.workspace.id,
          conversationId: conv!.id,
          agentRunId: "00000000-0000-0000-0000-000000000001",
          timezone: "America/Sao_Paulo",
        },
        {
          content: "segredo A",
          workspace_id: b.workspace.id,
          workspaceId: b.workspace.id,
        }
      );
      const leaked = await db.query.memories.findMany({
        where: and(
          eq(memories.workspaceId, b.workspace.id),
          eq(memories.content, "segredo A")
        ),
      });
      expect(leaked).toHaveLength(0);
    });
  });

  describe("Lembrete / agenda", () => {
    it("16-22) reminder delivery idempotente + appointments timezone", async () => {
      const a = await registerUser(db, {
        email: "rem@example.com",
        name: "Rem User",
        password: "senha-segura-123",
      });
      const identity = await upsertUnknownIdentity(db, {
        phoneE164: "+5561933000001",
      });
      await pairIdentityToUser(db, {
        identityId: identity.id,
        userId: a.user.id,
      });
      const [conv] = await db
        .insert(conversations)
        .values({
          workspaceId: a.workspace.id,
          userId: a.user.id,
          whatsappIdentityId: identity.id,
          externalConversationId: "conv_rem_1",
          status: "active",
          onboardingStep: "completed",
        })
        .returning();

      const fireAt = new Date(Date.now() - 1000);
      const [rem] = await db
        .insert(reminders)
        .values({
          workspaceId: a.workspace.id,
          userId: a.user.id,
          title: "Ligar para Marcos",
          fireAt,
          timezone: "America/Sao_Paulo",
          status: "scheduled",
        })
        .returning();

      const q1 = await queueDueReminders(db);
      expect(q1.queued).toBe(1);
      const q2 = await queueDueReminders(db);
      expect(q2.queued).toBe(0);

      await drainJobs("rem");
      const after = await db.query.reminders.findFirst({
        where: eq(reminders.id, rem.id),
      });
      expect(after?.status).toBe("sent");
      expect(getZernioMockSends().length).toBeGreaterThanOrEqual(1);

      // retry same delivery job idempotency — no second job
      const jobs = await db.query.agentJobs.findMany({
        where: eq(agentJobs.jobType, "deliver_reminder"),
      });
      expect(jobs).toHaveLength(1);

      // appointment
      const starts = DateTime.now()
        .setZone("America/Sao_Paulo")
        .plus({ days: ((2 - DateTime.now().setZone("America/Sao_Paulo").weekday + 7) % 7) || 7 })
        .set({ hour: 14, minute: 0, second: 0, millisecond: 0 });

      // use agent turn for agenda
      const [runJob] = await db
        .insert(agentJobs)
        .values({
          jobType: "inbound_message",
          workspaceId: a.workspace.id,
          conversationId: conv.id,
          payload: {},
          status: "processing",
        })
        .returning();
      const [run] = await db
        .insert(
          (await import("@/db/schema")).agentRuns
        )
        .values({
          jobId: runJob.id,
          workspaceId: a.workspace.id,
          conversationId: conv.id,
          status: "running",
        })
        .returning();

      const created = await runAgentTurn(db, {
        agentRunId: run.id,
        userId: a.user.id,
        workspaceId: a.workspace.id,
        conversationId: conv.id,
        userText: "Agenda reunião com Marcos terça às 14h.",
        timezone: "America/Sao_Paulo",
      });
      expect(created.toolCount).toBeGreaterThanOrEqual(1);

      const appts = await db.query.appointments.findMany({
        where: eq(appointments.workspaceId, a.workspace.id),
      });
      expect(appts.length).toBeGreaterThanOrEqual(1);
      expect(appts[0].timezone).toBe("America/Sao_Paulo");

      const listed = await runAgentTurn(db, {
        agentRunId: run.id,
        userId: a.user.id,
        workspaceId: a.workspace.id,
        conversationId: conv.id,
        userText: "O que tenho terça?",
        timezone: "America/Sao_Paulo",
      });
      expect(listed.reply.toLowerCase()).toMatch(/reuni|marcos|compromisso|14/);
      void starts;
    });
  });

  describe("Documentos", () => {
    it("23-30,34) PDF/texto pipeline + isolamento + resumo", async () => {
      const a = await registerUser(db, {
        email: "doc-a@example.com",
        name: "Doc A",
        password: "senha-segura-123",
      });
      const b = await registerUser(db, {
        email: "doc-b@example.com",
        name: "Doc B",
        password: "senha-segura-123",
      });
      const idA = await upsertUnknownIdentity(db, { phoneE164: "+5561944000001" });
      await pairIdentityToUser(db, { identityId: idA.id, userId: a.user.id });
      const [conv] = await db
        .insert(conversations)
        .values({
          workspaceId: a.workspace.id,
          userId: a.user.id,
          whatsappIdentityId: idA.id,
          externalConversationId: "conv_doc_a",
          status: "active",
          onboardingStep: "completed",
        })
        .returning();

      const buffer = Buffer.from(
        "Contrato do João. Valor do contrato: R$ 1500,00. Cláusula de sigilo.",
        "utf8"
      );
      const doc = await ingestInboundDocument(db, {
        workspaceId: a.workspace.id,
        userId: a.user.id,
        conversationId: conv.id,
        filename: "contrato-joao.txt",
        mimeType: "text/plain",
        buffer,
        caption: "Guarda esse contrato.",
      });
      expect(doc.status).toBe("processing");

      await processDocumentJob(db, doc.id);
      const ready = await db.query.documents.findFirst({
        where: eq(documents.id, doc.id),
      });
      expect(ready?.status).toBe("indexed");
      const chunks = await db.query.documentChunks.findMany({
        where: eq(documentChunks.documentId, doc.id),
      });
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks[0].embedding?.length).toBe(1536);

      const [runJob] = await db
        .insert(agentJobs)
        .values({
          jobType: "inbound_message",
          workspaceId: a.workspace.id,
          conversationId: conv.id,
          payload: {},
          status: "processing",
        })
        .returning();
      const { agentRuns } = await import("@/db/schema");
      const [run] = await db
        .insert(agentRuns)
        .values({
          jobId: runJob.id,
          workspaceId: a.workspace.id,
          conversationId: conv.id,
          status: "running",
        })
        .returning();

      const search = await runAgentTurn(db, {
        agentRunId: run.id,
        userId: a.user.id,
        workspaceId: a.workspace.id,
        conversationId: conv.id,
        userText: "Qual o valor daquele contrato do João?",
        timezone: "America/Sao_Paulo",
      });
      expect(search.reply).toMatch(/1500/);

      const summary = await runAgentTurn(db, {
        agentRunId: run.id,
        userId: a.user.id,
        workspaceId: a.workspace.id,
        conversationId: conv.id,
        userText: "Resume esse PDF.",
        timezone: "America/Sao_Paulo",
      });
      expect(summary.reply.toLowerCase()).toMatch(/contrato|joão|joao|1500/);

      // B cannot see A's chunks via tool context
      const searchTool = getTool("search_documents")!;
      const bResult = await searchTool.handler(
        {
          db,
          userId: b.user.id,
          workspaceId: b.workspace.id,
          conversationId: conv.id,
          agentRunId: run.id,
          timezone: "America/Sao_Paulo",
        },
        { query: "contrato João 1500" }
      );
      expect(bResult.summary).not.toMatch(/1500/);
    });
  });

  describe("Segurança", () => {
    it("31-33) webhook duplicado, SSRF, tool workspace", async () => {
      const payload = inboundPayload({ eventId: "sec-dup-1", phone: "+5561955000001" });
      const { rawBody, signature } = signedBody(payload);
      const a1 = await handleZernioWebhook(db, { rawBody, signature });
      const a2 = await handleZernioWebhook(db, { rawBody, signature });
      expect(a1.body.duplicate).toBe(false);
      expect(a2.body.duplicate).toBe(true);

      await expect(assertSafeRemoteUrl("http://127.0.0.1/secret")).rejects.toThrow();
      await expect(assertSafeRemoteUrl("http://localhost/x")).rejects.toThrow();
    });
  });

  describe("E2E harness", () => {
    it("aceitação memória / lembrete / agenda entre A e B", async () => {
      const a = await registerUser(db, {
        email: "e2e-a@example.com",
        name: "E2E A",
        password: "senha-segura-123",
      });
      const b = await registerUser(db, {
        email: "e2e-b@example.com",
        name: "E2E B",
        password: "senha-segura-123",
      });
      const harness = createConversationHarness(db);
      const userA = {
        label: "E2EA",
        phone: "+5561966000001",
        externalConversationId: "e2e_a",
      };
      const userB = {
        label: "E2EB",
        phone: "+5561966000002",
        externalConversationId: "e2e_b",
      };
      for (const [u, reg] of [
        [userA, a],
        [userB, b],
      ] as const) {
        const id = await upsertUnknownIdentity(db, { phoneE164: u.phone });
        await pairIdentityToUser(db, {
          identityId: id.id,
          userId: reg.user.id,
        });
        await db.insert(conversations).values({
          workspaceId: reg.workspace.id,
          userId: reg.user.id,
          whatsappIdentityId: id.id,
          externalConversationId: u.externalConversationId,
          status: "active",
          onboardingStep: "completed",
        });
      }

      await harness.sendAs(userA, "Guarda que meu contador é Marcos.");
      const ask = await harness.sendAs(userA, "Quem é meu contador?");
      expect(ask.lastReply?.toLowerCase()).toContain("marcos");

      const askB = await harness.sendAs(userB, "Quem é meu contador?");
      expect(askB.lastReply?.toLowerCase() || "").not.toContain("marcos");

      await harness.sendAs(
        userA,
        "Me lembra amanhã às 9h de ligar para Marcos."
      );
      expect(
        (
          await db.query.reminders.findMany({
            where: eq(reminders.workspaceId, a.workspace.id),
          })
        ).length
      ).toBeGreaterThanOrEqual(1);

      await harness.sendAs(userA, "Agenda reunião terça às 14h.");
      const appts = await db.query.appointments.findMany({
        where: eq(appointments.workspaceId, a.workspace.id),
      });
      expect(appts.length).toBeGreaterThanOrEqual(1);

      const day = await harness.sendAs(userA, "O que tenho terça?");
      expect(day.lastReply?.toLowerCase()).toMatch(/reuni|14|compromisso/);
    });
  });
});
