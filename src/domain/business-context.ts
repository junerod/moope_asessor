import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { whatsappBusinessContext } from "@/db/schema";
import { phoneDigitsOnly } from "@/domain/access-whitelist";
import { normalizePhoneE164Br } from "@/integrations/moope-finance-assessor";
import { resolveLocadoraIntegration } from "@/integrations/moope-finance-assessor";
import { facejusAgendaKind } from "@/domain/facejus-commands";
import { resolveEscritorio } from "@/integrations/facejus-assessor";

export type BusinessKind = "locadora" | "facejus";

export type BusinessOption = {
  key: string; // locadora:123 | facejus:45
  kind: BusinessKind;
  tenantId: number;
  label: string;
  papel: string;
};

export type ActiveBusinessContext = {
  kind: BusinessKind;
  tenantId: number;
  label: string;
  papel: string | null;
};

/** Frases canônicas que o Assessor ensina ao usuário. */
export const CONTEXT_SWITCH_HINT = [
  "Para ver o modo atual: *onde estou?*",
  "Para trocar: *trocar empresa* ou *mudar contexto*",
  "Ou diga direto: *agora a locadora NOME* / *agora o escritório* / *Facejus*",
].join("\n");

export function isContextSwitchIntent(text: string): boolean {
  const t = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return (
    /\bonde estou\b/.test(t) ||
    /\bqual (o )?contexto\b/.test(t) ||
    /\bmodo atual\b/.test(t) ||
    /\btrocar( de)? (empresa|contexto|locadora|escritorio)\b/.test(t) ||
    /\bmudar( de)? (empresa|contexto|locadora|escritorio)\b/.test(t) ||
    /\bmudar para\b/.test(t) ||
    /\btrocar para\b/.test(t) ||
    /\bagora (a |o )?(locadora|escritorio|facejus)\b/.test(t) ||
    /\bassumir\b/.test(t)
  );
}

export async function listBusinessOptions(
  phone: string
): Promise<BusinessOption[]> {
  const e164 = normalizePhoneE164Br(phone);
  if (!e164) return [];
  const { isPersonalFocusPhone } = await import("@/domain/personal-focus");
  if (isPersonalFocusPhone(e164)) return [];
  const out: BusinessOption[] = [];

  try {
    const loc = await resolveLocadoraIntegration(e164);
    for (const L of loc.links || []) {
      const tid = Number(L.userid);
      if (!tid) continue;
      const isIot = String((L as { modulo?: string }).modulo || "").toLowerCase() === "iot";
      out.push({
        key: `locadora:${tid}`,
        kind: "locadora",
        tenantId: tid,
        label: isIot
          ? `IoT · ${String(L.empresa_nome || `Tenant ${tid}`)}`
          : String(L.empresa_nome || `Locadora ${tid}`),
        papel: String(L.papel || (isIot ? "gerente_iot" : "gerente")),
      });
    }
  } catch {
    /* ignore */
  }

  try {
    const esc = await resolveEscritorio(e164);
    for (const L of esc.links || []) {
      const tid = Number(L.tenant_id);
      if (!tid) continue;
      out.push({
        key: `facejus:${tid}`,
        kind: "facejus",
        tenantId: tid,
        label: String(L.escritorio || `Escritório ${tid}`),
        papel: String(L.papel || "advogado"),
      });
    }
  } catch {
    /* ignore */
  }

  return dedupeBusinessOptions(out);
}

