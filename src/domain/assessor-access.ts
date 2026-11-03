import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { subscriptions, users } from "@/db/schema";
import { isPhoneWhitelisted } from "@/domain/access-whitelist";
import {
  formatMoopeContactCta,
  getMoopeContact,
} from "@/domain/moope-contact";

/** Preço de referência. A cobrança automática fica para depois. */
export const ASSESSOR_MONTHLY_PRICE_BRL = 39.9;
export const ASSESSOR_TRIAL_DAYS = 7;

export type CommercialAccess = {
  allowed: boolean;
  reason: "whitelist" | "paid" | "trial" | "expired";
  priceBrl: number;
  trialEndsAt?: string;
};

export async function assessorCommercialAccess(
  db: Db,
  input: { phone?: string | null; workspaceId: string; userId: string }
): Promise<CommercialAccess> {
  if (await isPhoneWhitelisted(db, input.phone)) {
    return { allowed: true, reason: "whitelist", priceBrl: ASSESSOR_MONTHLY_PRICE_BRL };
  }

  const sub = await db.query.subscriptions.findFirst({
    where: eq(subscriptions.workspaceId, input.workspaceId),
  });
  if (sub && (sub.status === "active" || sub.status === "comped")) {
    return { allowed: true, reason: "paid", priceBrl: ASSESSOR_MONTHLY_PRICE_BRL };
  }

  const user = await db.query.users.findFirst({
    where: eq(users.id, input.userId),
  });
  const started = user?.createdAt ? new Date(user.createdAt).getTime() : Date.now();
  const ends = started + ASSESSOR_TRIAL_DAYS * 24 * 3600 * 1000;
  if (Date.now() < ends) {
    return {
      allowed: true,
      reason: "trial",
      priceBrl: ASSESSOR_MONTHLY_PRICE_BRL,
      trialEndsAt: new Date(ends).toISOString(),
    };
  }

  return { allowed: false, reason: "expired", priceBrl: ASSESSOR_MONTHLY_PRICE_BRL };
}

export async function commercialBlockedSummary(
  db: Db,
  access: CommercialAccess
) {
  const contact = await getMoopeContact(db);
  return [
    "O período de teste de 7 dias deste número terminou.",
    `O Assessor fica R$ ${access.priceBrl.toFixed(2).replace(".", ",")} por mês.`,
    formatMoopeContactCta(contact),
  ].join("\n");
}
