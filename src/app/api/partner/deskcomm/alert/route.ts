import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { getEnv } from "@/config/env";
import {
  addToWhitelist,
  removeFromWhitelistByPhone,
} from "@/domain/access-whitelist";
import { notifyAssessorPhones, fanoutSummary } from "@/domain/fanout-notify";
import { devQuerAlertaCrm, isDevAlertPhone } from "@/domain/crm-dev-alerts";

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

const schema = z.object({
  action: z.enum(["alert", "add", "remove"]),
  phone: z.string().min(8).max(24).optional(),
  phones: z.array(z.string().min(8).max(24)).max(20).optional(),
  line_label: z.string().max(80).optional().nullable(),
  client_name: z.string().max(120).optional().nullable(),
  client_phone: z.string().max(24).optional().nullable(),
  organization: z.string().max(120).optional().nullable(),
  conversation_id: z.string().max(80).optional().nullable(),
  notice: z.enum(["new", "reply", "whatsapp_down"]).optional(),
  preview: z.string().max(800).optional().nullable(),
  event_id: z.string().max(80).optional().nullable(),
});

/**
 * Deskcomm CRM: libera o WhatsApp no Assessor e avisa quando entra cliente novo.
 * Auth: mesmo secret da locadora (X-Assessor-Moope-Secret).
 */
export async function POST(req: NextRequest) {
  if (!assertPartnerSecret(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  const db = getDb();
  const body = parsed.data;

  try {
    const phone = body.phone;
    if (body.action === "add" || body.action === "remove") {
      if (!phone) {
        return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
      }
    }

    if (body.action === "add" && phone) {
      const entry = await addToWhitelist(db, {
        phone,
        label: "MOOPE CRM · MOOPE Assessor",
        notes: body.organization
          ? `Liberado pelo CRM · ${body.organization}`
          : "Liberado pelo CRM",
      });
      return NextResponse.json({
        ok: true,
        action: "add",
        phone_e164: entry.phoneE164,
      });
    }

    if (body.action === "remove" && phone) {
      const result = await removeFromWhitelistByPhone(db, phone);
      return NextResponse.json({ ok: true, action: "remove", removed: result.removed });
    }

    const nome = (body.client_name || (body.notice === "reply" ? "Lead" : "Cliente novo")).trim();
    const fone = (body.client_phone || "").trim();
    const org = (body.organization || "CRM").trim();
    const trecho = (body.preview || "").trim().slice(0, 400);
    const linha = (body.line_label || "").trim();
    const resposta = body.notice === "reply";
    const queda = body.notice === "whatsapp_down";
    const text = queda
      ? (body.preview || "").trim() ||
        ["⚠️ *WhatsApp do CRM caiu*", `_${org}_`].join("\n")
      : resposta
        ? [
            "💬 *Lead respondeu no CRM*",
            `_${org}_`,
            "────────────",
            `👤 *${nome}*${fone ? ` · ${fone}` : ""}`,
            trecho ? `💬 ${trecho}` : "💬 Mandou outra mensagem.",
            "────────────",
            "_Responda no *CRM*. Não precisa responder neste WhatsApp._",
          ].join("\n")
        : [
            "🔔 *Cliente novo no CRM*",
            `_${org}_`,
            "────────────",
            linha ? `📥 Entrou pelo *${linha}*` : null,
            `👤 *${nome}*${fone ? ` · ${fone}` : ""}`,
            trecho ? `💬 ${trecho}` : "💬 Mandou a primeira mensagem.",
            "────────────",
            "_Entre no *MOOPE CRM* e responda por lá._",
          ]
            .filter((l): l is string => Boolean(l))
            .join("\n");

    const devOn = await devQuerAlertaCrm(db);
    const allPhones = [
      ...new Set(
        [body.phone, ...(body.phones || [])].filter((p): p is string => Boolean(p && p.trim())),
      ),
    ];
    if (!allPhones.length) {
      return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
    }
    const phones = allPhones.filter((p) => devOn || !isDevAlertPhone(p));
    if (!phones.length) {
      return NextResponse.json({ ok: true, action: "alert", skipped: "dev_paused" });
    }

    const chaveEvento = queda
      ? body.event_id || "down"
      : resposta
        ? body.event_id || body.conversation_id || "x"
        : body.conversation_id || "x";
    const prefixo = queda ? "crm-down" : resposta ? "crm-reply" : "crm-new";
    const results = await notifyAssessorPhones(db, {
      phones,
      text,
      keyForPhone: (dest) =>
        `${prefixo}:${chaveEvento}:${dest.replace(/\D/g, "").slice(-11)}`,
    });
    const sum = fanoutSummary(results);
    if (!sum.allOk) {
      const reason = sum.failed[0]?.error || "send_failed";
      const status = reason === "no_conversation" && !sum.partial ? 409 : 400;
      return NextResponse.json(
        { ok: false, error: reason, partial: sum.partial, results },
        { status }
      );
    }
    return NextResponse.json({ ok: true, action: "alert", results });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "error";
    const status = msg === "invalid_phone" ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
