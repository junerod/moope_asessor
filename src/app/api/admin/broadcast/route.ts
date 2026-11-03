import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { requirePlatformAdminFromAuthHeader } from "@/domain/platform-admin";
import {
  BROADCAST_AUDIENCES,
  countBroadcastAudiences,
  listBroadcastRecipients,
  sendBroadcast,
  type BroadcastAudience,
} from "@/domain/admin-broadcast";
import { createZernioClient } from "@/channels/zernio";
import { resolveZernioRuntimeConfig } from "@/domain/providers";

function requireSuperAdmin(admin: { role: string }) {
  if (admin.role !== "super_admin") {
    const err = new Error("super_admin_required");
    throw err;
  }
}

export async function GET(req: NextRequest) {
  const db = getDb();
  try {
    const { admin } = await requirePlatformAdminFromAuthHeader(
      db,
      req.headers.get("authorization")
    );
    requireSuperAdmin(admin);

    const audience = (req.nextUrl.searchParams.get("audience") ||
      "") as BroadcastAudience;
    const counts = await countBroadcastAudiences(db);

    if (audience && BROADCAST_AUDIENCES.some((a) => a.id === audience)) {
      const recipients = await listBroadcastRecipients(db, audience);
      return NextResponse.json({
        audiences: BROADCAST_AUDIENCES,
        counts,
        audience,
        count: recipients.length,
        preview: recipients.slice(0, 40).map((r) => ({
          phone: r.phoneE164,
          name: r.displayName,
          segment: r.segmentHint,
        })),
      });
    }

    return NextResponse.json({
      audiences: BROADCAST_AUDIENCES,
      counts,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    const status =
      msg === "super_admin_required"
        ? 403
        : msg === "forbidden"
          ? 403
          : 401;
    return NextResponse.json({ error: msg }, { status });
  }
}

export async function POST(req: NextRequest) {
  const db = getDb();
  try {
    const { user, admin } = await requirePlatformAdminFromAuthHeader(
      db,
      req.headers.get("authorization")
    );
    requireSuperAdmin(admin);

    const contentType = req.headers.get("content-type") || "";
    let audience = "";
    let message = "";
    let dryRun = false;
    let testDev = false;
    let confirm = "";
    let imageUrl: string | null = null;

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      audience = String(form.get("audience") || "");
      message = String(form.get("message") || "").trim();
      dryRun = String(form.get("dry_run") || "") === "true";
      testDev = String(form.get("test_dev") || "") === "true";
      confirm = String(form.get("confirm") || "");
      imageUrl = String(form.get("image_url") || "").trim() || null;
      const file = form.get("image");
      if (file && typeof file !== "string" && "arrayBuffer" in file) {
        const buf = Buffer.from(await file.arrayBuffer());
        const name = (file as File).name || "post.jpg";
        const mime = (file as File).type || "image/jpeg";
        const cfg = await resolveZernioRuntimeConfig(db);
        const client = createZernioClient({
          mock: cfg.mock,
          apiKey: cfg.apiKey,
          apiUrl: cfg.apiUrl,
          accountId: cfg.accountId,
        });
        const up = await client.uploadMedia({
          buffer: buf,
          filename: name,
          mimeType: mime,
        });
        if (!up.ok || !up.url) {
          return NextResponse.json(
            { error: up.error || "upload_failed" },
            { status: 400 }
          );
        }
        imageUrl = up.url;
      }
    } else {
      const body = (await req.json()) as {
        audience?: string;
        message?: string;
        dry_run?: boolean;
        test_dev?: boolean;
        confirm?: string;
        image_url?: string;
      };
      audience = String(body.audience || "");
      message = String(body.message || "").trim();
      dryRun = Boolean(body.dry_run);
      testDev = Boolean(body.test_dev);
      confirm = String(body.confirm || "");
      imageUrl = body.image_url ? String(body.image_url).trim() : null;
    }

    const aud = audience as BroadcastAudience;
    if (!BROADCAST_AUDIENCES.some((a) => a.id === aud)) {
      return NextResponse.json({ error: "invalid_audience" }, { status: 400 });
    }
    if (!imageUrl && message.length < 3) {
      return NextResponse.json({ error: "message_too_short" }, { status: 400 });
    }
    if (!dryRun && !testDev && confirm !== "ENVIAR") {
      return NextResponse.json(
        { error: "confirm_required", hint: 'Envie confirm: "ENVIAR"' },
        { status: 400 }
      );
    }

    const result = await sendBroadcast(db, {
      audience: aud,
      message: message || " ",
      actorUserId: user.id,
      dryRun,
      testDevOnly: testDev,
      imageUrl,
    });

    return NextResponse.json({
      ok: true,
      dry_run: dryRun,
      test_dev: testDev,
      image_url: imageUrl,
      result,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    const status =
      msg === "super_admin_required"
        ? 403
        : msg === "forbidden"
          ? 403
          : msg === "unauthorized"
            ? 401
            : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}
