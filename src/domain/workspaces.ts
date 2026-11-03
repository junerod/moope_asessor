import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { workspaceMembers, workspaces } from "@/db/schema";
import { getEnv } from "@/config/env";

export async function createPersonalWorkspace(
  db: Db,
  input: { userId: string; name: string; timezone?: string }
) {
  const timezone = input.timezone || getEnv().DEFAULT_TIMEZONE;

  const [workspace] = await db
    .insert(workspaces)
    .values({
      type: "personal",
      name: input.name,
      timezone,
      ownerUserId: input.userId,
    })
    .returning();

  await db.insert(workspaceMembers).values({
    workspaceId: workspace.id,
    userId: input.userId,
    role: "owner",
  });

  return {
    id: workspace.id,
    type: workspace.type,
    name: workspace.name,
    timezone: workspace.timezone,
    owner_user_id: workspace.ownerUserId,
  };
}

export async function assertWorkspaceMembership(
  db: Db,
  input: { userId: string; workspaceId: string }
) {
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, input.workspaceId),
      eq(workspaceMembers.userId, input.userId),
      isNull(workspaceMembers.deletedAt)
    ),
  });
  if (!membership) {
    throw new Error("workspace_access_denied");
  }
  return membership;
}

export async function getPersonalWorkspaceForUser(db: Db, userId: string) {
  const memberships = await db.query.workspaceMembers.findMany({
    where: and(
      eq(workspaceMembers.userId, userId),
      isNull(workspaceMembers.deletedAt)
    ),
  });

  for (const m of memberships) {
    const ws = await db.query.workspaces.findFirst({
      where: and(
        eq(workspaces.id, m.workspaceId),
        eq(workspaces.type, "personal"),
        isNull(workspaces.deletedAt)
      ),
    });
    if (ws) return ws;
  }
  return null;
}
