import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { clientAccessBlacklist } from "@/db/schema";
import {
  phoneDigitVariants,
  phoneDigitsOnly,
} from "@/domain/access-whitelist";
import { normalizePhoneE164 } from "@/domain/whatsapp-identities";

export async function isPhoneBanned(
  db: Db,
  phone: string | null | undefined
): Promise<boolean> {
  const variants = phoneDigitVariants(phone);
  if (!variants.length) return false;
  const row = await db.query.clientAccessBlacklist.findFirst({
    where: and(
      inArray(clientAccessBlacklist.phoneDigits, variants),
      isNull(clientAccessBlacklist.deletedAt)
    ),
  });
  return Boolean(row);
}

export async function listBlacklist(db: Db) {
  return db.query.clientAccessBlacklist.findMany({
    where: isNull(clientAccessBlacklist.deletedAt),
    orderBy: [desc(clientAccessBlacklist.createdAt)],
  });
}

export async function addToBlacklist(
  db: Db,
  input: {
    phone: string;
    reason?: string | null;
    notes?: string | null;
    createdByUserId?: string | null;
  }
) {
  const phoneE164 = normalizePhoneE164(input.phone);
  const phoneDigits = phoneDigitsOnly(input.phone);
  if (!phoneE164 || !phoneDigits) {
    throw new Error("invalid_phone");
  }

  const existing = await db.query.clientAccessBlacklist.findFirst({
    where: and(
      eq(clientAccessBlacklist.phoneDigits, phoneDigits),
      isNull(clientAccessBlacklist.deletedAt)
    ),
  });
  if (existing) return existing;

  const soft = await db.query.clientAccessBlacklist.findFirst({
    where: eq(clientAccessBlacklist.phoneDigits, phoneDigits),
  });
  if (soft?.deletedAt) {
    const [row] = await db
      .update(clientAccessBlacklist)
      .set({
        deletedAt: null,
        phoneE164,
        reason: input.reason ?? soft.reason,
        notes: input.notes ?? soft.notes,
        createdByUserId: input.createdByUserId ?? soft.createdByUserId,
        updatedAt: new Date(),
      })
      .where(eq(clientAccessBlacklist.id, soft.id))
      .returning();
    return row;
  }

  const [row] = await db
    .insert(clientAccessBlacklist)
    .values({
      phoneE164,
      phoneDigits,
      reason: input.reason || null,
      notes: input.notes || null,
      createdByUserId: input.createdByUserId || null,
    })
    .returning();
  return row;
}

export async function removeFromBlacklist(db: Db, id: string) {
  const [row] = await db
    .update(clientAccessBlacklist)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(clientAccessBlacklist.id, id),
        isNull(clientAccessBlacklist.deletedAt)
      )
    )
    .returning();
  return row || null;
}