function foldLabel(value: string): string {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function companyFingerprint(label: string): string {
  return foldLabel(label)
    .replace(/^iot\s+/, "")
    .replace(/\b(ltda|ltd|me|epp|eireli|s a|sa|ss|cia|companhia)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sameCompanyName(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  return short.length >= 6 && long.includes(short);
}

function papelRank(papel: string): number {
  const p = foldLabel(papel);
  if (p === "gerente" || p === "socio") return 50;
  if (p === "financeiro") return 40;
  if (p === "operacao") return 20;
  if (p === "atendimento" || p === "advogado") return 10;
  if (p === "dev" || p === "usuario" || p === "user" || p === "custom") return 1;
  return 15;
}

function preferBusinessOption(a: BusinessOption, b: BusinessOption): BusinessOption {
  const ra = papelRank(a.papel);
  const rb = papelRank(b.papel);
  if (rb !== ra) return rb > ra ? b : a;
  if (b.label.length !== a.label.length) return b.label.length > a.label.length ? b : a;
  return a.tenantId <= b.tenantId ? a : b;
}

/** Mesma empresa duas vezes (dev + usuário no Finance, ou mesmo nome) vira uma linha. */
export function dedupeBusinessOptions(options: BusinessOption[]): BusinessOption[] {
  const groups: BusinessOption[][] = [];
  for (const option of options) {
    const idKey = `${option.kind}:${option.tenantId}`;
    const fp = companyFingerprint(option.label);
    const idx = groups.findIndex((group) =>
      group.some((other) => {
        if (`${other.kind}:${other.tenantId}` === idKey) return true;
        if (other.kind !== option.kind) return false;
        return sameCompanyName(fp, companyFingerprint(other.label));
      })
    );
    if (idx < 0) groups.push([option]);
    else groups[idx].push(option);
  }
  return groups.map((group) => group.reduce(preferBusinessOption));
}

/** “Alertas da locadora” / “processos” já dizem o mundo. Não pergunta empresa se só há uma. */
export function askedBusinessKind(text: string): BusinessKind | null {
  const t = foldLabel(text);
  if (!t) return null;
  if (facejusAgendaKind(text)) return "facejus";
  if (/\b(facejus|escritorio|processo|oab|prazo judicial|agenda juridica)\b/.test(t)) {
    return "facejus";
  }
  if (
    /\b(locadora|frota|placa|inadimpl|vistoria|carrinho|iot|tag|supermercado)\b/.test(
      t
    )
  ) {
    return "locadora";
  }
  return null;
}

/**
 * Lista para o menu, ou null se não há o que escolher.
 * Empresa repetida nunca conta como segunda opção.
 */
export function businessChoiceList(
  text: string,
  options: BusinessOption[]
): BusinessOption[] | null {
  const all = dedupeBusinessOptions(options);
  const asked = askedBusinessKind(text);
  const pool = asked ? all.filter((option) => option.kind === asked) : all;
  const unique = dedupeBusinessOptions(pool);
  if (unique.length <= 1) return null;
  return unique;
}

export async function getActiveBusinessContext(
  db: Db,
  phone: string
): Promise<ActiveBusinessContext | null> {
  const digits = phoneDigitsOnly(phone);
  if (!digits) return null;
  const row = await db.query.whatsappBusinessContext.findFirst({
    where: eq(whatsappBusinessContext.phoneDigits, digits),
  });
  if (!row) return null;
  return {
    kind: row.kind as BusinessKind,
    tenantId: row.tenantId,
    label: row.label,
    papel: row.papel,
  };
}

export async function setActiveBusinessContext(
  db: Db,
  phone: string,
  option: BusinessOption
) {
  const e164 = normalizePhoneE164Br(phone);
  const digits = phoneDigitsOnly(phone);
  if (!e164 || !digits) throw new Error("invalid_phone");

  const existing = await db.query.whatsappBusinessContext.findFirst({
    where: eq(whatsappBusinessContext.phoneDigits, digits),
  });
  if (existing) {
    const [row] = await db
      .update(whatsappBusinessContext)
      .set({
        phoneE164: e164,
        kind: option.kind,
        tenantId: option.tenantId,
        label: option.label.slice(0, 200),
        papel: option.papel.slice(0, 64),
        metaJson: { key: option.key },
        updatedAt: new Date(),
      })
      .where(eq(whatsappBusinessContext.id, existing.id))
      .returning();
    return row;
  }
  const [row] = await db
    .insert(whatsappBusinessContext)
    .values({
      phoneDigits: digits,
      phoneE164: e164,
      kind: option.kind,
      tenantId: option.tenantId,
      label: option.label.slice(0, 200),
      papel: option.papel.slice(0, 64),
      metaJson: { key: option.key },
    })
    .returning();
  return row;
}

export function formatChooser(options: BusinessOption[]): string {
  options = dedupeBusinessOptions(options);
  if (!options.length) {
    return [
      "Neste número ainda não há empresa liberada (locadora, IoT/supermercado ou Facejus).",
      "O Assessor *pessoal* segue normal.",
      "",
      "Para liberar: frotas.moope.com.br → Configurações → Assessor MOOPE.",
    ].join("\n");
  }
  if (options.length === 1) {
    return formatActiveStatus(null, options);
  }
  const lines = [
    "Você tem acesso a *mais de um contexto empresarial* neste WhatsApp:",
  ];
  options.forEach((o, i) => {
    const world =
      o.kind === "facejus"
        ? "Facejus (jurídico)"
        : o.label.toLowerCase().includes("iot") ||
            o.papel.includes("iot") ||
            o.papel === "localizador"
          ? "IoT / supermercado"
          : "Locadora";
    const papel =
      o.kind === "facejus" && o.papel === "socio"
        ? "sócio"
        : o.papel || "—";
    lines.push(`${i + 1}) ${world} · *${o.label}* como ${papel}`);
  });
  lines.push("");
  lines.push("O *pessoal* continua sempre igual (gastos, lembretes, agenda sua).");
  lines.push("");
  lines.push("Qual contexto/perfil quer *agora*? Responda com o número ou o nome.");
  lines.push("");
  lines.push(
    "Se quiser mudar depois: *trocar empresa* · *mudar contexto* · *onde estou?*"
  );
  lines.push(
    "Ou diga: *agora a locadora NOME* / *agora o supermercado* / *agora o escritório* / *Facejus*"
  );
  return lines.join("\n");
}

export function formatActiveStatus(
  active: ActiveBusinessContext | null,
  options: BusinessOption[]
): string {
  if (!options.length) {
    return [
      "Você não tem locadora nem escritório liberados neste número.",
      "O Assessor *pessoal* segue normal.",
      "",
      CONTEXT_SWITCH_HINT,
    ].join("\n");
  }
  if (options.length === 1) {
    const o = options[0];
    const world =
      o.kind === "facejus"
        ? "Facejus"
        : o.label.toLowerCase().includes("iot") ||
            o.papel.includes("iot") ||
            o.papel === "localizador"
          ? "IoT / supermercado"
          : "Locadora";
    return [
      `Modo empresarial: *${world} · ${o.label}* (${o.papel}).`,
      "Pessoal: sempre disponível em paralelo.",
      "",
      CONTEXT_SWITCH_HINT,
    ].join("\n");
  }
  if (!active) {
    return formatChooser(options);
  }
  const world =
    active.kind === "facejus"
      ? "Facejus"
      : active.label.toLowerCase().includes("iot")
        ? "IoT / supermercado"
        : "Locadora";
  return [
    `Modo atual: *${world} · ${active.label}* (${active.papel || "—"}).`,
    "Pessoal: sempre disponível em paralelo.",
    "",
    CONTEXT_SWITCH_HINT,
  ].join("\n");
}

/** Tenta casar resposta do usuário com uma opção (número ou nome). */
export function matchBusinessChoice(
  text: string,
  options: BusinessOption[]
): BusinessOption | null {
  if (!options.length) return null;
  const raw = text.trim();
  const num = raw.match(/^\s*([1-9]\d*)\s*[).:-]?\s*$/);
  if (num) {
    const idx = Number(num[1]) - 1;
    if (idx >= 0 && idx < options.length) return options[idx];
  }

  const t = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const scored = options.map((o) => {
    const label = o.label
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    let score = 0;
    if (t.includes(label) || label.includes(t)) score += 10;
    const tokens = label.split(/\s+/).filter((x) => x.length > 2);
    for (const tok of tokens) {
      if (t.includes(tok)) score += 2;
    }
    if (o.kind === "facejus" && /(facejus|escritorio|advogad)/.test(t))
      score += 3;
    if (o.kind === "locadora" && /(locadora|frota|gestao)/.test(t)) score += 3;
    return { o, score };
  });
  scored.sort((a, b) => b.score - a.score);
  if (scored[0] && scored[0].score >= 3) {
    if (scored[1] && scored[1].score === scored[0].score) return null;
    return scored[0].o;
  }
  return null;
}

/**
 * Resolve qual tenant usar. Se multi e sem ativo → precisa escolher.
 * Se 1 só → auto.
 */
export async function resolveBusinessForPhone(
  db: Db,
  phone: string
): Promise<{
  options: BusinessOption[];
  active: ActiveBusinessContext | null;
  needsChoice: boolean;
  effective: BusinessOption | null;
}> {
  const options = await listBusinessOptions(phone);
  let active = await getActiveBusinessContext(db, phone);

  // Valida se o ativo ainda existe
  if (active) {
    const still = options.find(
      (o) => o.kind === active!.kind && o.tenantId === active!.tenantId
    );
    if (!still) active = null;
  }

  if (options.length === 0) {
    return { options, active: null, needsChoice: false, effective: null };
  }
  if (options.length === 1) {
    const only = options[0];
    // Auto-fix se mudou / ainda não tinha
    if (
      !active ||
      active.kind !== only.kind ||
      active.tenantId !== only.tenantId
    ) {
      await setActiveBusinessContext(db, phone, only);
      active = {
        kind: only.kind,
        tenantId: only.tenantId,
        label: only.label,
        papel: only.papel,
      };
    }
    return { options, active, needsChoice: false, effective: only };
  }

  if (!active) {
    return { options, active: null, needsChoice: true, effective: null };
  }
  const effective =
    options.find(
      (o) => o.kind === active!.kind && o.tenantId === active!.tenantId
    ) || null;
  return {
    options,
    active,
    needsChoice: !effective,
    effective,
  };
}
