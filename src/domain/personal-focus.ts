import { phoneDigitVariants, phoneDigitsOnly } from "@/domain/access-whitelist";

/**
 * Números em foco só no Assessor pessoal (homolog / DEV).
 * Env: ASSESSOR_PERSONAL_FOCUS_PHONES=5561996715985,61996715985
 * (vírgula; com ou sem +55 / 9º dígito)
 */
export function personalFocusPhoneList(): string[] {
  const raw = String(process.env.ASSESSOR_PERSONAL_FOCUS_PHONES || "").trim();
  if (!raw) return [];
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True se este WhatsApp deve ignorar locadora/IoT/Facejus por enquanto. */
export function isPersonalFocusPhone(phone: string | null | undefined): boolean {
  if (!phone) return false;
  const configured = personalFocusPhoneList();
  if (!configured.length) return false;
  const variants = new Set(phoneDigitVariants(phone));
  const digits = phoneDigitsOnly(phone);
  if (digits) variants.add(digits);
  for (const cfg of configured) {
    for (const v of phoneDigitVariants(cfg)) {
      if (variants.has(v)) return true;
    }
    const d = phoneDigitsOnly(cfg);
    if (d && variants.has(d)) return true;
  }
  return false;
}

export const PERSONAL_FOCUS_REPLY =
  "Por enquanto neste número estamos *só no Assessor pessoal* (gastos, agenda, lembretes, Google, relatórios).\n\nLocadora / IoT (Bistek) e Facejus ficam pausados aqui pra não misturar o teste.";
