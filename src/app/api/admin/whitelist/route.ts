import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import {
  requirePlatformAdminFromAuthHeader,
  writeAdminAudit,
} from "@/domain/platform-admin";
import {
  addToBlacklist,
  listBlacklist,
  removeFromBlacklist,
} from "@/domain/access-blacklist";
import {
  addToWhitelist,
  isPaywallEnforced,
  listWhitelist,
  removeFromWhitelist,
  setPaywallEnforced,
} from "@/domain/access-whitelist";
import { getMoopeContact, setMoopeContact } from "@/domain/moope-contact";

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

  const [white, black, paywall, contact] = await Promise.all([
    listWhitelist(db),
    listBlacklist(db),
    isPaywallEnforced(db),
    getMoopeContact(db),
  ]);

  return NextResponse.json({
    paywall_enforced: paywall,
    moope_contact: {
      phone_e164: contact.phoneE164,
      label: contact.label,
    },
    whitelist: white.map((r) => ({
      id: r.id,
      phone_e164: r.phoneE164,
      label: r.label,
      notes: r.notes,
      created_at: r.createdAt,
    })),
    blacklist: black.map((r) => ({
      id: r.id,
      phone_e164: r.phoneE164,
      reason: r.reason,
      notes: r.notes,
      created_at: r.createdAt,
    })),
    // compat
    entries: white.map((r) => ({
      id: r.id,
      phone_e164: r.phoneE164,
      label: r.label,
      notes: r.notes,
      created_at: r.createdAt,
    })),
  });
}

export async function POST(req: NextRequest) {
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

  const schema = z
    .object({
      action: z
        .enum([
          "whitelist_add",
          "blacklist_add",
          "paywall",
          "moope_contact",
        ])
        .optional(),
      phone: z.string().min(8).optional(),
      label: z.string().max(200).optional(),
      notes: z.string().max(2000).optional(),
      reason: z.string().max(500).optional(),
      paywall_enforced: z.boolean().optional(),
      contact_phone: z.string().min(8).optional(),
      contact_label: z.string().max(200).optional(),
    })
    .refine(
      (v) =>
        typeof v.paywall_enforced === "boolean" ||
        Boolean(v.phone) ||
        Boolean(v.contact_phone) ||
        v.action === "moope_contact",
      { message: "action_required" }
    );

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  const data = parsed.data;
  const action =
    data.action ||
    (typeof data.paywall_enforced === "boolean"
      ? "paywall"
      : data.contact_phone
        ? "moope_contact"
        : "whitelist_add");

  if (action === "paywall" && typeof data.paywall_enforced === "boolean") {
    await setPaywallEnforced(db, data.paywall_enforced, actor.user.id);
    await writeAdminAudit(db, {
      actorUserId: actor.user.id,
      action: "billing.paywall_enforced",
      resourceType: "platform_settings",
      metadata: { enabled: data.paywall_enforced },
    });
  }

  if (action === "moope_contact" && data.contact_phone) {
    try {
      await setMoopeContact(db, {
        phone: data.contact_phone,
        label: data.contact_label,
        updatedByUserId: actor.user.id,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "error";
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    await writeAdminAudit(db, {
      actorUserId: actor.user.id,
      action: "assessor.moope_contact",
      resourceType: "platform_settings",
      metadata: { phone: data.contact_phone },
    });
  }

  let whitelistEntry = null;
  if (action === "whitelist_add" && data.phone) {
    try {
      whitelistEntry = await addToWhitelist(db, {
        phone: data.phone,
        label: data.label,
        notes: data.notes,
        createdByUserId: actor.user.id,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "error";
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    await writeAdminAudit(db, {
      actorUserId: actor.user.id,
      action: "whitelist.add",
      resourceType: "client_access_whitelist",
      resourceId: whitelistEntry.id,
      metadata: { phone: whitelistEntry.phoneE164 },
    });
  }

  let blacklistEntry = null;
  if (action === "blacklist_add" && data.phone) {
    try {
      blacklistEntry = await addToBlacklist(db, {
        phone: data.phone,
        reason: data.reason,
        notes: data.notes,
        createdByUserId: actor.user.id,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "error";
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    await writeAdminAudit(db, {
      actorUserId: actor.user.id,
      action: "blacklist.add",
      resourceType: "client_access_blacklist",
      resourceId: blacklistEntry.id,
      metadata: { phone: blacklistEntry.phoneE164 },
    });
  }

  const contact = await getMoopeContact(db);
  return NextResponse.json({
    ok: true,
    paywall_enforced: await isPaywallEnforced(db),
    moope_contact: {
      phone_e164: contact.phoneE164,
      label: contact.label,
    },
    entry: whitelistEntry
      ? {
          id: whitelistEntry.id,
          phone_e164: whitelistEntry.phoneE164,
          label: whitelistEntry.label,
          notes: whitelistEntry.notes,
        }
      : null,
    blacklist_entry: blacklistEntry
      ? {
          id: blacklistEntry.id,
          phone_e164: blacklistEntry.phoneE164,
          reason: blacklistEntry.reason,
        }
      : null,
  });
}

export async function DELETE(req: NextRequest) {
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

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const list = url.searchParams.get("list") || "whitelist";
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  if (list === "blacklist") {
    const row = await removeFromBlacklist(db, id);
    if (!row) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    await writeAdminAudit(db, {
      actorUserId: actor.user.id,
      action: "blacklist.remove",
      resourceType: "client_access_blacklist",
      resourceId: row.id,
    });
    return NextResponse.json({ ok: true });
  }

  const row = await removeFromWhitelist(db, id);
  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  await writeAdminAudit(db, {
    actorUserId: actor.user.id,
    action: "whitelist.remove",
    resourceType: "client_access_whitelist",
    resourceId: row.id,
  });
  return NextResponse.json({ ok: true });
}
