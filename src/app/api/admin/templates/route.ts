import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import {
  requirePlatformAdminFromAuthHeader,
  writeAdminAudit,
} from "@/domain/platform-admin";
import { whatsappTemplates } from "@/db/schema";

export async function GET(req: NextRequest) {
  const db = getDb();
  try {
    await requirePlatformAdminFromAuthHeader(
      db,
      req.headers.get("authorization")
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    return NextResponse.json(
      { error: msg },
      { status: msg === "forbidden" ? 403 : 401 }
    );
  }
  const templates = await db.query.whatsappTemplates.findMany();
  return NextResponse.json({
    templates: templates.map((t) => ({
      logical_name: t.logicalName,
      provider_template_name: t.providerTemplateName,
      language: t.language,
      status: t.status,
      last_sync_at: t.lastSyncAt,
    })),
  });
}

const putSchema = z.object({
  logical_name: z.string().min(1),
  provider_template_name: z.string().min(1),
  language: z.string().default("pt_BR"),
  status: z.enum(["draft", "active"]).default("draft"),
});

export async function PUT(req: NextRequest) {
  const db = getDb();
  let actor;
  try {
    actor = await requirePlatformAdminFromAuthHeader(
      db,
      req.headers.get("authorization")
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    return NextResponse.json(
      { error: msg },
      { status: msg === "forbidden" ? 403 : 401 }
    );
  }

  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  const existing = await db.query.whatsappTemplates.findFirst({
    where: eq(whatsappTemplates.logicalName, parsed.data.logical_name),
  });

  let row;
  if (existing) {
    [row] = await db
      .update(whatsappTemplates)
      .set({
        providerTemplateName: parsed.data.provider_template_name,
        language: parsed.data.language,
        status: parsed.data.status,
        lastSyncAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(whatsappTemplates.id, existing.id))
      .returning();
  } else {
    [row] = await db
      .insert(whatsappTemplates)
      .values({
        logicalName: parsed.data.logical_name,
        providerTemplateName: parsed.data.provider_template_name,
        language: parsed.data.language,
        status: parsed.data.status,
        lastSyncAt: new Date(),
      })
      .returning();
  }

  await writeAdminAudit(db, {
    actorUserId: actor.user.id,
    action: "template.updated",
    resourceType: "whatsapp_template",
    resourceId: row.id,
    metadata: { logical_name: parsed.data.logical_name },
  });

  return NextResponse.json({
    template: {
      logical_name: row.logicalName,
      provider_template_name: row.providerTemplateName,
      language: row.language,
      status: row.status,
    },
  });
}
