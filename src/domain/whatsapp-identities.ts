import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { whatsappIdentities } from "@/db/schema";
import { phoneDigitVariants } from "@/domain/access-whitelist";
import { hashPassword, verifyPassword } from "@/lib/auth";
import { randomNumericCode } from "@/lib/crypto";

/**
 * E.164 BR: celular canônico com 9 após o DDD quando aplicável.
 */
export function normalizePhoneE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("55")) d = d.slice(2);
  if (d.length === 10 || d.length === 11) {
    const ddd = d.slice(0, 2);
    let rest = d.slice(2);
    if (rest.length === 8 && /^[6-9]/.test(rest)) {
      rest = `9${rest}`;
    }
    return `+55${ddd}${rest}`;
  }
  if (d.length >= 12) return `+${String(raw).replace(/\D/g, "")}`;
  if (String(raw).trim().startsWith("+")) return `+${String(raw).replace(/\D/g, "")}`;
  return null;
}

export async function findWhatsappIdentity(
  db: Db,
  input: { phoneE164?: string | null; bsuid?: string | null }
) {
  const phone = normalizePhoneE164(input.phoneE164);
  const bsuid = input.bsuid?.trim() || null;

  if (!phone && !bsuid) return null;

  const conditions = [];
  if (phone) {
    const digitVars = phoneDigitVariants(phone);
    const e164Vars = [
      ...new Set(
        digitVars.map((v) => {
          const d = v.replace(/\D/g, "");
          return d.startsWith("55") ? `+${d}` : `+55${d}`;
        })
      ),
      phone,
    ];
    conditions.push(inArray(whatsappIdentities.phoneE164, e164Vars));
  }
  if (bsuid) conditions.push(eq(whatsappIdentities.bsuid, bsuid));

  return db.query.whatsappIdentities.findFirst({
    where: and(or(...conditions), isNull(whatsappIdentities.deletedAt)),
  });
}

export async function upsertUnknownIdentity(
  db: Db,
  input: {
    phoneE164?: string | null;
    bsuid?: string | null;
    displayName?: string | null;
  }
) {
  const existing = await findWhatsappIdentity(db, input);
  if (existing) {
    const canonical = normalizePhoneE164(input.phoneE164) || existing.phoneE164;
    const [updated] = await db
      .update(whatsappIdentities)
      .set({
        lastSeenAt: new Date(),
        displayName: input.displayName || existing.displayName,
        // Prefer form with 9 (canonical) when we can upgrade
        phoneE164:
          canonical &&
          (!existing.phoneE164 ||
            canonical.replace(/\D/g, "").length >=
              String(existing.phoneE164).replace(/\D/g, "").length)
            ? canonical
            : existing.phoneE164,
        bsuid: existing.bsuid || input.bsuid?.trim() || null,
        updatedAt: new Date(),
      })
      .where(eq(whatsappIdentities.id, existing.id))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(whatsappIdentities)
    .values({
      phoneE164: normalizePhoneE164(input.phoneE164),
      bsuid: input.bsuid?.trim() || null,
      displayName: input.displayName || null,
      status: "unpaired",
      lastSeenAt: new Date(),
    })
    .returning();
  return created;
}

export async function startIdentityVerification(
  db: Db,
  identityId: string
): Promise<{ code: string; expiresAt: Date }> {
  const code = randomNumericCode(6);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  const verificationCodeHash = await hashPassword(code);

  await db
    .update(whatsappIdentities)
    .set({
      status: "pending_verification",
      verificationCodeHash,
      verificationExpiresAt: expiresAt,
      verificationAttempts: 0,
      updatedAt: new Date(),
    })
    .where(eq(whatsappIdentities.id, identityId));

  return { code, expiresAt };
}

export async function verifyIdentityCode(
  db: Db,
  identityId: string,
  code: string
): Promise<boolean> {
  const identity = await db.query.whatsappIdentities.findFirst({
    where: eq(whatsappIdentities.id, identityId),
  });
  if (!identity?.verificationCodeHash || !identity.verificationExpiresAt) {
    return false;
  }
  if (identity.verificationExpiresAt.getTime() < Date.now()) {
    return false;
  }
  if (identity.verificationAttempts >= 5) {
    return false;
  }

  await db
    .update(whatsappIdentities)
    .set({
      verificationAttempts: sql`${whatsappIdentities.verificationAttempts} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(whatsappIdentities.id, identityId));

  return verifyPassword(code, identity.verificationCodeHash);
}

export async function pairIdentityToUser(
  db: Db,
  input: { identityId: string; userId: string }
) {
  // Enforce: one identity cannot belong to two users
  const identity = await db.query.whatsappIdentities.findFirst({
    where: eq(whatsappIdentities.id, input.identityId),
  });
  if (!identity) throw new Error("identity_not_found");
  if (identity.userId && identity.userId !== input.userId) {
    throw new Error("identity_already_paired");
  }

  const [updated] = await db
    .update(whatsappIdentities)
    .set({
      userId: input.userId,
      status: "paired",
      pairedAt: new Date(),
      verificationCodeHash: null,
      verificationExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(eq(whatsappIdentities.id, input.identityId))
    .returning();

  return updated;
}
