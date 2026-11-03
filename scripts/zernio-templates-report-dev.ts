#!/usr/bin/env tsx
/**
 * Envia relatório de templates para o número DEV.
 *   npx tsx scripts/zernio-templates-report-dev.ts
 */
import { sql } from "drizzle-orm";
import { getDb, closeDb } from "@/db/client";
import { listWhatsAppTemplates } from "@/channels/zernio/templates-api";
import { ASSESSOR_TEMPLATE_CATALOG } from "@/domain/whatsapp-templates-catalog";
import { resolveZernioRuntimeConfig } from "@/domain/providers";
import { notifyDevWhatsApp } from "@/domain/dev-ops-metrics";

async function main() {
  const db = getDb();
  try {
    const cfg = await resolveZernioRuntimeConfig(db);
    const listed = await listWhatsAppTemplates({
      apiKey: cfg.apiKey,
      apiUrl: cfg.apiUrl,
      accountId: cfg.accountId,
    });

    const byName = new Map(
      (listed.templates || []).map((t) => [t.name, t])
    );

    let approved = 0;
    let pending = 0;
    let rejected = 0;
    const lines: string[] = [];

    for (const entry of ASSESSOR_TEMPLATE_CATALOG) {
      const t = byName.get(entry.name);
      const st = String(t?.status || "MISSING");
      const up = st.toUpperCase();
      if (up === "APPROVED") approved += 1;
      else if (up === "PENDING") pending += 1;
      else if (up === "REJECTED") rejected += 1;
      const icon =
        up === "APPROVED"
          ? "✅"
          : up === "PENDING"
            ? "⏳"
            : up === "REJECTED"
              ? "❌"
              : "•";
      const reason =
        up === "REJECTED" && (t as { rejected_reason?: string })?.rejected_reason
          ? ` (${(t as { rejected_reason?: string }).rejected_reason})`
          : "";
      lines.push(`${icon} ${entry.phase} ${entry.name}: ${st}${reason}`);
    }

    const text = [
      "📋 *Relatório Templates · passo publicar*",
      `WABA: ${listed.templates?.length || 0} · catálogo: ${ASSESSOR_TEMPLATE_CATALOG.length}`,
      `✅ ${approved} · ⏳ ${pending} · ❌ ${rejected}`,
      "────────────",
      ...lines,
      "────────────",
      "Regras: sem {{n}} no início/fim · \\r dentro de {{n}}",
      "Quando Meta liberar: `/templates_sync` e testamos envio.",
    ]
      .filter(Boolean)
      .join("\n");

    const ok = await notifyDevWhatsApp(
      db,
      text,
      `tpl_report:${Date.now()}`
    );
    console.log(JSON.stringify({ ok, approved, pending, rejected, text }, null, 2));
  } finally {
    await closeDb();
  }
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: String(e) }));
  process.exit(1);
});
