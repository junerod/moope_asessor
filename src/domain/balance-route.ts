/**
 * “Balanço do mês” escolhe um mundo só.
 * Um contexto → responde direto. Dois ou mais → menu 1, 2…
 */
import { and, eq, isNull, or } from "drizzle-orm";
import type { Db } from "@/db/client";
import { memories } from "@/db/schema";
import {
  listBusinessOptions,
  type BusinessOption,
} from "@/domain/business-context";

export type BalanceKind = "pessoal" | "locadora" | "facejus";

export type BalanceTarget = {
  kind: BalanceKind;
  label: string;
  tenantId?: number;
  papel?: string;
};

const PICK_TTL_MS = 20 * 60 * 1000;

function fold(s: string) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

/** Pedido explícito, menu, ou nada a ver com balanço. */
export function classifyBalanceAsk(
  text: string
): "pessoal" | "locadora" | "facejus" | "ask" | null {
  const t = fold(text);
  if (!t || t.length > 80) return null;
  if (!/\b(balanco|saldo do mes|fechamento)\b/.test(t)) return null;
  if (/\b(pessoal|meus gastos|gasto pessoal)\b/.test(t)) return "pessoal";
  if (/\b(locadora|frota)\b/.test(t)) return "locadora";
  if (/\b(escritorio|facejus|juridico)\b/.test(t)) return "facejus";
  if (
    /^(balanco( do mes)?|saldo do mes|fechamento( do mes)?)\s*[?.!]*$/.test(t)
  ) {
    return "ask";
  }
  return null;
}

export function formatBalanceMenu(options: BalanceTarget[]): string {
  return [
    "Balanço de qual?",
    "",
    ...options.map((o, i) => `${i + 1}. ${menuLabel(o)}`),
    "",
    options.length === 2
      ? "Responda *1* ou *2*."
      : `Responda *1* a *${options.length}*.`,
  ].join("\n");
}

function menuLabel(o: BalanceTarget): string {
  if (o.kind === "pessoal") return "Pessoal";
  if (o.kind === "locadora") return `Locadora · ${o.label}`;
  return `Escritório · ${o.label}`;
}

export function matchBalancePick(
  text: string,
  options: BalanceTarget[]
): number | null {
  const t = fold(text);
  if (!t || t.length > 40) return null;
  const num = t.match(/^(\d+)\s*[.!]?\s*$/);
  if (num) {
    const i = Number(num[1]) - 1;
    return i >= 0 && i < options.length ? i : null;
  }
  if (/^pessoal\b/.test(t)) {
    const i = options.findIndex((o) => o.kind === "pessoal");
    return i >= 0 ? i : null;
  }
  if (/^locadora\b/.test(t)) {
    const i = options.findIndex((o) => o.kind === "locadora");
    return i >= 0 ? i : null;
  }
  if (/^(escritorio|facejus)\b/.test(t)) {
    const i = options.findIndex((o) => o.kind === "facejus");
    return i >= 0 ? i : null;
  }
  return null;
}

export function looksLikeBalancePick(text: string): boolean {
  const t = fold(text);
  return /^(\d+|pessoal|locadora|escritorio|facejus)\s*[.!]?\s*$/.test(t);
}

export function readBalancePick(metadata: unknown): {
  at: number;
  options: BalanceTarget[];
} | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>).balancePick;
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { at?: unknown; options?: unknown };
  const at = Number(o.at);
  if (!Number.isFinite(at) || Date.now() - at > PICK_TTL_MS) return null;
  if (!Array.isArray(o.options) || !o.options.length) return null;
  const options: BalanceTarget[] = [];
  for (const item of o.options) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const kind = r.kind;
    if (kind !== "pessoal" && kind !== "locadora" && kind !== "facejus") continue;
    if (typeof r.label !== "string") continue;
    options.push({
      kind,
      label: r.label,
      tenantId: typeof r.tenantId === "number" ? r.tenantId : undefined,
      papel: typeof r.papel === "string" ? r.papel : undefined,
    });
  }
  if (!options.length) return null;
  return { at, options };
}

async function hasPersonalLedger(db: Db, workspaceId: string): Promise<boolean> {
  const row = await db.query.memories.findFirst({
    where: and(
      eq(memories.workspaceId, workspaceId),
      eq(memories.status, "active"),
      or(eq(memories.sourceType, "expense"), eq(memories.sourceType, "income")),
      isNull(memories.deletedAt)
    ),
    columns: { id: true },
  });
  return Boolean(row);
}

function fromBusiness(b: BusinessOption): BalanceTarget {
  return {
    kind: b.kind,
    label: b.label,
    tenantId: b.tenantId,
    papel: b.papel,
  };
}

/** Lista o que faz sentido abrir. Um item = responde direto. */
export async function balanceTargetsForAsk(
  db: Db,
  input: { phone: string; workspaceId: string; forced?: BalanceKind | null }
): Promise<BalanceTarget[]> {
  const businesses = await listBusinessOptions(input.phone);
  const locadoras = businesses.filter((b) => b.kind === "locadora");
  const escritorios = businesses.filter((b) => b.kind === "facejus");

  if (input.forced === "pessoal") return [{ kind: "pessoal", label: "Pessoal" }];
  if (input.forced === "locadora") {
    return locadoras.map(fromBusiness);
  }
  if (input.forced === "facejus") {
    return escritorios.map(fromBusiness);
  }

  const personal = await hasPersonalLedger(db, input.workspaceId);
  const targets: BalanceTarget[] = [];
  if (!businesses.length || personal) {
    targets.push({ kind: "pessoal", label: "Pessoal" });
  }
  targets.push(...locadoras.map(fromBusiness));
  targets.push(...escritorios.map(fromBusiness));
  if (!targets.length) targets.push({ kind: "pessoal", label: "Pessoal" });
  return targets;
}
