import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { platformSettings } from "@/db/schema";

const NS = "dev";
const KEY = "crm_alerts_dev";

function devDigits(): string {
  return (process.env.DEV_NOTIFY_PHONE || "+5561996715985").replace(/\D/g, "");
}

export function isDevAlertPhone(phone: string): boolean {
  const d = phone.replace(/\D/g, "");
  const dev = devDigits();
  if (d.length < 10 || dev.length < 10) return false;
  const a = d.slice(-11);
  const b = dev.slice(-11);
  return a === b || d.endsWith(b) || dev.endsWith(a);
}

/** DEV recebe aviso de cliente novo no CRM, salvo se pediu para parar. */
export async function devQuerAlertaCrm(db: Db): Promise<boolean> {
  const row = await db.query.platformSettings.findFirst({
    where: and(eq(platformSettings.namespace, NS), eq(platformSettings.key, KEY)),
  });
  const enabled = (row?.valueJson as { enabled?: boolean } | null)?.enabled;
  return enabled !== false;
}

export async function setDevQuerAlertaCrm(db: Db, enabled: boolean): Promise<void> {
  const existing = await db.query.platformSettings.findFirst({
    where: and(eq(platformSettings.namespace, NS), eq(platformSettings.key, KEY)),
  });
  const valueJson = { enabled };
  if (existing) {
    await db
      .update(platformSettings)
      .set({ valueJson, updatedAt: new Date() })
      .where(eq(platformSettings.id, existing.id));
    return;
  }
  await db.insert(platformSettings).values({ namespace: NS, key: KEY, valueJson });
}
