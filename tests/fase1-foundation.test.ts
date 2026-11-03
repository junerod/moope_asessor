import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import {
  createTestDb,
  truncateAll,
  signedBody,
  inboundPayload,
} from "./helpers/db";
import { handleZernioWebhook } from "@/services/inbound-webhook";
import { registerUser } from "@/lib/auth";
import {
  findWhatsappIdentity,
  pairIdentityToUser,
  upsertUnknownIdentity,
} from "@/domain/whatsapp-identities";
import {
  claimJobs,
  enqueueAgentJob,
  failJob,
} from "@/domain/jobs";
import { processAgentJob } from "@/worker/process-job";
import {
  getZernioMockSends,
  resetZernioMock,
  setZernioMockFailNext,
  verifyZernioSignature,
  computeZernioSignature,
} from "@/channels/zernio";
import {
  saveMemoryInWorkspace,
  searchMemoriesInWorkspace,
  searchTasksInWorkspace,
  searchRemindersInWorkspace,
  searchDocumentChunksInWorkspace,
  createDocumentWithChunk,
} from "@/domain/isolation";
import { tasks, reminders, messages, agentJobs } from "@/db/schema";
import type { Db } from "@/db/client";
import type postgres from "postgres";

describe("Fase 1 — fundação", () => {
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
  });

  it("1) rejeita assinatura inválida de webhook", async () => {
    const payload = inboundPayload();
    const rawBody = JSON.stringify(payload);
    const result = await handleZernioWebhook(db, {
      rawBody,
      signature: "deadbeef",
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: "invalid_signature" });
  });

  it("2) webhook duplicado é idempotente", async () => {
    const payload = inboundPayload({ eventId: "dup-event-1" });
    const { rawBody, signature } = signedBody(payload);

    const first = await handleZernioWebhook(db, { rawBody, signature });
    const second = await handleZernioWebhook(db, { rawBody, signature });

    expect(first.ok).toBe(true);
    expect(first.body.duplicate).toBe(false);
    expect(second.ok).toBe(true);
    expect(second.body.duplicate).toBe(true);

    const events = await sql`select count(*)::int as c from webhook_events`;
    expect(events[0].c).toBe(1);

    const jobs = await sql`select count(*)::int as c from agent_jobs`;
    expect(jobs[0].c).toBe(1);
  });

  it("3) resolve identidade por telefone", async () => {
    await upsertUnknownIdentity(db, {
      phoneE164: "+5561888000001",
      displayName: "Phone User",
    });
    const found = await findWhatsappIdentity(db, {
      phoneE164: "+5561888000001",
    });
    expect(found?.phoneE164).toBe("+5561888000001");
    expect(found?.status).toBe("unpaired");
  });

  it("4) resolve identidade por BSUID", async () => {
    await upsertUnknownIdentity(db, {
      bsuid: "BSUID_ABC_001",
      displayName: "Bsuid User",
    });
    const found = await findWhatsappIdentity(db, { bsuid: "BSUID_ABC_001" });
    expect(found?.bsuid).toBe("BSUID_ABC_001");
  });

  it("5) usuário desconhecido entra em onboarding e enfileira job", async () => {
    const payload = inboundPayload({
      phone: "+5561777000001",
      text: "Oi",
    });
    const { rawBody, signature } = signedBody(payload);
    const result = await handleZernioWebhook(db, { rawBody, signature });
    expect(result.ok).toBe(true);
    expect(result.body.paired).toBe(false);

    const identity = await findWhatsappIdentity(db, {
      phoneE164: "+5561777000001",
    });
    expect(identity?.userId).toBeNull();
    expect(identity?.status).toBe("unpaired");

    const jobs = await db.query.agentJobs.findMany();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].jobType).toBe("onboarding_message");
  });

  it("6) usuário pareado processa mensagem no workspace", async () => {
    const registered = await registerUser(db, {
      email: "paired@example.com",
      name: "Paired User",
      password: "senha-segura-123",
    });
    const identity = await upsertUnknownIdentity(db, {
      phoneE164: "+5561666000001",
      displayName: "Paired",
    });
    await pairIdentityToUser(db, {
      identityId: identity.id,
      userId: registered.user.id,
    });

    const payload = inboundPayload({
      phone: "+5561666000001",
      text: "Guarda isso",
    });
    const { rawBody, signature } = signedBody(payload);
    const result = await handleZernioWebhook(db, { rawBody, signature });
    expect(result.ok).toBe(true);
    expect(result.body.paired).toBe(true);
    expect(result.body.job_id).toBeTruthy();

    const jobs = await db.query.agentJobs.findMany();
    expect(jobs[0].jobType).toBe("inbound_message");
    expect(jobs[0].workspaceId).toBe(registered.workspace.id);
  });

  it("7) criação de workspace pessoal no registro", async () => {
    const result = await registerUser(db, {
      email: "owner@example.com",
      name: "Owner Test",
      password: "senha-segura-123",
    });
    expect(result.workspace.type).toBe("personal");
    expect(result.workspace.owner_user_id).toBe(result.user.id);
    expect(result.user.global_user_id).toBeNull();

    const members = await sql`
      select role from workspace_members
      where workspace_id = ${result.workspace.id}
        and user_id = ${result.user.id}
    `;
    expect(members[0].role).toBe("owner");
  });

  it("8) isolamento entre usuários/workspaces (memories/docs/tasks/reminders)", async () => {
    const a = await registerUser(db, {
      email: "user-a@example.com",
      name: "User A",
      password: "senha-segura-123",
    });
    const b = await registerUser(db, {
      email: "user-b@example.com",
      name: "User B",
      password: "senha-segura-123",
    });

    await saveMemoryInWorkspace(db, {
      workspaceId: a.workspace.id,
      userId: a.user.id,
      content: "Meu fornecedor secreto é Empresa XPTO.",
    });

    const bMemories = await searchMemoriesInWorkspace(db, {
      workspaceId: b.workspace.id,
      query: "fornecedor secreto",
    });
    expect(bMemories).toHaveLength(0);

    const aMemories = await searchMemoriesInWorkspace(db, {
      workspaceId: a.workspace.id,
      query: "fornecedor secreto",
    });
    expect(aMemories).toHaveLength(1);

    await createDocumentWithChunk(db, {
      workspaceId: a.workspace.id,
      userId: a.user.id,
      filename: "contrato.txt",
      content: "Contrato secreto com Empresa XPTO",
      storageKey: "private/a/contrato.txt",
    });
    const bDocs = await searchDocumentChunksInWorkspace(db, {
      workspaceId: b.workspace.id,
      query: "Empresa XPTO",
    });
    expect(bDocs).toHaveLength(0);

    await db.insert(tasks).values({
      workspaceId: a.workspace.id,
      createdByUserId: a.user.id,
      title: "Tarefa secreta XPTO",
    });
    const bTasks = await searchTasksInWorkspace(db, {
      workspaceId: b.workspace.id,
      query: "XPTO",
    });
    expect(bTasks).toHaveLength(0);

    await db.insert(reminders).values({
      workspaceId: a.workspace.id,
      userId: a.user.id,
      title: "Lembrete secreto XPTO",
      fireAt: new Date(Date.now() + 3600_000),
      timezone: "America/Sao_Paulo",
    });
    const bReminders = await searchRemindersInWorkspace(db, {
      workspaceId: b.workspace.id,
      query: "XPTO",
    });
    expect(bReminders).toHaveLength(0);
  });

  it("9) enqueue idempotente", async () => {
    const first = await enqueueAgentJob(db, {
      jobType: "inbound_message",
      payload: { text: "a" },
      idempotencyKey: "idem-1",
    });
    const second = await enqueueAgentJob(db, {
      jobType: "inbound_message",
      payload: { text: "b" },
      idempotencyKey: "idem-1",
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    const count = await sql`select count(*)::int as c from agent_jobs`;
    expect(count[0].c).toBe(1);
  });

  it("10) retry de job após falha", async () => {
    const { job } = await enqueueAgentJob(db, {
      jobType: "inbound_message",
      payload: {},
      maxAttempts: 3,
    });
    const claimed = await claimJobs(db, { workerId: "w1", limit: 1 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0].attempts).toBe(1);

    const outcome = await failJob(db, claimed[0], "boom");
    expect(outcome).toBe("retry");

    const refreshed = await db.query.agentJobs.findFirst({
      where: eq(agentJobs.id, job.id),
    });
    expect(refreshed?.status).toBe("retry");
    expect(refreshed?.lastError).toBe("boom");
    expect(refreshed?.availableAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("11) falha de envio Zernio marca retry/failed path", async () => {
    const registered = await registerUser(db, {
      email: "sendfail@example.com",
      name: "Send Fail",
      password: "senha-segura-123",
    });
    const identity = await upsertUnknownIdentity(db, {
      phoneE164: "+5561555000001",
    });
    await pairIdentityToUser(db, {
      identityId: identity.id,
      userId: registered.user.id,
    });

    const payload = inboundPayload({
      phone: "+5561555000001",
      text: "teste falha",
      conversationId: "ext_conv_fail",
    });
    const { rawBody, signature } = signedBody(payload);
    await handleZernioWebhook(db, { rawBody, signature });

    setZernioMockFailNext(true);
    const claimed = await claimJobs(db, { workerId: "w-fail", limit: 1 });
    expect(claimed).toHaveLength(1);
    await processAgentJob(db, claimed[0]);

    const refreshed = await db.query.agentJobs.findFirst({
      where: eq(agentJobs.id, claimed[0].id),
    });
    expect(refreshed?.status).toBe("retry");
    expect(refreshed?.lastError).toContain("zernio_mock_forced_failure");
    expect(getZernioMockSends()).toHaveLength(0);
  });

  it("12) mensagem não vaza para outro workspace", async () => {
    const a = await registerUser(db, {
      email: "msg-a@example.com",
      name: "Msg A",
      password: "senha-segura-123",
    });
    const b = await registerUser(db, {
      email: "msg-b@example.com",
      name: "Msg B",
      password: "senha-segura-123",
    });

    const identityA = await upsertUnknownIdentity(db, {
      phoneE164: "+5561444000001",
    });
    await pairIdentityToUser(db, {
      identityId: identityA.id,
      userId: a.user.id,
    });

    const payload = inboundPayload({
      phone: "+5561444000001",
      text: "Segredo do workspace A",
    });
    const { rawBody, signature } = signedBody(payload);
    await handleZernioWebhook(db, { rawBody, signature });

    const leaked = await db.query.messages.findMany({
      where: eq(messages.workspaceId, b.workspace.id),
    });
    expect(leaked).toHaveLength(0);

    const owned = await db.query.messages.findMany({
      where: eq(messages.workspaceId, a.workspace.id),
    });
    expect(owned.length).toBeGreaterThan(0);
    expect(owned.some((m) => m.bodyText?.includes("Segredo"))).toBe(true);
  });

  it("fluxo real webhook → job → worker → adapter mock", async () => {
    const registered = await registerUser(db, {
      email: "flow@example.com",
      name: "Flow User",
      password: "senha-segura-123",
    });
    const identity = await upsertUnknownIdentity(db, {
      phoneE164: "+5561333000001",
    });
    await pairIdentityToUser(db, {
      identityId: identity.id,
      userId: registered.user.id,
    });

    const payload = inboundPayload({
      phone: "+5561333000001",
      text: "Oi assessor",
      conversationId: "ext_conv_flow",
    });
    const { rawBody, signature } = signedBody(payload);
    expect(
      verifyZernioSignature({
        secret: process.env.ZERNIO_WEBHOOK_SECRET!,
        rawBody,
        presented: signature,
      })
    ).toBe(true);

    const result = await handleZernioWebhook(db, { rawBody, signature });
    expect(result.ok).toBe(true);

    const claimed = await claimJobs(db, { workerId: "w-flow", limit: 1 });
    await processAgentJob(db, claimed[0]);

    const job = await db.query.agentJobs.findFirst({
      where: eq(agentJobs.id, claimed[0].id),
    });
    expect(job?.status).toBe("completed");

    const sends = getZernioMockSends();
    expect(sends).toHaveLength(1);
    expect(sends[0].message.length).toBeGreaterThan(0);
    expect(sends[0].conversationId).toBe("ext_conv_flow");

    const outbound = await db.query.messages.findMany({
      where: eq(messages.direction, "outbound"),
    });
    expect(outbound.some((m) => m.status === "sent")).toBe(true);
  });

  it("hmac helper produz assinatura estável", () => {
    const body = '{"id":"1","event":"webhook.test"}';
    const a = computeZernioSignature("secret", body);
    const b = computeZernioSignature("secret", body);
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });
});
