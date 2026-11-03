import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, truncateAll, inboundPayload, signedBody } from "./helpers/db";
import { registerUser, signAccessToken } from "@/lib/auth";
import { requirePlatformAdminFromAuthHeader } from "@/domain/platform-admin";
import {
  upsertProviderConfig,
  resolveZernioRuntimeConfig,
} from "@/domain/providers";
import {
  setAssistantChannel,
  syncZernioChannels,
  resolveInboundAssistantChannel,
  ensureDefaultSubscription,
  getActiveAssistantChannel,
} from "@/domain/whatsapp-channels";
import {
  upsertUnknownIdentity,
  pairIdentityToUser,
} from "@/domain/whatsapp-identities";
import { createPersonalWorkspace } from "@/domain/workspaces";
import { handleZernioWebhook } from "@/services/inbound-webhook";
import { resetEnvCache } from "@/config/env";
import { resetZernioMock } from "@/channels/zernio";
import { resetEmailMock } from "@/lib/email/provider";
import {
  conversations,
  memories,
  subscriptions,
  whatsappChannels,
  whatsappIdentities,
} from "@/db/schema";
import type { Db } from "@/db/client";
import type postgres from "postgres";

describe("Ajuste final — WhatsApp-first / identity / channels", () => {
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
    process.env.ZERNIO_MOCK = "true";
  });

  it("1) sender desconhecido inicia onboarding", async () => {
    const payload = inboundPayload({ phone: "+5561999000001", text: "Oi" });
    const { rawBody, signature } = signedBody(payload);
    const res = await handleZernioWebhook(db, { rawBody, signature });
    expect(res.ok).toBe(true);
    expect(res.body).toMatchObject({ paired: false });
    const identity = await db.query.whatsappIdentities.findFirst({
      where: eq(whatsappIdentities.phoneE164, "+5561999000001"),
    });
    expect(identity?.userId).toBeNull();
    expect(identity?.status).toBe("unpaired");
  });

  it("2) sender conhecido encontra user", async () => {
    const user = await registerUser(db, {
      email: "known@example.com",
      name: "Known",
      password: "password123",
    });
    const identity = await upsertUnknownIdentity(db, {
      phoneE164: "+5561999000002",
    });
    await pairIdentityToUser(db, {
      identityId: identity.id,
      userId: user.user.id,
    });
    const payload = inboundPayload({ phone: "+5561999000002", text: "Oi" });
    const { rawBody, signature } = signedBody(payload);
    const res = await handleZernioWebhook(db, { rawBody, signature });
    expect(res.ok).toBe(true);
    expect(res.body).toMatchObject({ paired: true });
  });

  it("3) trocar receiver não troca user", async () => {
    const user = await registerUser(db, {
      email: "recv@example.com",
      name: "Recv",
      password: "password123",
    });
    const identity = await upsertUnknownIdentity(db, {
      phoneE164: "+5561999000003",
    });
    await pairIdentityToUser(db, {
      identityId: identity.id,
      userId: user.user.id,
    });
    await setAssistantChannel(db, {
      providerAccountId: "acct_a",
      phone: "+5511111111111",
    });
    const payload = inboundPayload({ phone: "+5561999000003", text: "Oi" });
    (payload.data as { account: { id: string } }).account.id = "acct_a";
    const { rawBody, signature } = signedBody(payload);
    const res = await handleZernioWebhook(db, { rawBody, signature });
    expect(res.ok).toBe(true);
    const conv = await db.query.conversations.findFirst({
      where: eq(conversations.whatsappIdentityId, identity.id),
    });
    expect(conv?.userId).toBe(user.user.id);

    await setAssistantChannel(db, {
      providerAccountId: "acct_b",
      phone: "+5522222222222",
    });
    const again = await db.query.whatsappIdentities.findFirst({
      where: eq(whatsappIdentities.id, identity.id),
    });
    expect(again?.userId).toBe(user.user.id);
  });

  it("4) phone não é user primary key", async () => {
    const user = await registerUser(db, {
      email: "pk@example.com",
      name: "PK",
      password: "password123",
    });
    expect(user.user.id).not.toBe("+5561999000004");
    const identity = await upsertUnknownIdentity(db, {
      phoneE164: "+5561999000004",
    });
    expect(identity.id).not.toBe(user.user.id);
    expect(identity.phoneE164).toBe("+5561999000004");
  });

  it("5) duas identities podem apontar para mesmo user", async () => {
    const user = await registerUser(db, {
      email: "multi@example.com",
      name: "Multi",
      password: "password123",
    });
    const a = await upsertUnknownIdentity(db, {
      phoneE164: "+5561999000010",
    });
    const b = await upsertUnknownIdentity(db, {
      phoneE164: "+5561999000011",
    });
    await pairIdentityToUser(db, { identityId: a.id, userId: user.user.id });
    await pairIdentityToUser(db, { identityId: b.id, userId: user.user.id });
    const ids = await db.query.whatsappIdentities.findMany({
      where: eq(whatsappIdentities.userId, user.user.id),
    });
    expect(ids).toHaveLength(2);
  });

  it("6) workspace isolation permanece", async () => {
    const u1 = await registerUser(db, {
      email: "w1@example.com",
      name: "W1",
      password: "password123",
    });
    const u2 = await registerUser(db, {
      email: "w2@example.com",
      name: "W2",
      password: "password123",
    });
    const ws1 = await createPersonalWorkspace(db, {
      userId: u1.user.id,
      name: "W1",
    });
    const ws2 = await createPersonalWorkspace(db, {
      userId: u2.user.id,
      name: "W2",
    });
    await db.insert(memories).values({
      workspaceId: ws1.id,
      createdByUserId: u1.user.id,
      content: "segredo w1",
      type: "note",
    });
    const leaked = await db.query.memories.findMany({
      where: eq(memories.workspaceId, ws2.id),
    });
    expect(leaked).toHaveLength(0);
  });

  it("7) subscription pertence ao workspace", async () => {
    const user = await registerUser(db, {
      email: "sub@example.com",
      name: "Sub",
      password: "password123",
    });
    const ws = await createPersonalWorkspace(db, {
      userId: user.user.id,
      name: "Sub",
    });
    const sub = await ensureDefaultSubscription(db, ws.id);
    expect(sub.workspaceId).toBe(ws.id);
    expect(sub.status).toBe("trialing");
  });

  it("8+9) troca de telefone não perde subscription nem memory", async () => {
    const user = await registerUser(db, {
      email: "swap@example.com",
      name: "Swap",
      password: "password123",
    });
    const ws = await createPersonalWorkspace(db, {
      userId: user.user.id,
      name: "Swap",
    });
    const sub = await ensureDefaultSubscription(db, ws.id);
    await db.insert(memories).values({
      workspaceId: ws.id,
      createdByUserId: user.user.id,
      content: "lembrar café",
      type: "note",
    });
    const oldId = await upsertUnknownIdentity(db, {
      phoneE164: "+5561999000020",
    });
    await pairIdentityToUser(db, {
      identityId: oldId.id,
      userId: user.user.id,
    });
    const newId = await upsertUnknownIdentity(db, {
      phoneE164: "+5561999000021",
    });
    await pairIdentityToUser(db, {
      identityId: newId.id,
      userId: user.user.id,
    });
    await db
      .update(whatsappIdentities)
      .set({ status: "revoked", deletedAt: new Date() })
      .where(eq(whatsappIdentities.id, oldId.id));

    const subAfter = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, sub.id),
    });
    expect(subAfter?.workspaceId).toBe(ws.id);
    const mems = await db.query.memories.findMany({
      where: eq(memories.workspaceId, ws.id),
    });
    expect(mems).toHaveLength(1);
  });

  it("10+11) vários números; somente um ASSISTANT ativo", async () => {
    await syncZernioChannels(db, [
      {
        account_id: "n1",
        profile_id: "p1",
        phone: "+551111",
        name: "A",
        label: "A",
      },
      {
        account_id: "n2",
        profile_id: "p2",
        phone: "+552222",
        name: "B",
        label: "B",
      },
      {
        account_id: "n3",
        profile_id: "p3",
        phone: "+553333",
        name: "C",
        label: "C",
      },
    ]);
    await setAssistantChannel(db, { providerAccountId: "n1", phone: "+551111" });
    await setAssistantChannel(db, { providerAccountId: "n3", phone: "+553333" });
    const assistants = await db.query.whatsappChannels.findMany({
      where: eq(whatsappChannels.purpose, "ASSISTANT"),
    });
    const active = assistants.filter((c) => c.isActive);
    expect(active).toHaveLength(1);
    expect(active[0].providerAccountId).toBe("n3");
    const all = await db.query.whatsappChannels.findMany();
    expect(all.length).toBeGreaterThanOrEqual(3);
  });

  it("12) inbound não-ASSISTANT ignorado quando ASSISTANT existe", async () => {
    await setAssistantChannel(db, {
      providerAccountId: "acct_official",
      phone: "+5511999999999",
    });
    const payload = inboundPayload({ phone: "+5561999000030", text: "Oi" });
    (payload.data as { account: { id: string } }).account.id = "acct_other";
    const { rawBody, signature } = signedBody(payload);
    const res = await handleZernioWebhook(db, { rawBody, signature });
    expect(res.ok).toBe(true);
    expect(res.body).toMatchObject({ ignored: true, reason: "not_assistant" });
  });

  it("13) conversation vinculada ao channel ASSISTANT", async () => {
    const channel = await setAssistantChannel(db, {
      providerAccountId: "acct_out",
      phone: "+5511888888888",
    });
    const payload = inboundPayload({ phone: "+5561999000031", text: "Oi" });
    (payload.data as { account: { id: string } }).account.id = "acct_out";
    const { rawBody, signature } = signedBody(payload);
    const res = await handleZernioWebhook(db, { rawBody, signature });
    expect(res.ok).toBe(true);
    const conversationId = String(
      (res.body as { conversation_id?: string }).conversation_id || ""
    );
    const conv = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
    });
    expect(conv?.whatsappChannelId).toBe(channel.id);
  });

  it("14) novo usuário WhatsApp aparece no Admin list concept", async () => {
    const user = await registerUser(db, {
      email: "adminlist@example.com",
      name: "AdminList",
      password: "password123",
    });
    const identity = await upsertUnknownIdentity(db, {
      phoneE164: "+5561999000040",
    });
    await pairIdentityToUser(db, {
      identityId: identity.id,
      userId: user.user.id,
    });
    const byId = await db.query.users.findFirst({
      where: (u, { eq: e }) => e(u.id, user.user.id),
    });
    expect(byId?.email).toBe("adminlist@example.com");
    const id = await db.query.whatsappIdentities.findFirst({
      where: eq(whatsappIdentities.userId, user.user.id),
    });
    expect(id?.phoneE164).toBe("+5561999000040");
  });

  it("15) usuário comum não acessa Admin", async () => {
    const common = await registerUser(db, {
      email: "common2@example.com",
      name: "Common",
      password: "password123",
    });
    const tok = await signAccessToken({
      sub: common.user.id,
      email: common.user.email,
    });
    await expect(
      requirePlatformAdminFromAuthHeader(db, `Bearer ${tok}`)
    ).rejects.toThrow("forbidden");
  });

  it("16) DB vence env para account_id do ASSISTANT", async () => {
    const admin = await registerUser(db, {
      email: "cfgadmin@example.com",
      name: "Cfg",
      password: "password123",
    });
    process.env.ZERNIO_ACCOUNT_ID = "acct_from_env";
    process.env.ZERNIO_API_KEY = "env_key";
    resetEnvCache();
    await upsertProviderConfig(db, {
      providerKey: "zernio",
      enabled: true,
      providerName: "zernio",
      config: { api_url: "https://zernio.com/api/v1", account_id: "acct_stale" },
      secrets: { api_key: "db_key_secret_value" },
      updatedByUserId: admin.user.id,
    });
    await setAssistantChannel(db, {
      providerAccountId: "acct_from_db_assistant",
      phone: "+5511000000000",
    });
    const cfg = await resolveZernioRuntimeConfig(db);
    expect(cfg.accountId).toBe("acct_from_db_assistant");
    expect(cfg.apiKey).toBe("db_key_secret_value");
    expect(cfg.mock).toBe(false);
  });

  it("17) production não cai em mock silencioso quando DB configurado", async () => {
    const admin = await registerUser(db, {
      email: "prodcfg@example.com",
      name: "Prod",
      password: "password123",
    });
    await upsertProviderConfig(db, {
      providerKey: "zernio",
      enabled: true,
      providerName: "zernio",
      config: { account_id: "acct_prod" },
      secrets: { api_key: "prod_key_value_here" },
      updatedByUserId: admin.user.id,
    });
    await setAssistantChannel(db, { providerAccountId: "acct_prod" });

    process.env.APP_ENV = "production";
    process.env.ZERNIO_MOCK = "true";
    process.env.AI_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test-prod-guard";
    resetEnvCache();

    const cfg = await resolveZernioRuntimeConfig(db);
    expect(cfg.mock).toBe(false);

    process.env.APP_ENV = "test";
    process.env.AI_PROVIDER = "heuristic";
    delete process.env.OPENAI_API_KEY;
    resetEnvCache();
  });

  it("gate: sem ASSISTANT em test permite bootstrap", async () => {
    const gate = await resolveInboundAssistantChannel(db, "anything");
    expect(gate.ok).toBe(true);
    if (gate.ok) expect(gate.bootstrap).toBe(true);
  });

  it("getActiveAssistantChannel após set", async () => {
    await setAssistantChannel(db, { providerAccountId: "only_one" });
    const a = await getActiveAssistantChannel(db);
    expect(a?.providerAccountId).toBe("only_one");
  });
});
