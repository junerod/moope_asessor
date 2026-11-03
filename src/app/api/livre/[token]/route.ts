import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { bookPublicSlot } from "@/domain/public-slots";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ token: string }> }
) {
  const { token } = await ctx.params;
  const form = await req.formData();
  const iso = String(form.get("iso") || "");
  const guestName = String(form.get("guestName") || "");
  const result = await bookPublicSlot(getDb(), { token, iso, guestName });
  return new NextResponse(result.message, {
    status: result.ok ? 200 : 400,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
