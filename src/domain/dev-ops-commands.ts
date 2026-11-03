import type { Db } from "@/db/client";
import { databasePing, getHeartbeatStatus } from "@/domain/health";
import {
  getReliabilitySnapshot,
  runReliabilityAlertTick,
} from "@/domain/reliability-alerts";
import { healReminderCreateGaps } from "@/domain/reminder-integrity";
import {
  collectInfraSnapshot,
  formatInfraReport,
  formatUsageReport,
  getUsageKpis,
  runInfraAlertTick,
} from "@/domain/dev-ops-metrics";
import { logger } from "@/lib/logger";
import { setDevQuerAlertaCrm } from "@/domain/crm-dev-alerts";
import { formatAiConsumoReport } from "@/domain/ai-consumo";

export type DevOpsCommand =
  | "saude"
  | "status"
  | "uso"
  | "servidor"
  | "cura"
  | "alerta"
  | "templates"
  | "templates_sync"
  | "ops"
  | "crm_on"
  | "crm_off"
  | "consumo";

/** Números autorizados a comandos de ops no WhatsApp (só DEV). */
export function getDevOpsPhones(): string[] {
  const raw =
    process.env.DEV_OPS_PHONES ||
    process.env.DEV_NOTIFY_PHONE ||
    "+5561996715985";
  return raw
    .split(/[,;\s]+/)
    .map((p) => normalizePhoneDigits(p))
    .filter((p) => p.length >= 10);
}

export function normalizePhoneDigits(phone: string): string {
  return String(phone || "").replace(/\D/g, "");
}

export function isDevOpsPhone(phoneE164: string | null | undefined): boolean {
  if (!phoneE164) return false;
  const digits = normalizePhoneDigits(phoneE164);
  return getDevOpsPhones().some(
    (allowed) =>
      digits === allowed || digits.endsWith(allowed) || allowed.endsWith(digits)
  );
}

/**
 * Detecta comando de ops. Aceita: /saude, #saude, saude, "status assessor".
 * Só deve ser chamado depois de isDevOpsPhone.
 */
