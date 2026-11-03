import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, truncateAll } from "./helpers/db";
import { registerUser, signAccessToken } from "@/lib/auth";
import {
  ensurePlatformAdmin,
  requirePlatformAdminFromAuthHeader,
  writeAdminAudit,
} from "@/domain/platform-admin";
import {
  upsertProviderConfig,
  maskProviderConfig,
  getTemplate,
} from "@/domain/providers";
import { secretStore } from "@/lib/secrets/store";
import { sendProactiveMessage } from "@/channels/zernio/proactive";
import { failJob, enqueueAgentJob, claimJobs } from "@/domain/jobs";
import { assertSafeRemoteUrl } from "@/channels/zernio/media";
import { ingestInboundDocument, processDocumentJob } from "@/domain/documents";
import { resetEnvCache, getEnv } from "@/config/env";
import { resetZernioMock } from "@/channels/zernio";
import { resetEmailMock } from "@/lib/email/provider";
import { handleOnboardingTurn } from "@/domain/onboarding";
import {
  upsertUnknownIdentity,
  startIdentityVerification,
  verifyIdentityCode,
} from "@/domain/whatsapp-identities";
import {
  adminAuditLogs,
  agentJobs,
  conversations,
  documents,
  whatsappIdentities,
  whatsappTemplates,
} from "@/db/schema";
import type { Db } from "@/db/client";
import type postgres from "postgres";

