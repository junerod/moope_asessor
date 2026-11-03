import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { adminAuditLogs, platformAdmins, users } from "@/db/schema";
import { verifyAccessToken } from "@/lib/auth";

export async function isPlatformAdmin(db: Db, userId: string) {
  const row = await db.query.platformAdmins.findFirst({
    where: and(
      eq(platformAdmins.userId, userId),
      isNull(platformAdmins.revokedAt)
    ),
  });
  return row ?? null;
}

export async function requirePlatformAdminFromAuthHeader(
  db: Db,
  authorization: string | null
) {
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : null;
  if (!token) throw new Error("unauthorized");
  const payload = await verifyAccessToken(token);
  if (!payload) throw new Error("unauthorized");
  const user = await db.query.users.findFirst({
    where: eq(users.id, payload.sub),
  });
  if (!user || user.deletedAt) throw new Error("unauthorized");
  const admin = await isPlatformAdmin(db, user.id);
  if (!admin) throw new Error("forbidden");
  return { user, admin };
}

export async function ensurePlatformAdmin(
  db: Db,
  userId: string,
  role: "super_admin" | "operator" | "support" = "super_admin"
) {
  const existing = await isPlatformAdmin(db, userId);
  if (existing) return existing;
  const [row] = await db
    .insert(platformAdmins)
    .values({ userId, role })
    .returning();
  return row;
}

export async function writeAdminAudit(
  db: Db,
  input: {
    actorUserId: string;
    action: string;
    resourceType?: string;
    resourceId?: string;
    metadata?: Record<string, unknown>;
  }
) {
  await db.insert(adminAuditLogs).values({
    actorUserId: input.actorUserId,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    metadata: sanitizeAuditMetadata(input.metadata || {}),
  });
}

function sanitizeAuditMetadata(meta: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (/secret|password|token|api_key|authorization|ciphertext/i.test(k)) {
      out[k] = "[redacted]";
    } else {
      out[k] = v;
    }
  }
  return out;
}
