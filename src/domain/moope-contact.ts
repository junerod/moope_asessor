import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { platformSettings } from "@/db/schema";
import { normalizePhoneE164 } from "@/domain/whatsapp-identities";

export type MoopeContact = {
  phoneE164: string;
  label: string;
};

const DEFAULT_LABEL = "Comercial / suporte MOOPE";

export async function getMoopeContact(db: Db): Promise<MoopeContact> {
  const row = await db.query.platformSettings.findFirst({
    where: and(
      eq(platformSettings.namespace, "assessor"),
      eq(platformSettings.key, "moope_contact")
    ),
  });
  const v = (row?.valueJson || {}) as {
    phone_e164?: string;
    label?: string;
  };
  return {
    phoneE164: String(v.phone_e164 || "").trim(),
    label: String(v.label || DEFAULT_LABEL).trim() || DEFAULT_LABEL,
  };
}

export async function setMoopeContact(
  db: Db,
  input: { phone: string; label?: string | null; updatedByUserId?: string | null }
) {
  const phoneE164 = normalizePhoneE164(input.phone);
  if (!phoneE164) throw new Error("invalid_phone");
  const label =
    String(input.label || "").trim() || DEFAULT_LABEL;
  const valueJson = { phone_e164: phoneE164, label };

  const existing = await db.query.platformSettings.findFirst({
    where: and(
      eq(platformSettings.namespace, "assessor"),
      eq(platformSettings.key, "moope_contact")
    ),
  });
  if (existing) {
    const [row] = await db
      .update(platformSettings)
      .set({
        valueJson,
        updatedByUserId: input.updatedByUserId || null,
        updatedAt: new Date(),
      })
      .where(eq(platformSettings.id, existing.id))
      .returning();
    return row;
  }
  const [row] = await db
    .insert(platformSettings)
    .values({
      namespace: "assessor",
      key: "moope_contact",
      valueJson,
      updatedByUserId: input.updatedByUserId || null,
    })
    .returning();
  return row;
}

/** Texto WhatsApp + link wa.me quando houver número configurado. */
export function formatMoopeContactCta(contact: MoopeContact): string {
  if (!contact.phoneE164) {
    return "Quer liberar? Fala com a MOOPE (comercial / suporte).";
  }
  const digits = contact.phoneE164.replace(/\D/g, "");
  const display = contact.phoneE164;
  const wa = `https://wa.me/${digits}`;
  return [
    `Quer liberar? Fala com a MOOPE (${contact.label}):`,
    display,
    wa,
  ].join("\n");
}
