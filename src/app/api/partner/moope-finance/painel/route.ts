import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { getEnv } from "@/config/env";
import { boardFromLocadora } from "@/domain/locadora-board";
import { findWhatsappIdentity } from "@/domain/whatsapp-identities";
import { createVisualBoard } from "@/domain/visual-board";
import { getPersonalWorkspaceForUser } from "@/domain/workspaces";

function assertPartnerSecret(req: NextRequest): boolean {
  const expected =
    getEnv().MOOPE_FINANCE_ASSESSOR_SECRET ||
    process.env.MOOPE_FINANCE_ASSESSOR_SECRET ||
    "";
  if (!expected) return false;
  const got =
    req.headers.get("x-assessor-moope-secret") ||
    req.headers.get("X-Assessor-Moope-Secret") ||
    "";
  return Boolean(got) && got === expected;
}

const bodySchema = z.object({
  phone: z.string().min(8).max(24),
  org: z.string().max(80).optional().nullable(),
  snapshot: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Meu Assessor pede um link curto do painel da locadora (vale 24h).
 */
export async function POST(req: NextRequest) {
  if (!assertPartnerSecret(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  const db = getDb();
  const identity = await findWhatsappIdentity(db, { phoneE164: parsed.data.phone });
  if (!identity?.userId) {
    return NextResponse.json({ error: "painel_sem_usuario" }, { status: 404 });
  }
  const workspace = await getPersonalWorkspaceForUser(db, identity.userId);
  if (!workspace) {
    return NextResponse.json({ error: "painel_sem_usuario" }, { status: 404 });
  }

  const org = parsed.data.org?.trim() || "Locadora";
  const payload = boardFromLocadora({
    title: "Resumo da locadora",
    org,
    text: "Inadimplência",
    snapshot: parsed.data.snapshot,
  });
  const url = await createVisualBoard(db, {
    workspaceId: workspace.id,
    userId: identity.userId,
    payload,
  });
  return NextResponse.json({ ok: true, url });
}
