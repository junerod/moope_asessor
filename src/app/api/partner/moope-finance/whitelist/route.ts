import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { getEnv } from "@/config/env";
import {
  addToWhitelist,
  removeFromWhitelistByPhone,
} from "@/domain/access-whitelist";

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

/**
 * Partner: MOOPE Finance libera telefones no Assessor (whitelist).
 * Auth: mesmo secret da integração locadora (X-Assessor-Moope-Secret).
 *
 * Body: { action: "add"|"remove", phone, label?, notes? }
 */
export async function POST(req: NextRequest) {
  if (!assertPartnerSecret(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const schema = z.object({
    action: z.enum(["add", "remove"]),
    phone: z.string().min(8),
    label: z.string().max(200).optional().nullable(),
    notes: z.string().max(2000).optional().nullable(),
  });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  const db = getDb();
  const { action, phone, label, notes } = parsed.data;

  try {
    if (action === "add") {
      const entry = await addToWhitelist(db, {
        phone,
        label: label || "MOOPE Gestão · Locadora",
        notes: notes || "Liberado via Configurações → Assessor MOOPE",
      });
      return NextResponse.json({
        ok: true,
        action: "add",
        entry: {
          id: entry.id,
          phone_e164: entry.phoneE164,
          label: entry.label,
        },
      });
    }

    const result = await removeFromWhitelistByPhone(db, phone);
    return NextResponse.json({
      ok: true,
      action: "remove",
      removed: result.removed,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "error";
    const status = msg === "invalid_phone" ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
