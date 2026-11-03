import { readFileSync, existsSync, statfsSync } from "fs";
import os from "os";
import { sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { sendProactiveMessage } from "@/channels/zernio/proactive";
import { messages } from "@/db/schema";
import { phoneDigitVariants } from "@/domain/access-whitelist";
import { beat, getHeartbeatStatus } from "@/domain/health";
import { isConfirmedDelivery } from "@/domain/send-once";
import { logger } from "@/lib/logger";

function readNum(path: string): number | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf8").trim();
    if (!raw || raw === "max") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function parseMeminfo(): { totalMb: number; availableMb: number } | null {
  try {
    const text = readFileSync("/proc/meminfo", "utf8");
    const total = text.match(/^MemTotal:\s+(\d+)/m);
    const avail = text.match(/^MemAvailable:\s+(\d+)/m);
    if (!total || !avail) return null;
    return {
      totalMb: Math.round(Number(total[1]) / 1024),
      availableMb: Math.round(Number(avail[1]) / 1024),
    };
  } catch {
    return null;
  }
}

function cgroupMemory(): {
  usedMb: number;
  limitMb: number | null;
  pct: number | null;
} | null {
  // cgroup v2
  const current =
    readNum("/sys/fs/cgroup/memory.current") ??
    readNum("/sys/fs/cgroup/memory/memory.usage_in_bytes");
  const limit =
    readNum("/sys/fs/cgroup/memory.max") ??
    readNum("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  if (current == null) return null;
  const usedMb = Math.round(current / (1024 * 1024));
  // ignore absurd host-sized "limits" (> 256GiB) — treat as unlimited
  const limitMb =
    limit != null && limit < 256 * 1024 * 1024 * 1024
      ? Math.round(limit / (1024 * 1024))
      : null;
  const pct =
    limitMb && limitMb > 0 ? Math.round((usedMb / limitMb) * 100) : null;
  return { usedMb, limitMb, pct };
}

function diskRoot(): { totalGb: number; usedGb: number; pct: number } | null {
  try {
    const s = statfsSync("/");
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    const used = total - free;
    if (total <= 0) return null;
    return {
      totalGb: Math.round((total / (1024 ** 3)) * 10) / 10,
      usedGb: Math.round((used / (1024 ** 3)) * 10) / 10,
      pct: Math.round((used / total) * 100),
    };
  } catch {
    return null;
  }
}

export type InfraSnapshot = {
  load1: number;
  load5: number;
  load15: number;
  cpuCount: number;
  hostMem: { totalMb: number; availableMb: number; usedPct: number } | null;
  containerMem: {
    usedMb: number;
    limitMb: number | null;
    pct: number | null;
  } | null;
  processRssMb: number;
  disk: { totalGb: number; usedGb: number; pct: number } | null;
  db: {
    sizePretty: string;
    sizeBytes: number;
    connections: number;
    maxConnections: number;
    connPct: number;
    jobsQueued: number;
    jobsRunning: number;
  };
  warnings: string[];
};

/** Pico único não alerta: só se o container seguir alto no próximo ciclo (~1 min). */
let lastContainerMemPct: number | null = null;

export function containerMemWarning(pct: number | null): boolean {
  const prev = lastContainerMemPct;
  lastContainerMemPct = pct;
  if (pct == null || pct < 85) return false;
  if (pct >= 95) return true;
  return prev != null && prev >= 85;
}

export async function collectInfraSnapshot(db: Db): Promise<InfraSnapshot> {
  const [l1, l5, l15] = os.loadavg();
  const cpuCount = os.cpus().length || 1;
  const hostRaw = parseMeminfo();
  const hostMem = hostRaw
    ? {
        totalMb: hostRaw.totalMb,
        availableMb: hostRaw.availableMb,
        usedPct: Math.round(
          ((hostRaw.totalMb - hostRaw.availableMb) / hostRaw.totalMb) * 100
        ),
      }
    : null;
  const containerMem = cgroupMemory();
  const processRssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
  const disk = diskRoot();

  const dbStats = await db.execute(sql`
    SELECT
      pg_database_size(current_database())::bigint AS size_bytes,
      pg_size_pretty(pg_database_size(current_database())) AS size_pretty,
      (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS connections,
      (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_connections,
      (SELECT count(*)::int FROM agent_jobs WHERE status IN ('pending', 'retry')) AS jobs_queued,
      (SELECT count(*)::int FROM agent_jobs WHERE status = 'processing') AS jobs_running
  `);
  const row = (Array.isArray(dbStats) ? dbStats[0] : {}) as Record<
    string,
    unknown
  >;
  const connections = Number(row.connections || 0);
  const maxConnections = Number(row.max_connections || 100);
  const connPct = Math.round((connections / Math.max(maxConnections, 1)) * 100);

  const warnings: string[] = [];
  if (hostMem && hostMem.usedPct >= 85) {
    warnings.push(`RAM host ${hostMem.usedPct}%`);
  }
  if (hostMem && hostMem.availableMb < 1024) {
    warnings.push(`RAM livre ${hostMem.availableMb}MB`);
  }
  if (disk && disk.pct >= 85) {
    warnings.push(`Disco ${disk.pct}%`);
  }
  if (containerMemWarning(containerMem?.pct ?? null)) {
    warnings.push(`Container mem ${containerMem!.pct}%`);
  }
  if (connPct >= 80) {
    warnings.push(`PG conns ${connPct}%`);
  }
  if (Number(row.jobs_queued || 0) >= 50) {
    warnings.push(`Fila jobs ${row.jobs_queued}`);
  }
  // load médio por CPU
  if (l1 / cpuCount >= 2) {
    warnings.push(`Load ${l1.toFixed(1)}/${cpuCount} CPUs`);
  }

  return {
    load1: Math.round(l1 * 100) / 100,
    load5: Math.round(l5 * 100) / 100,
    load15: Math.round(l15 * 100) / 100,
    cpuCount,
    hostMem,
    containerMem,
    processRssMb,
    disk,
    db: {
      sizePretty: String(row.size_pretty || "?"),
      sizeBytes: Number(row.size_bytes || 0),
      connections,
      maxConnections,
      connPct,
      jobsQueued: Number(row.jobs_queued || 0),
      jobsRunning: Number(row.jobs_running || 0),
    },
    warnings,
  };
}

function bar(pct: number, width = 10): string {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  const filled = Math.round((p / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled) + ` ${p}%`;
}

function nowBr(): string {
  return new Date().toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatInfraReport(s: InfraSnapshot): string {
  const ok = s.warnings.length === 0;
  const lines = [
    ok ? "✅ *Servidor · Assessor*" : "🚨 *Servidor · NO LIMITE*",
    `_${nowBr()}_`,
    "────────────",
    `🖥️ *CPU*  load ${s.load1} · ${s.load5} · ${s.load15}`,
    `     (${s.cpuCount} CPUs)`,
  ];
  if (s.hostMem) {
    lines.push(
      `🧠 *RAM host*`,
      `     ${bar(s.hostMem.usedPct)}`,
      `     livre ${s.hostMem.availableMb} MB / ${s.hostMem.totalMb} MB`
    );
  }
  if (s.containerMem) {
    lines.push(
      `📦 *Container*`,
      s.containerMem.pct != null
        ? `     ${bar(s.containerMem.pct)}`
        : `     ${s.containerMem.usedMb} MB`,
      s.containerMem.limitMb
        ? `     ${s.containerMem.usedMb} / ${s.containerMem.limitMb} MB`
        : `     ${s.containerMem.usedMb} MB (sem teto)`
    );
  }
  lines.push(`⚙️ Process RSS: ${s.processRssMb} MB`);
  if (s.disk) {
    lines.push(
      `💾 *Disco /*`,
      `     ${bar(s.disk.pct)}`,
      `     ${s.disk.usedGb} G / ${s.disk.totalGb} G`
    );
  }
  lines.push(
    `🐘 *Postgres*  ${s.db.sizePretty}`,
    `     conns ${bar(s.db.connPct)}`,
    `     ${s.db.connections}/${s.db.maxConnections}`,
    `📬 *Fila*  ${s.db.jobsQueued} na fila · ${s.db.jobsRunning} rodando`
  );
  if (s.warnings.length) {
    lines.push("────────────", "⚠️ *Sinais:*", ...s.warnings.map((w) => `• ${w}`));
  } else {
    lines.push("────────────", "_Tudo dentro do limite_");
  }
  return lines.join("\n");
}

export type UsageKpis = {
  usersPaired: number;
  usersActive7d: number;
  workspaces: number;
  inbound24h: number;
  inbound7d: number;
  outbound24h: number;
  remindersTotal: number;
  remindersSent: number;
  remindersScheduled: number;
  remindersCreated24h: number;
  remindersDelivered24h: number;
  appointmentsTotal: number;
  appointmentsCreated7d: number;
  tasksTotal: number;
  toolCalls24h: number;
  toolCalls7d: number;
  topTools7d: Array<{ name: string; n: number }>;
  agentRuns24h: number;
  jobsFailed24h: number;
};

export async function getUsageKpis(db: Db): Promise<UsageKpis> {
  const stats = await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM whatsapp_identities WHERE deleted_at IS NULL AND status = 'paired') AS users_paired,
      (SELECT count(DISTINCT c.user_id)::int FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE m.direction = 'inbound' AND m.created_at > NOW() - INTERVAL '7 days'
          AND c.user_id IS NOT NULL) AS users_active_7d,
      (SELECT count(*)::int FROM workspaces WHERE deleted_at IS NULL) AS workspaces,
      (SELECT count(*)::int FROM messages WHERE deleted_at IS NULL AND direction = 'inbound' AND created_at > NOW() - INTERVAL '24 hours') AS inbound_24h,
      (SELECT count(*)::int FROM messages WHERE deleted_at IS NULL AND direction = 'inbound' AND created_at > NOW() - INTERVAL '7 days') AS inbound_7d,
      (SELECT count(*)::int FROM messages WHERE deleted_at IS NULL AND direction = 'outbound' AND created_at > NOW() - INTERVAL '24 hours') AS outbound_24h,
      (SELECT count(*)::int FROM reminders WHERE deleted_at IS NULL) AS reminders_total,
      (SELECT count(*)::int FROM reminders WHERE deleted_at IS NULL AND status = 'sent') AS reminders_sent,
      (SELECT count(*)::int FROM reminders WHERE deleted_at IS NULL AND status = 'scheduled' AND fire_at > NOW()) AS reminders_scheduled,
      (SELECT count(*)::int FROM reminders WHERE deleted_at IS NULL AND created_at > NOW() - INTERVAL '24 hours') AS reminders_created_24h,
      (SELECT count(*)::int FROM reminders WHERE deleted_at IS NULL AND status = 'sent' AND last_delivered_at > NOW() - INTERVAL '24 hours') AS reminders_delivered_24h,
      (SELECT count(*)::int FROM appointments WHERE deleted_at IS NULL) AS appointments_total,
      (SELECT count(*)::int FROM appointments WHERE deleted_at IS NULL AND created_at > NOW() - INTERVAL '7 days') AS appointments_created_7d,
      (SELECT count(*)::int FROM tasks WHERE deleted_at IS NULL) AS tasks_total,
      (SELECT count(*)::int FROM tool_calls WHERE created_at > NOW() - INTERVAL '24 hours') AS tool_calls_24h,
      (SELECT count(*)::int FROM tool_calls WHERE created_at > NOW() - INTERVAL '7 days') AS tool_calls_7d,
      (SELECT count(*)::int FROM agent_runs WHERE created_at > NOW() - INTERVAL '24 hours') AS agent_runs_24h,
      (SELECT count(*)::int FROM agent_jobs WHERE created_at > NOW() - INTERVAL '24 hours' AND (status = 'failed' OR dead_at IS NOT NULL)) AS jobs_failed_24h
  `);
  const row = (Array.isArray(stats) ? stats[0] : {}) as Record<string, number>;

  const top = await db.execute(sql`
    SELECT tool_name AS name, count(*)::int AS n
    FROM tool_calls
    WHERE created_at > NOW() - INTERVAL '7 days'
    GROUP BY tool_name
    ORDER BY n DESC
    LIMIT 5
  `);
  const topTools7d = (
    Array.isArray(top) ? top : []
  ) as Array<{ name: string; n: number }>;

  return {
    usersPaired: Number(row.users_paired || 0),
    usersActive7d: Number(row.users_active_7d || 0),
    workspaces: Number(row.workspaces || 0),
    inbound24h: Number(row.inbound_24h || 0),
    inbound7d: Number(row.inbound_7d || 0),
    outbound24h: Number(row.outbound_24h || 0),
    remindersTotal: Number(row.reminders_total || 0),
    remindersSent: Number(row.reminders_sent || 0),
    remindersScheduled: Number(row.reminders_scheduled || 0),
    remindersCreated24h: Number(row.reminders_created_24h || 0),
    remindersDelivered24h: Number(row.reminders_delivered_24h || 0),
    appointmentsTotal: Number(row.appointments_total || 0),
    appointmentsCreated7d: Number(row.appointments_created_7d || 0),
    tasksTotal: Number(row.tasks_total || 0),
    toolCalls24h: Number(row.tool_calls_24h || 0),
    toolCalls7d: Number(row.tool_calls_7d || 0),
    topTools7d: topTools7d.map((t) => ({
      name: String(t.name),
      n: Number(t.n),
    })),
    agentRuns24h: Number(row.agent_runs_24h || 0),
    jobsFailed24h: Number(row.jobs_failed_24h || 0),
  };
}

export function formatUsageReport(u: UsageKpis): string {
  const top =
    u.topTools7d.length === 0
      ? "—"
      : u.topTools7d.map((t, i) => `${i + 1}. ${t.name} · *${t.n}*`).join("\n");

  return [
    "📊 *Uso · Assessor*",
    `_${nowBr()}_`,
    "────────────",
    "👥 *Clientes*",
    `• Pareados: *${u.usersPaired}*`,
    `• Ativos 7d: *${u.usersActive7d}*`,
    `• Workspaces: *${u.workspaces}*`,
    "",
    "💬 *Mensagens*",
    `• Entrada 24h / 7d: *${u.inbound24h}* / *${u.inbound7d}*`,
    `• Saída 24h: *${u.outbound24h}*`,
    `• Runs agente 24h: *${u.agentRuns24h}*`,
    "",
    "⏰ *Lembretes*",
    `• Total: *${u.remindersTotal}*  · enviados *${u.remindersSent}*  · agendados *${u.remindersScheduled}*`,
    `• Criados 24h: *${u.remindersCreated24h}*`,
    `• Entregues 24h: *${u.remindersDelivered24h}*`,
    "",
    "📅 *Agenda & tarefas*",
    `• Compromissos: *${u.appointmentsTotal}* (novos 7d: *${u.appointmentsCreated7d}*)`,
    `• Tarefas: *${u.tasksTotal}*`,
    "",
    "🛠️ *Tools*",
    `• Calls 24h / 7d: *${u.toolCalls24h}* / *${u.toolCalls7d}*`,
    `*Top 7 dias*`,
    top,
    u.jobsFailed24h > 0
      ? `\n⚠️ Jobs falhos 24h: *${u.jobsFailed24h}*`
      : "",
    "────────────",
    "_Só número DEV · /ops_",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Notifica DEV no Zap (best-effort). */
export async function notifyDevWhatsApp(
  db: Db,
  text: string,
  idempotencyKey: string
): Promise<boolean> {
  const phone =
    process.env.DEV_NOTIFY_PHONE ||
    process.env.NOTIFY_DEV_PHONE ||
    "+5561996715985";
  const sent = await notifyAssessorPhone(db, phone, text, idempotencyKey);
  return sent.ok;
}

/** drizzle/postgres-js às vezes devolve array, às vezes `{ rows }`. */
function linhasDoExecute(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === "object") {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}

/**
 * Aviso no WhatsApp de quem já conversa com o Meu Assessor.
 * Tenta texto livre; se a janela de 24h estiver fechada, cai no template
 * `notification` (aprovado). Nunca mente "ok" se o Zap não saiu.
 */
export async function notifyAssessorPhone(
  db: Db,
  phone: string,
  text: string,
  idempotencyKey: string
): Promise<{ ok: boolean; reason?: string }> {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10) return { ok: false, reason: "invalid_phone" };
  const suffixes = [
    ...new Set(
      phoneDigitVariants(phone)
        .map((v) => v.slice(-11))
        .filter((v) => v.length >= 10)
    ),
  ];
  if (!suffixes.length) suffixes.push(digits.slice(-11));
  let wherePhone = sql`false`;
  for (const suf of suffixes) {
    wherePhone = sql`${wherePhone} OR regexp_replace(wi.phone_e164, '\\D', '', 'g') LIKE ${"%" + suf}`;
  }
  const conv = await db.execute(sql`
    SELECT c.id, c.workspace_id, c.external_conversation_id
    FROM whatsapp_identities wi
    JOIN conversations c ON c.whatsapp_identity_id = wi.id
    WHERE (${wherePhone})
      AND wi.deleted_at IS NULL
      AND c.deleted_at IS NULL
    ORDER BY c.updated_at DESC NULLS LAST
    LIMIT 1
  `);
  const row = linhasDoExecute(conv)[0];
  const externalId =
    typeof row?.external_conversation_id === "string"
      ? row.external_conversation_id
      : "";
  const conversationId =
    typeof row?.id === "string" ? row.id : "";
  const workspaceId =
    typeof row?.workspace_id === "string" ? row.workspace_id : null;
  if (!externalId) {
    return { ok: false, reason: "no_conversation" };
  }
  const sent = await sendProactiveMessage(db, {
    conversationId: externalId,
    message: text,
    idempotencyKey,
    withinCustomerCareWindow: true,
    forceTemplate: false,
    logicalTemplate: "notification",
  });
  let result = sent;
  if (!isConfirmedDelivery(sent)) {
    result = await sendProactiveMessage(db, {
      conversationId: externalId,
      message: text,
      idempotencyKey: `${idempotencyKey}:tpl`,
      withinCustomerCareWindow: false,
      forceTemplate: true,
      logicalTemplate: "notification",
    });
  }
  const delivered = isConfirmedDelivery(result);
  if (conversationId) {
    await db.insert(messages).values({
      conversationId,
      workspaceId,
      direction: "outbound",
      status: delivered ? "sent" : "failed",
      bodyText: text,
      contentType: "text",
      correlationId: idempotencyKey.slice(0, 64),
      rawPayload: {
        kind: "assessor_notify",
        ok: delivered,
        error: result.error || result.errorCode || null,
      },
      sentAt: delivered ? new Date() : null,
    });
  }
  if (!delivered) {
    return {
      ok: false,
      reason: result.error || result.errorCode || sent.error || "send_failed",
    };
  }
  return { ok: true };
}

/**
 * Alerta proativo: servidor/DB no limite → Zap DEV (cooldown 30 min).
 */
export async function runInfraAlertTick(db: Db): Promise<{
  warned: boolean;
  alerted: boolean;
  warnings: string[];
}> {
  const snap = await collectInfraSnapshot(db);
  if (!snap.warnings.length) {
    return { warned: false, alerted: false, warnings: [] };
  }

  logger.error("infra_threshold_breach", { warnings: snap.warnings });

  const hb = await getHeartbeatStatus(db, "infra_alert");
  const recent = typeof hb.age_seconds === "number" && hb.age_seconds < 1800;
  if (recent) {
    return { warned: true, alerted: false, warnings: snap.warnings };
  }

  await beat(db, "infra_alert", { warnings: snap.warnings });
  const text = [
    formatInfraReport(snap),
    "",
    "_Alerta automático — mande `/servidor` ou `/saude`_",
  ].join("\n");
  const ok = await notifyDevWhatsApp(db, text, `infra-alert:${Date.now()}`);
  return { warned: true, alerted: ok, warnings: snap.warnings };
}
