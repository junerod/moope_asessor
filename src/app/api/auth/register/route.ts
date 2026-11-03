import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { registerUser } from "@/lib/auth";

const bodySchema = z.object({
  email: z.string().email(),
  name: z.string().min(2).max(200),
  password: z.string().min(8).max(200),
  timezone: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  try {
    const result = await registerUser(getDb(), parsed.data);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "error";
    if (message === "email_already_registered") {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    return NextResponse.json({ error: "register_failed" }, { status: 500 });
  }
}
