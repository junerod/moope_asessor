import { getEnv } from "@/config/env";

export type AssessorWhatsAppPublic = {
  phoneE164: string | null;
  digits: string | null;
  display: string | null;
  waUrl: string | null;
};

function formatDisplay(e164: string): string {
  const d = e164.replace(/\D/g, "");
  if (d.startsWith("55") && d.length === 13) {
    return `+${d.slice(0, 2)} ${d.slice(2, 4)} ${d.slice(4, 9)}-${d.slice(9)}`;
  }
  if (d.startsWith("55") && d.length === 12) {
    return `+${d.slice(0, 2)} ${d.slice(2, 4)} ${d.slice(4, 8)}-${d.slice(8)}`;
  }
  return e164.startsWith("+") ? e164 : `+${d}`;
}

function fromRaw(raw: string): AssessorWhatsAppPublic {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 10) {
    return { phoneE164: null, digits: null, display: null, waUrl: null };
  }
  const phoneE164 = raw.startsWith("+") ? raw : `+${digits}`;
  return {
    phoneE164,
    digits,
    display: formatDisplay(phoneE164),
    waUrl: `https://wa.me/${digits}?text=${encodeURIComponent("Oi")}`,
  };
}

/**
 * Número público do Assessor (WhatsApp Business).
 * Env: ASSESSOR_WHATSAPP_E164 — senão canal ASSISTANT / official_number no banco.
 */
export async function getAssessorWhatsAppPublic(): Promise<AssessorWhatsAppPublic> {
  const empty: AssessorWhatsAppPublic = {
    phoneE164: null,
    digits: null,
    display: null,
    waUrl: null,
  };

  try {
    const env = getEnv();
    const fromEnv = String(env.ASSESSOR_WHATSAPP_E164 || "").trim();
    if (fromEnv) return fromRaw(fromEnv);
  } catch {
    /* ignore */
  }

  try {
    const { getDb } = await import("@/db/client");
    const { getActiveAssistantChannel } = await import(
      "@/domain/whatsapp-channels"
    );
    const db = getDb();
    const ch = await getActiveAssistantChannel(db);
    const phone = String(ch?.phoneE164 || "").trim();
    if (phone) return fromRaw(phone);

    const { resolveZernioRuntimeConfig } = await import("@/domain/providers");
    const cfg = await resolveZernioRuntimeConfig(db);
    const official = String(cfg.officialNumber || "").trim();
    if (official) return fromRaw(official);
  } catch {
    /* build / DB offline */
  }

  return empty;
}