export function parseDevOpsCommand(text: string): DevOpsCommand | null {
  const raw = String(text || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
  if (!raw || raw.length > 80) return null;
  const t = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^[/#!]+/, "")
    .trim();

  if (/^(ops|comandos?|ajuda|help|help ops|ajuda ops)$/.test(t)) return "ops";
  if (/^(saude|health|relatorio|confiabilidade)$/.test(t)) return "saude";
  if (/^(status|ready|ping)$/.test(t)) return "status";
  if (/^(uso|kpis?|metricas|clients|clientes)$/.test(t)) return "uso";
  if (/^(consumoia|consumo ia|custoia|franquia|consumo|custo|gastos?|tokens?|ia|openai)$/.test(t)) return "consumo";
  if (
    /^(servidor|server|infra|recursos|memoria|cpu|host)$/.test(t)
  ) {
    return "servidor";
  }
  if (/^(cura|heal|curar)$/.test(t)) return "cura";
  if (/^(alerta|alertas|alert check)$/.test(t)) return "alerta";
  if (/^(templates_sync|tpl sync|sync templates)$/.test(t))
    return "templates_sync";
  if (/^(templates|tpl|modelos)$/.test(t)) return "templates";
  if (/^status\s+assessor$/.test(t)) return "status";
  if (/^saude\s+assessor$/.test(t)) return "saude";
  if (
    /^(crm off|crm parar|parar alertas? crm|desligar alertas? crm|sem alerta crm)$/.test(
      t
    )
  ) {
    return "crm_off";
  }
  if (
    /^(crm on|crm voltar|voltar alertas? crm|ligar alertas? crm|alerta crm)$/.test(t)
  ) {
    return "crm_on";
  }
  return null;
}

function hbLine(
  name: string,
  hb: { status: string; age_seconds: number | null }
) {
  const age = hb.age_seconds == null ? "—" : `${hb.age_seconds}s`;
  const icon = hb.status === "ONLINE" ? "✅" : "❌";
  return `${icon} *${name}*: ${hb.status} (${age})`;
}

export async function runDevOpsCommand(
  db: Db,
  command: DevOpsCommand
): Promise<string> {
  logger.info("dev_ops_command", { command });

  if (command === "ops") {
    return [
      "🛠️ *Comandos do DEV*",
      "_Só o seu número. Outro WhatsApp não abre._",
      "────────────",
      "*Consultar*",
      "• `/comandos` — esta lista",
      "• `/consumoia` — gasto de IA e o painel dos 7 dias",
      "• `/servidor` — RAM, CPU, disco, Postgres, fila",
      "• `/saude` — visão geral (pipeline + uso + infra)",
      "• `/uso` — KPIs de clientes e produto",
      "• `/status` — ready em 1 linha",
      "• `/templates` — status Meta/Zernio dos modelos",
      "",
      "*Ação*",
      "• `/cura` — heal gaps de lembrete (7d)",
      "• `/alerta` — força checagem de limiares",
      "• `/templates_sync` — sincroniza status APPROVED→active",
      "",
      "*Ajustes do dia (só seu número → Cursor)*",
      "• `/ajuste …` — pede feature/correção (responde o Assessor)",
      "• `/ajustes` — lista a fila do dia",
      "• `/agente` — engenheiro Cursor online ou fora do ar",
      "• `/crm off` — para de te avisar de cliente novo no CRM",
      "• `/crm on` — volta a te avisar",
      "────────────",
      "🚨 Limite de servidor/DB → alerta *automático* no Zap",
      "🖥 Admin: /admin/reliability · /admin/templates",
    ].join("\n");
  }

  if (command === "crm_off" || command === "crm_on") {
    const on = command === "crm_on";
    await setDevQuerAlertaCrm(db, on);
    return on
      ? "🔔 *Alertas de CRM ligados* para você.\nCliente novo volta a chegar neste número. A Tatiana continua recebendo sempre."
      : "🔕 *Alertas de CRM desligados* para você.\nA Tatiana continua recebendo. Para voltar: `/crm on`";
  }

  if (command === "status") {
    let dbOk = false;
    try {
      await databasePing(db);
      dbOk = true;
    } catch {
      dbOk = false;
    }
    const worker = await getHeartbeatStatus(db, "worker");
    const scheduler = await getHeartbeatStatus(db, "scheduler");
    const infra = await collectInfraSnapshot(db);
    const allOk =
      dbOk &&
      worker.status === "ONLINE" &&
      scheduler.status === "ONLINE" &&
      infra.warnings.length === 0;
    return [
      allOk ? "✅ *Assessor READY*" : "⚠️ *Assessor DEGRADADO*",
      `DB: ${dbOk ? "ONLINE" : "OFFLINE"}`,
      hbLine("worker", worker),
      hbLine("scheduler", scheduler),
      infra.warnings.length
        ? `Limite: ${infra.warnings.join(" · ")}`
        : "Limite: ok",
    ].join("\n");
  }

  if (command === "uso") {
    const kpis = await getUsageKpis(db);
    return formatUsageReport(kpis);
  }

  if (command === "consumo") {
    return formatAiConsumoReport(db);
  }

  if (command === "servidor") {
    const infra = await collectInfraSnapshot(db);
    return formatInfraReport(infra);
  }

  if (command === "cura") {
    const result = await healReminderCreateGaps(db, {
      sinceHours: 168,
      limit: 100,
    });
    return [
      "🩹 *Cura de gaps*",
      `Escaneados: ${result.scanned}`,
      `Curados: ${result.healed}`,
      `Pulados: ${result.skipped}`,
      `Erros: ${result.errors}`,
      result.healedIds.length
        ? `IDs: ${result.healedIds.slice(0, 5).join(", ")}`
        : "Nenhum gap curável.",
    ].join("\n");
  }

  if (command === "alerta") {
    const rel = await runReliabilityAlertTick(db);
    const infra = await runInfraAlertTick(db);
    return [
      rel.alerted || infra.alerted
        ? "🚨 *Checagem com alerta*"
        : "✅ *Checagem ok*",
      "",
      "*Confiabilidade*",
      `Phantoms 1h: ${rel.phantoms} · Healed: ${rel.healed}`,
      `Overdue: ${rel.overdue} · Jobs fail: ${rel.jobsFailed} · Gaps: ${rel.gaps}`,
      "",
      "*Infra*",
      infra.warnings.length
        ? `Sinais: ${infra.warnings.join(" · ")}`
        : "Sem sinais de limite",
      `Zap enviado: ${rel.alerted || infra.alerted ? "sim" : "não (cooldown ou ok)"}`,
    ].join("\n");
  }

  if (command === "templates" || command === "templates_sync") {
    const { ASSESSOR_TEMPLATE_CATALOG } = await import(
      "@/domain/whatsapp-templates-catalog"
    );
    const { listWhatsAppTemplates } = await import(
      "@/channels/zernio/templates-api"
    );
    const { resolveZernioRuntimeConfig, getTemplate } = await import(
      "@/domain/providers"
    );
    const { eq } = await import("drizzle-orm");
    const { whatsappTemplates } = await import("@/db/schema");

    const cfg = await resolveZernioRuntimeConfig(db);
    const listed = await listWhatsAppTemplates({
      apiKey: cfg.apiKey,
      apiUrl: cfg.apiUrl,
      accountId: cfg.accountId,
    });

    if (command === "templates_sync" && listed.ok) {
      for (const entry of ASSESSOR_TEMPLATE_CATALOG) {
        const hit = listed.templates.find((t) => t.name === entry.name);
        if (!hit) continue;
        const meta = String(hit.status || "").toUpperCase();
        const status =
          meta === "APPROVED"
            ? "active"
            : meta === "PENDING"
              ? "pending"
              : meta.toLowerCase();
        const existing = await getTemplate(db, entry.logicalName);
        if (existing) {
          await db
            .update(whatsappTemplates)
            .set({
              status,
              providerTemplateName: entry.name,
              language: entry.language,
              lastSyncAt: new Date(),
              metadata: {
                ...(existing.metadata || {}),
                meta_status: hit.status,
                meta_id: hit.id,
                phase: entry.phase,
              },
              updatedAt: new Date(),
            })
            .where(eq(whatsappTemplates.id, existing.id));
        } else {
          await db.insert(whatsappTemplates).values({
            logicalName: entry.logicalName,
            providerTemplateName: entry.name,
            language: entry.language,
            status,
            lastSyncAt: new Date(),
            metadata: {
              meta_status: hit.status,
              meta_id: hit.id,
              phase: entry.phase,
            },
          });
        }
      }
    }

    const lines: string[] = [
      command === "templates_sync"
        ? "🔄 *Templates sincronizados*"
        : "📋 *Templates WhatsApp*",
      listed.ok
        ? `Zernio: ${listed.templates.length} no WABA`
        : `Zernio list falhou: ${listed.error}`,
      "────────────",
    ];

    let approved = 0;
    let pending = 0;
    let other = 0;
    for (const entry of ASSESSOR_TEMPLATE_CATALOG) {
      const remote = listed.ok
        ? listed.templates.find((t) => t.name === entry.name)
        : undefined;
      const local = await getTemplate(db, entry.logicalName);
      const st = String(remote?.status || local?.status || "missing");
      const up = st.toUpperCase();
      if (up === "APPROVED" || st === "active") approved += 1;
      else if (up === "PENDING" || st === "pending") pending += 1;
      else other += 1;
      const icon =
        up === "APPROVED" || st === "active"
          ? "✅"
          : up === "PENDING" || st === "pending"
            ? "⏳"
            : up === "REJECTED"
              ? "❌"
              : "•";
      lines.push(
        `${icon} *${entry.phase}* ${entry.name}\n  ${st} · lógico \`${entry.logicalName}\``
      );
    }
    lines.push(
      "────────────",
      `✅ aprovados: ${approved} · ⏳ pendentes: ${pending} · outros: ${other}`,
      "_Meta pode levar até ~24h. Depois: `/templates_sync` e teste lembrete fora da janela._"
    );
    return lines.join("\n");
  }

  // saude — visão master: pipeline + uso resumido + infra
  let dbOk = false;
  try {
    await databasePing(db);
    dbOk = true;
  } catch {
    dbOk = false;
  }
  const snap = await getReliabilitySnapshot(db);
  const uso = await getUsageKpis(db);
  const infra = await collectInfraSnapshot(db);
  const worker = await getHeartbeatStatus(db, "worker");
  const scheduler = await getHeartbeatStatus(db, "scheduler");
  const lastAlert = await getHeartbeatStatus(db, "reliability_alert");

  const risk =
    snap.overdue_stuck > 0 ||
    snap.phantoms_24h > 0 ||
    snap.open_gaps_48h > 0 ||
    snap.deliver_failed_24h > 0 ||
    infra.warnings.length > 0;

  return [
    risk ? "⚠️ *Saúde · Assessor*" : "✅ *Saúde · Assessor*",
    `_${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}_`,
    "────────────",
    `DB: ${dbOk ? "ONLINE ✅" : "OFFLINE ❌"}`,
    hbLine("worker", worker),
    hbLine("scheduler", scheduler),
    hbLine("alertas", lastAlert),
    "",
    "⏰ *Pipeline lembretes*",
    `• Agendados / overdue: *${snap.scheduled_future}* / *${snap.overdue_stuck}*`,
    `• Entregues 24h / falhas: *${snap.delivered_24h}* / *${snap.deliver_failed_24h}*`,
    `• Phantoms / curados / gaps: *${snap.phantoms_24h}* / *${snap.healed_24h}* / *${snap.open_gaps_48h}*`,
    "",
    "📊 *Uso (resumo)*",
    `• Ativos 7d: *${uso.usersActive7d}* · In 24h: *${uso.inbound24h}*`,
    `• Lembretes 24h criados/entregues: *${uso.remindersCreated24h}*/*${uso.remindersDelivered24h}*`,
    `• Tools 24h: *${uso.toolCalls24h}*`,
    "",
    "🖥️ *Infra*",
    infra.hostMem
      ? `• RAM ${infra.hostMem.usedPct}% · livre ${infra.hostMem.availableMb}MB`
      : "• RAM: —",
    infra.disk ? `• Disco ${infra.disk.pct}%` : "• Disco: —",
    `• Load ${infra.load1} · PG ${infra.db.connPct}% · fila ${infra.db.jobsQueued}`,
    infra.warnings.length
      ? `• 🚨 ${infra.warnings.join(" · ")}`
      : "• Limites ok ✅",
    "────────────",
    "_/uso · /consumo · /servidor · /ops_",
  ].join("\n");
}
