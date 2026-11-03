/**
 * Canal DEV master ↔ Cursor via WhatsApp Assessor.
 * Só o número DEV (isDevOpsPhone) chega aqui — o worker já filtra.
 *
 * Fila + heartbeat ficam em platform_settings (persiste entre rebuilds).
 * Cursor marca presença com scripts/dev-agent-heartbeat.ts;
 * se o ping estiver velho, o Assessor responde que o agente está fora do ar.
 */
import { and, eq } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Db } from "@/db/client";
import { platformSettings } from "@/db/schema";

const NS = "dev";
const KEY_AJUSTES = "ajustes_hoje";
const KEY_HEARTBEAT = "agent_heartbeat";

/** Sem ping recente → Assessor diz que o engenheiro está offline. */
export const AGENT_ONLINE_TTL_MS = 12 * 60 * 1000;

export type AjusteStatus = "pending" | "in_progress" | "done";

export type AjusteItem = {
  id: number;
  text: string;
  at: string;
  day: string;
  time: string;
  phone?: string | null;
  status: AjusteStatus;
  reply?: string | null;
  repliedAt?: string | null;
};

type AjustesBag = {
  day: string;
  items: AjusteItem[];
};

type HeartbeatBag = {
  at: string;
  label?: string;
};

export function parseAjustePedido(text: string): string | null {
  const raw = String(text || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
  if (!raw || raw.length > 2000) return null;

  const m = raw.match(
    /^(?:\/)?(?:ajuste|ajustes|pedido|pedidos|todo|fix|melhoria|feature|ideia)\s*[:\-–]\s*(.+)$/is
  );
  if (m?.[1]?.trim()) return m[1].trim();

  const m2 = raw.match(
    /^(?:\/)?(?:ajuste|pedido|todo|fix|feature|ideia)\s+(.+)$/is
  );
  if (m2?.[1]?.trim() && !/^(ops|saude|status|uso|hoje|agente)/i.test(m2[1])) {
    return m2[1].trim();
  }
  return null;
}

export function isAgenteStatusCommand(text: string): boolean {
  const t = String(text || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^[/#!]+/, "");
  return /^(agente|engenheiro|cursor|dev agent|status agente|agente status)$/.test(
    t
  );
}

function dayStamp() {
  return DateTime.now().setZone("America/Sao_Paulo").toFormat("yyyy-LL-dd");
}

function timeStamp() {
  return DateTime.now().setZone("America/Sao_Paulo").toFormat("HH:mm");
}

async function getSetting(db: Db, key: string): Promise<Record<string, unknown>> {
  const row = await db.query.platformSettings.findFirst({
    where: and(eq(platformSettings.namespace, NS), eq(platformSettings.key, key)),
  });
  return (row?.valueJson || {}) as Record<string, unknown>;
}

async function setSetting(db: Db, key: string, valueJson: Record<string, unknown>) {
  const existing = await db.query.platformSettings.findFirst({
    where: and(eq(platformSettings.namespace, NS), eq(platformSettings.key, key)),
  });
  if (existing) {
    await db
      .update(platformSettings)
      .set({ valueJson, updatedAt: new Date() })
      .where(eq(platformSettings.id, existing.id));
    return;
  }
  await db.insert(platformSettings).values({
    namespace: NS,
    key,
    valueJson,
  });
}

async function loadBag(db: Db): Promise<AjustesBag> {
  const day = dayStamp();
  const raw = (await getSetting(db, KEY_AJUSTES)) as Partial<AjustesBag>;
  if (raw.day === day && Array.isArray(raw.items)) {
    return { day, items: raw.items as AjusteItem[] };
  }
  return { day, items: [] };
}

async function saveBag(db: Db, bag: AjustesBag) {
  await setSetting(db, KEY_AJUSTES, bag as unknown as Record<string, unknown>);
}

export async function touchAgentHeartbeat(
  db: Db,
  label = "cursor"
): Promise<{ at: string }> {
  const at = new Date().toISOString();
  await setSetting(db, KEY_HEARTBEAT, { at, label } satisfies HeartbeatBag);
  return { at };
}

export async function getAgentHeartbeat(db: Db): Promise<{
  online: boolean;
  at: string | null;
  ageMs: number | null;
  label: string | null;
}> {
  const raw = (await getSetting(db, KEY_HEARTBEAT)) as Partial<HeartbeatBag>;
  const at = typeof raw.at === "string" ? raw.at : null;
  if (!at) {
    return { online: false, at: null, ageMs: null, label: null };
  }
  const ageMs = Date.now() - new Date(at).getTime();
  return {
    online: Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= AGENT_ONLINE_TTL_MS,
    at,
    ageMs: Number.isFinite(ageMs) ? ageMs : null,
    label: typeof raw.label === "string" ? raw.label : null,
  };
}

function formatAge(ageMs: number | null): string {
  if (ageMs == null || ageMs < 0) return "—";
  const min = Math.floor(ageMs / 60000);
  if (min < 1) return "agora";
  if (min === 1) return "1 min";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h === 1 ? "1 h" : `${h} h`;
}

export async function getAgentStatusReply(db: Db): Promise<string> {
  const hb = await getAgentHeartbeat(db);
  if (hb.online) {
    return [
      "🟢 *Agente de (dev online*",
      `Último ping: ${formatAge(hb.ageMs)}`,
      "_Mande `/ajuste …` — eu pego na fila e te respondo por aqui._",
    ].join("\n");
  }
  return [
    "🔴 *Agente de (dev fora do ar*",
    hb.at
      ? `Último ping: há ${formatAge(hb.ageMs)}`
      : "Ainda não houve ping hoje.",
    "",
    "Pode mandar `/ajuste …` mesmo assim — fica na fila.",
    "Quando o engenheiro (Cursor) voltar, ele te avisa por este Assessor.",
  ].join("\n");
}

export async function listAjustesHoje(db: Db): Promise<string> {
  const bag = await loadBag(db);
  const hb = await getAgentHeartbeat(db);
  const agentLine = hb.online
    ? "🟢 Agente online"
    : "🔴 Agente de (dev fora do ar";

  if (!bag.items.length) {
    return [
      "📭 Nenhum pedido hoje.",
      agentLine,
      "",
      "Mande: `/ajuste sua ideia ou correção`",
      "_Status do engenheiro:_ `/agente`",
    ].join("\n");
  }

  const lines = [
    `📋 *Ajustes · ${bag.day}* (${bag.items.length})`,
    agentLine,
    "────────────",
  ];
  for (const it of bag.items.slice(-20)) {
    const icon =
      it.status === "done" ? "✅" : it.status === "in_progress" ? "🔧" : "⏳";
    const preview =
      it.text.length > 120 ? it.text.slice(0, 120) + "…" : it.text;
    lines.push(`${icon} *#${it.id}* · ${it.time}`);
    lines.push(preview);
    if (it.status === "done" && it.reply) {
      lines.push(`↳ _${it.reply.slice(0, 160)}_`);
    }
    lines.push("");
  }
  lines.push("_Novo:_ `/ajuste …` · _Status:_ `/agente`");
  return lines.join("\n").slice(0, 3500);
}

export async function saveAjustePedido(
  db: Db,
  input: { text: string; phoneE164?: string | null }
): Promise<{ id: number; reply: string; agentOnline: boolean }> {
  const bag = await loadBag(db);
  const day = dayStamp();
  const time = timeStamp();
  const id =
    bag.items.reduce((max, it) => (it.id > max ? it.id : max), 0) + 1;

  const item: AjusteItem = {
    id,
    text: input.text,
    at: new Date().toISOString(),
    day,
    time,
    phone: input.phoneE164 || null,
    status: "pending",
  };
  bag.day = day;
  bag.items.push(item);
  await saveBag(db, bag);

  const hb = await getAgentHeartbeat(db);
  const preview =
    input.text.length > 200 ? input.text.slice(0, 200) + "…" : input.text;

  if (hb.online) {
    return {
      id,
      agentOnline: true,
      reply: [
        `✅ *Pedido #${id} na fila* (${time})`,
        "",
        preview,
        "",
        "🟢 Engenheiro online — vou trabalhar nisso e te aviso por aqui.",
        "_Listar:_ `/ajustes` · _Status:_ `/agente`",
      ].join("\n"),
    };
  }

  return {
    id,
    agentOnline: false,
    reply: [
      `✅ *Pedido #${id} anotado* (${time})`,
      "",
      preview,
      "",
      "⚠️ *Agente de (dev fora do ar* no momento.",
      "Assim que o engenheiro (Cursor) voltar online, ele pega da fila e te responde por este Assessor.",
      "",
      "_Listar:_ `/ajustes` · _Status:_ `/agente` · _Novo:_ `/ajuste …`",
    ].join("\n"),
  };
}

export async function listPendingAjustes(db: Db): Promise<AjusteItem[]> {
  const bag = await loadBag(db);
  return bag.items.filter((it) => it.status === "pending");
}

export async function claimAjuste(
  db: Db,
  id: number
): Promise<AjusteItem | null> {
  const bag = await loadBag(db);
  const it = bag.items.find((x) => x.id === id);
  if (!it || it.status === "done") return null;
  it.status = "in_progress";
  await saveBag(db, bag);
  return it;
}

export async function completeAjuste(
  db: Db,
  id: number,
  reply: string
): Promise<AjusteItem | null> {
  const bag = await loadBag(db);
  const it = bag.items.find((x) => x.id === id);
  if (!it) return null;
  it.status = "done";
  it.reply = reply.slice(0, 2000);
  it.repliedAt = new Date().toISOString();
  await saveBag(db, bag);
  return it;
}

export async function getAjusteById(
  db: Db,
  id: number
): Promise<AjusteItem | null> {
  const bag = await loadBag(db);
  return bag.items.find((x) => x.id === id) || null;
}
