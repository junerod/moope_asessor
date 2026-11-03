import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  requirePlatformAdminFromAuthHeader,
  writeAdminAudit,
} from "@/domain/platform-admin";
import { agentJobs } from "@/db/schema";
import { enqueueAgentJob } from "@/domain/jobs";

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

  const status = req.nextUrl.searchParams.get("status");
  let rows;
  if (status === "dead") {
    rows = await db.query.agentJobs.findMany({
      where: isNotNull(agentJobs.deadAt),
      orderBy: [desc(agentJobs.createdAt)],
      limit: 100,
    });
  } else if (status) {
    rows = await db.query.agentJobs.findMany({
      where: eq(agentJobs.status, status as "pending" | "processing" | "completed" | "failed" | "retry"),
      orderBy: [desc(agentJobs.createdAt)],
      limit: 100,
    });
  } else {
    rows = await db.query.agentJobs.findMany({
      orderBy: [desc(agentJobs.createdAt)],
      limit: 100,
    });
  }

  return NextResponse.json({
    jobs: rows.map((j) => ({
      id: j.id,
      job_type: j.jobType,
      status: j.deadAt ? "dead" : j.status,
      attempts: j.attempts,
      max_attempts: j.maxAttempts,
      last_error: j.lastError,
      dead_at: j.deadAt,
      created_at: j.createdAt,
      workspace_id: j.workspaceId,
    })),
  });
}

export async function POST(req: NextRequest) {
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

  const body = await req.json().catch(() => ({}));
  const jobId = String(body.job_id || "");
  if (!jobId) return NextResponse.json({ error: "job_id_required" }, { status: 400 });

  const job = await db.query.agentJobs.findFirst({
    where: eq(agentJobs.id, jobId),
  });
  if (!job) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const { job: newJob } = await enqueueAgentJob(db, {
    jobType: job.jobType,
    payload: { ...(job.payload as object), reprocessed_from: job.id },
    workspaceId: job.workspaceId,
    conversationId: job.conversationId,
    messageId: job.messageId,
    webhookEventId: job.webhookEventId,
    idempotencyKey: `reprocess:${job.id}:${Date.now()}`,
    correlationId: job.correlationId,
    maxAttempts: job.maxAttempts,
  });

  await writeAdminAudit(db, {
    actorUserId: actor.user.id,
    action: "job.reprocessed",
    resourceType: "agent_job",
    resourceId: job.id,
    metadata: { new_job_id: newJob.id },
  });

  return NextResponse.json({ ok: true, new_job_id: newJob.id });
}
