import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import { verifyAccessToken } from "@/lib/auth";
import { getPersonalWorkspaceForUser } from "@/domain/workspaces";

export async function GET(req: NextRequest) {
  const header = req.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await verifyAccessToken(token);
  if (!payload) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const user = await db.query.users.findFirst({
    where: eq(users.id, payload.sub),
  });
  if (!user || user.deletedAt) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const workspace = await getPersonalWorkspaceForUser(db, user.id);

  return NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      status: user.status,
      global_user_id: user.globalUserId,
      timezone: user.timezone,
    },
    workspace: workspace
      ? {
          id: workspace.id,
          type: workspace.type,
          name: workspace.name,
          timezone: workspace.timezone,
        }
      : null,
  });
}
