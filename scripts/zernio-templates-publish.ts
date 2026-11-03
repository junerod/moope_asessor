#!/usr/bin/env tsx
/**
 * Publica o catálogo de templates no Zernio/Meta e sincroniza whatsapp_templates.
 *
 *   npx tsx scripts/zernio-templates-publish.ts           # cria faltantes
 *   npx tsx scripts/zernio-templates-publish.ts --sync    # só sincroniza status
 *   npx tsx scripts/zernio-templates-publish.ts --phase=P0
 *   npx tsx scripts/zernio-templates-publish.ts --dry-run
 */
import { eq } from "drizzle-orm";
import { getDb, closeDb } from "@/db/client";
import { whatsappTemplates } from "@/db/schema";
import {
  ASSESSOR_TEMPLATE_CATALOG,
  zernioCreatePayload,
  type TemplateCatalogEntry,
} from "@/domain/whatsapp-templates-catalog";
import {
  createWhatsAppTemplate,
  listWhatsAppTemplates,
} from "@/channels/zernio/templates-api";
import { resolveZernioRuntimeConfig } from "@/domain/providers";

function mapMetaStatus(raw: string | undefined): string {
  const s = String(raw || "").toUpperCase();
  if (s === "APPROVED") return "active";
  if (s === "PENDING" || s === "IN_APPEAL") return "pending";
  if (s === "REJECTED" || s === "DISABLED" || s === "PAUSED")
    return String(raw || "rejected").toLowerCase();
  return String(raw || "draft").toLowerCase();
}

async function upsertLocal(
  db: ReturnType<typeof getDb>,
  entry: TemplateCatalogEntry,
  metaStatus: string,
  extra?: Record<string, unknown>
) {
  const status = mapMetaStatus(metaStatus);
  const existing = await db.query.whatsappTemplates.findFirst({
    where: eq(whatsappTemplates.logicalName, entry.logicalName),
  });
  const metadata = {
    phase: entry.phase,
    category: entry.category,
    description: entry.description,
    provider_name: entry.name,
    meta_status: metaStatus,
    ...(extra || {}),
  };
  if (existing) {
    await db
      .update(whatsappTemplates)
      .set({
        providerTemplateName: entry.name,
        language: entry.language,
        status,
        lastSyncAt: new Date(),
        metadata,
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
      metadata,
    });
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const syncOnly = process.argv.includes("--sync");
  const phaseArg = process.argv.find((a) => a.startsWith("--phase="));
  const phase = phaseArg?.split("=")[1]?.toUpperCase() as
    | "P0"
    | "P1"
    | "P2"
    | undefined;

  const catalog = phase
    ? ASSESSOR_TEMPLATE_CATALOG.filter((t) => t.phase === phase)
    : ASSESSOR_TEMPLATE_CATALOG;

  const db = getDb();
  const report: Array<Record<string, unknown>> = [];

  try {
    const cfg = await resolveZernioRuntimeConfig(db);
    if (!cfg.apiKey || !cfg.accountId) {
      throw new Error("zernio_credentials_missing");
    }

    const listed = await listWhatsAppTemplates({
      apiKey: cfg.apiKey,
      apiUrl: cfg.apiUrl,
      accountId: cfg.accountId,
    });
    if (!listed.ok) {
      throw new Error(`list_failed:${listed.error}`);
    }

    const byName = new Map(
      listed.templates.map((t) => [`${t.name}::${t.language || "pt_BR"}`, t])
    );

    for (const entry of catalog) {
      const key = `${entry.name}::${entry.language}`;
      const existing = byName.get(key) || byName.get(`${entry.name}::pt_BR`);

      if (existing) {
        if (!dryRun) {
          await upsertLocal(db, entry, existing.status, {
            meta_id: existing.id,
          });
        }
        report.push({
          action: "exists",
          name: entry.name,
          logical: entry.logicalName,
          phase: entry.phase,
          status: existing.status,
        });
        continue;
      }

      if (syncOnly) {
        report.push({
          action: "missing",
          name: entry.name,
          logical: entry.logicalName,
          phase: entry.phase,
        });
        continue;
      }

      if (dryRun) {
        report.push({
          action: "would_create",
          name: entry.name,
          logical: entry.logicalName,
          phase: entry.phase,
          category: entry.category,
        });
        continue;
      }

      const payload = zernioCreatePayload(entry, cfg.accountId);
      const created = await createWhatsAppTemplate(payload, {
        apiKey: cfg.apiKey,
        apiUrl: cfg.apiUrl,
        accountId: cfg.accountId,
      });

      const metaStatus =
        created.template?.status ||
        (created.ok ? "PENDING" : "ERROR");

      await upsertLocal(db, entry, String(metaStatus), {
        create_ok: created.ok,
        create_status: created.status,
        create_raw: created.raw,
      });

      report.push({
        action: created.ok ? "created" : "create_failed",
        name: entry.name,
        logical: entry.logicalName,
        phase: entry.phase,
        status: metaStatus,
        http: created.status,
        error: created.error,
        raw: created.ok ? undefined : created.raw,
      });

      // leve pacing pra não estourar rate limit
      await new Promise((r) => setTimeout(r, 400));
    }

    // Resync all after creates
    if (!dryRun && !syncOnly) {
      const again = await listWhatsAppTemplates({
        apiKey: cfg.apiKey,
        apiUrl: cfg.apiUrl,
        accountId: cfg.accountId,
      });
      if (again.ok) {
        for (const entry of catalog) {
          const hit = again.templates.find(
            (t) =>
              t.name === entry.name &&
              (t.language === entry.language || !t.language)
          );
          if (hit) await upsertLocal(db, entry, hit.status, { meta_id: hit.id });
        }
      }
    }

    const summary = {
      ok: true,
      dry_run: dryRun,
      sync_only: syncOnly,
      phase: phase || "ALL",
      total_catalog: catalog.length,
      created: report.filter((r) => r.action === "created").length,
      exists: report.filter((r) => r.action === "exists").length,
      failed: report.filter((r) => r.action === "create_failed").length,
      items: report,
    };
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String(err) }));
  process.exit(1);
});