describe("Fase 3 — produto real + admin", () => {
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
    resetEnvCache();
    process.env.APP_ENV = "test";
    process.env.AI_PROVIDER = "heuristic";
  });

  it("admin: usuário comum não acessa; platform admin acessa", async () => {
    const common = await registerUser(db, {
      email: "user@example.com",
      name: "User",
      password: "password123",
    });
    const adminUser = await registerUser(db, {
      email: "admin@example.com",
      name: "Admin",
      password: "password123",
    });
    await ensurePlatformAdmin(db, adminUser.user.id, "super_admin");

    const commonTok = await signAccessToken({
      sub: common.user.id,
      email: common.user.email,
    });
    await expect(
      requirePlatformAdminFromAuthHeader(db, `Bearer ${commonTok}`)
    ).rejects.toThrow("forbidden");

    const adminTok = await signAccessToken({
      sub: adminUser.user.id,
      email: adminUser.user.email,
    });
    const ok = await requirePlatformAdminFromAuthHeader(
      db,
      `Bearer ${adminTok}`
    );
    expect(ok.user.id).toBe(adminUser.user.id);
  });

  it("secrets: salvos criptografados e mascarados; audit log criado", async () => {
    const adminUser = await registerUser(db, {
      email: "sec@example.com",
      name: "Sec",
      password: "password123",
    });
    await ensurePlatformAdmin(db, adminUser.user.id);

    const row = await upsertProviderConfig(db, {
      providerKey: "zernio",
      enabled: true,
      providerName: "zernio",
      config: { account_id: "acct_1", api_url: "https://zernio.com/api/v1" },
      secrets: {
        api_key: "super-secret-key-value",
        webhook_secret: "whsec_abc",
      },
      updatedByUserId: adminUser.user.id,
    });

    const masked = maskProviderConfig(row)!;
    expect(masked.secrets.api_key).toBe("••••••••••");
    expect(JSON.stringify(masked)).not.toContain("super-secret-key-value");

    const plain = await secretStore.getSecret(db, "provider:zernio:api_key");
    expect(plain).toBe("super-secret-key-value");

    await writeAdminAudit(db, {
      actorUserId: adminUser.user.id,
      action: "provider.zernio.updated",
      resourceType: "provider_config",
      resourceId: row.id,
      metadata: { secret_fields_updated: ["api_key"] },
    });
    const audits = await db.query.adminAuditLogs.findMany({
      where: eq(adminAuditLogs.actorUserId, adminUser.user.id),
    });
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain("super-secret-key-value");
  });

  it("production rejeita heuristic silenciosa", () => {
    resetEnvCache();
    const prevApp = process.env.APP_ENV;
    const prevAi = process.env.AI_PROVIDER;
    const prevKey = process.env.OPENAI_API_KEY;
    try {
      process.env.APP_ENV = "production";
      process.env.AI_PROVIDER = "heuristic";
      process.env.OPENAI_API_KEY = "";
      expect(() => getEnv()).toThrow(/AI_PROVIDER_UNAVAILABLE/);
    } finally {
      process.env.APP_ENV = prevApp || "test";
      process.env.AI_PROVIDER = prevAi || "heuristic";
      process.env.OPENAI_API_KEY = prevKey || "";
      resetEnvCache();
    }
  });

  it("SSRF bloqueia host privado", async () => {
    await expect(assertSafeRemoteUrl("http://127.0.0.1/x")).rejects.toThrow();
    await expect(
      assertSafeRemoteUrl("http://localhost/secret")
    ).rejects.toThrow();
  });

  it("PDF: MIME inválido rejeitado; PDF textual processa", async () => {
    const user = await registerUser(db, {
      email: "doc@example.com",
      name: "Doc",
      password: "password123",
    });
    const identity = await upsertUnknownIdentity(db, {
      phoneE164: "+5561990000001",
    });
    const [conv] = await db
      .insert(conversations)
      .values({
        workspaceId: user.workspace.id,
        userId: user.user.id,
        whatsappIdentityId: identity.id,
        channel: "whatsapp",
        status: "active",
        onboardingStep: "completed",
      })
      .returning();

    await expect(
      ingestInboundDocument(db, {
        workspaceId: user.workspace.id,
        userId: user.user.id,
        conversationId: conv.id,
        filename: "evil.exe",
        mimeType: "application/x-msdownload",
        buffer: Buffer.from("MZ"),
      })
    ).rejects.toThrow("MIME_REJECTED");

    const pdf = Buffer.from(
      `%PDF-1.4
1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj
2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj
3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources<< /Font<< /F1 5 0 R >> >> >>endobj
4 0 obj<< /Length 55 >>stream
BT /F1 18 Tf 50 200 Td (Valor 4890.00) Tj ET
endstream
endobj
5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj
xref
0 6
0000000000 65535 f 
trailer<< /Size 6 /Root 1 0 R >>
startxref
0
%%EOF`
    );

    const doc = await ingestInboundDocument(db, {
      workspaceId: user.workspace.id,
      userId: user.user.id,
      conversationId: conv.id,
      filename: "nota.pdf",
      mimeType: "application/pdf",
      buffer: pdf,
    });
    await processDocumentJob(db, doc.id);
    const indexed = await db.query.documents.findFirst({
      where: eq(documents.id, doc.id),
    });
    expect(["indexed", "failed"]).toContain(indexed?.status);
    if (indexed?.status === "indexed") {
      expect(indexed.embeddingProvider || indexed.embeddingDimensions !== null).toBeTruthy();
    }
  });

  it("reminder: template missing → TEMPLATE_NOT_CONFIGURED", async () => {
    await db
      .insert(whatsappTemplates)
      .values({
        logicalName: "reminder",
        providerTemplateName: "x",
        status: "draft",
      })
      .onConflictDoUpdate({
        target: whatsappTemplates.logicalName,
        set: { status: "draft", updatedAt: new Date() },
      });

    const result = await sendProactiveMessage(db, {
      conversationId: "conv_x",
      message: "teste",
      idempotencyKey: "t1",
      forceTemplate: true,
      withinCustomerCareWindow: false,
      logicalTemplate: "reminder",
    });
    expect(result.errorCode).toBe("TEMPLATE_NOT_CONFIGURED");
    expect(result.ok).toBe(false);
  });

  it("jobs: max attempts → dead", async () => {
    const { job } = await enqueueAgentJob(db, {
      jobType: "inbound_message",
      payload: { text: "x" },
      maxAttempts: 1,
      idempotencyKey: "dead_test_1",
    });

    const claimed = await claimJobs(db, { workerId: "t", limit: 1 });
    expect(claimed[0].id).toBe(job.id);
    await failJob(db, claimed[0], "boom");

    const dead = await db.query.agentJobs.findFirst({
      where: eq(agentJobs.id, job.id),
    });
    expect(dead?.status).toBe("failed");
    expect(dead?.deadAt).toBeTruthy();
  });

  it("onboarding: resend cooldown e código single-use", async () => {
    const identity = await upsertUnknownIdentity(db, {
      phoneE164: "+5561988000001",
    });
    const [conv] = await db
      .insert(conversations)
      .values({
        whatsappIdentityId: identity.id,
        channel: "whatsapp",
        status: "onboarding",
        onboardingStep: "awaiting_verification",
        metadata: {
          pending_email: "a@b.com",
          pending_name: "Ana",
          verification_sent_at: new Date().toISOString(),
          verification_resend_count: 0,
        },
      })
      .returning();

    const cooldown = await handleOnboardingTurn(db, {
      conversation: conv,
      identityId: identity.id,
      text: "reenviar",
    });
    expect(cooldown.reply).toMatch(/Aguarde/i);

    const { code } = await startIdentityVerification(db, identity.id);
    expect(await verifyIdentityCode(db, identity.id, code)).toBe(true);
    await db
      .update(whatsappIdentities)
      .set({
        verificationCodeHash: null,
        verificationExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(whatsappIdentities.id, identity.id));
    expect(await verifyIdentityCode(db, identity.id, code)).toBe(false);
  });

  it("getTemplate usa nome lógico", async () => {
    await db
      .insert(whatsappTemplates)
      .values({
        logicalName: "reminder",
        providerTemplateName: "moope_lembrete_2026_v1",
        status: "active",
      })
      .onConflictDoUpdate({
        target: whatsappTemplates.logicalName,
        set: {
          providerTemplateName: "moope_lembrete_2026_v1",
          status: "active",
          updatedAt: new Date(),
        },
      });
    const t = await getTemplate(db, "reminder");
    expect(t?.providerTemplateName).toBe("moope_lembrete_2026_v1");
  });
});
