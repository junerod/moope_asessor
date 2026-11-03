import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import {
  requirePlatformAdminFromAuthHeader,
  writeAdminAudit,
} from "@/domain/platform-admin";
import { plans } from "@/db/schema";

async function requireAdmin(req: NextRequest) {
  const db = getDb();
  return requirePlatformAdminFromAuthHeader(
    db,
    req.headers.get("authorization")
  );
}

export async function GET(req: NextRequest) {
  const db = getDb();
  try {
    await requireAdmin(req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    return NextResponse.json(
      { error: msg },
      { status: msg === "forbidden" ? 403 : 401 }
    );
  }

  const rows = await db.query.plans.findMany({
    orderBy: [desc(plans.updatedAt)],
  });
  return NextResponse.json({
    plans: rows.map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      status: p.status,
      limits: p.limitsJson,
      features: p.featuresJson,
      updated_at: p.updatedAt,
    })),
  });
}

export async function PUT(req: NextRequest) {
  const db = getDb();
  let actor;
  try {
    actor = await requireAdmin(req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    return NextResponse.json(
      { error: msg },
      { status: msg === "forbidden" ? 403 : 401 }
    );
  }

  const schema = z.object({
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(128),
    status: z.enum(["active", "inactive", "draft"]).default("active"),
    limits: z.record(z.string(), z.unknown()).optional(),
    features: z.record(z.string(), z.unknown()).optional(),
  });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  const existing = await db.query.plans.findFirst({
    where: eq(plans.code, parsed.data.code),
  });

  let row;
  if (existing) {
    [row] = await db
      .update(plans)
      .set({
        name: parsed.data.name,
        status: parsed.data.status,
        limitsJson: parsed.data.limits ?? existing.limitsJson,
        featuresJson: parsed.data.features ?? existing.featuresJson,
        updatedAt: new Date(),
      })
      .where(eq(plans.id, existing.id))
      .returning();
  } else {
    [row] = await db
      .insert(plans)
      .values({
        code: parsed.data.code,
        name: parsed.data.name,
        status: parsed.data.status,
        limitsJson: parsed.data.limits ?? {},
        featuresJson: parsed.data.features ?? {},
      })
      .returning();
  }

  await writeAdminAudit(db, {
    actorUserId: actor.user.id,
    action: existing ? "plan.updated" : "plan.created",
    resourceType: "plan",
    resourceId: row.id,
    metadata: { code: row.code },
  });

  return NextResponse.json({ ok: true, plan: row });
}
