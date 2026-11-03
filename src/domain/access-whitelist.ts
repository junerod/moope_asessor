import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  clientAccessWhitelist,
  platformSettings,
  whatsappIdentities,
  workspaceMembers,
} from "@/db/schema";
import { normalizePhoneE164 } from "@/domain/whatsapp-identities";

export function phoneDigitsOnly(raw: string | null | undefined): string | null {
  const n = normalizePhoneE164(raw);
  if (!n) return null;
  const digits = n.replace(/\D/g, "");
  return digits || null;
}

/** Celular brasileiro chega com ou sem o 9 depois do DDD (61998052151 e 6198052151). */
export function phoneDigitVariants(raw: string | null | undefined): string[] {
  const digits = phoneDigitsOnly(raw);
  if (!digits) return [];
  const set = new Set<string>([digits]);
  const national =
    digits.startsWith("55") && digits.length >= 12 ? digits.slice(2) : digits;
  const nationals = new Set<string>([national]);
  if (national.length === 11 && national[2] === "9") {
    nationals.add(national.slice(0, 2) + national.slice(3));
  }
  if (national.length === 10) {
    nationals.add(national.slice(0, 2) + "9" + national.slice(2));
  }
  for (const n of nationals) {
    set.add(n);
    set.add(`55${n}`);
  }
  return [...set];
}

export async function isPhoneWhitelisted(
  db: Db,
  phone: string | null | undefined
): Promise<boolean> {
  const variants = phoneDigitVariants(phone);
  if (!variants.length) return false;
  const row = await db.query.clientAccessWhitelist.findFirst({
    where: and(
      inArray(clientAccessWhitelist.phoneDigits, variants),
      isNull(clientAccessWhitelist.deletedAt)
    ),
  });
  return Boolean(row);
}

export async function isWorkspaceWhitelisted(
  db: Db,
  workspaceId: string
): Promise<boolean> {
  const members = await db.query.workspaceMembers.findMany({
    where: eq(workspaceMembers.workspaceId, workspaceId),
  });
  for (const m of members) {
    const identities = await db.query.whatsappIdentities.findMany({
      where: and(
        eq(whatsappIdentities.userId, m.userId),
        isNull(whatsappIdentities.deletedAt)
      ),
    });
    for (const id of identities) {
      if (await isPhoneWhitelisted(db, id.phoneE164)) return true;
    }
  }
  return false;
}

export async function listWhitelist(db: Db) {
  return db.query.clientAccessWhitelist.findMany({
    where: isNull(clientAccessWhitelist.deletedAt),
    orderBy: [desc(clientAccessWhitelist.createdAt)],
  });
}

export async function addToWhitelist(
  db: Db,
  input: {
    phone: string;
    label?: string | null;
    notes?: string | null;
    createdByUserId?: string | null;
  }
) {
  const phoneE164 = normalizePhoneE164(input.phone);
  const phoneDigits = phoneDigitsOnly(input.phone);
  if (!phoneE164 || !phoneDigits) {
    throw new Error("invalid_phone");
  }

  const existing = await db.query.clientAccessWhitelist.findFirst({
    where: and(
      eq(clientAccessWhitelist.phoneDigits, phoneDigits),
      isNull(clientAccessWhitelist.deletedAt)
    ),
  });
  if (existing) return existing;

  const soft = await db.query.clientAccessWhitelist.findFirst({
    where: eq(clientAccessWhitelist.phoneDigits, phoneDigits),
  });
  if (soft?.deletedAt) {
    const [row] = await db
      .update(clientAccessWhitelist)
      .set({
        deletedAt: null,
        phoneE164,
        label: input.label ?? soft.label,
        notes: input.notes ?? soft.notes,
        createdByUserId: input.createdByUserId ?? soft.createdByUserId,
        updatedAt: new Date(),
      })
      .where(eq(clientAccessWhitelist.id, soft.id))
      .returning();
    return row;
  }

  const [row] = await db
    .insert(clientAccessWhitelist)
    .values({
      phoneE164,
      phoneDigits,
      label: input.label || null,
      notes: input.notes || null,
      createdByUserId: input.createdByUserId || null,
    })
    .returning();
  return row;
}

export async function removeFromWhitelist(db: Db, id: string) {
  const [row] = await db
    .update(clientAccessWhitelist)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(clientAccessWhitelist.id, id), isNull(clientAccessWhitelist.deletedAt)))
    .returning();
  return row || null;
}

/** Soft-remove pela lista de dígitos (variantes BR). Usado pelo sync Finance → Assessor. */
export async function removeFromWhitelistByPhone(
  db: Db,
  phone: string
): Promise<{ removed: number }> {
  const variants = phoneDigitVariants(phone);
  if (!variants.length) return { removed: 0 };
  const rows = await db.query.clientAccessWhitelist.findMany({
    where: and(
      inArray(clientAccessWhitelist.phoneDigits, variants),
      isNull(clientAccessWhitelist.deletedAt)
    ),
  });
  let removed = 0;
  for (const row of rows) {
    await db
      .update(clientAccessWhitelist)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(clientAccessWhitelist.id, row.id));
    removed += 1;
  }
  return { removed };
}

export async function isPaywallEnforced(db: Db): Promise<boolean> {
  const row = await db.query.platformSettings.findFirst({
    where: and(
      eq(platformSettings.namespace, "billing"),
      eq(platformSettings.key, "paywall_enforced")
    ),
  });
  const v = row?.valueJson as { enabled?: boolean } | undefined;
  return Boolean(v?.enabled);
}

export async function setPaywallEnforced(
  db: Db,
  enabled: boolean,
  updatedByUserId?: string | null
) {
  const existing = await db.query.platformSettings.findFirst({
    where: and(
      eq(platformSettings.namespace, "billing"),
      eq(platformSettings.key, "paywall_enforced")
    ),
  });
  if (existing) {
    const [row] = await db
      .update(platformSettings)
      .set({
        valueJson: { enabled },
        updatedByUserId: updatedByUserId || null,
        updatedAt: new Date(),
      })
      .where(eq(platformSettings.id, existing.id))
      .returning();
    return row;
  }
  const [row] = await db
    .insert(platformSettings)
    .values({
      namespace: "billing",
      key: "paywall_enforced",
      valueJson: { enabled },
      updatedByUserId: updatedByUserId || null,
    })
    .returning();
  return row;
}
