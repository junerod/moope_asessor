import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { agentJobs, type AgentJob } from "@/db/schema";
import { getEnv } from "@/config/env";
import { logger } from "@/lib/logger";

export type EnqueueJobInput = {
  jobType: string;
  payload: Record<string, unknown>;
  workspaceId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  webhookEventId?: string | null;
  idempotencyKey?: string | null;
  correlationId?: string | null;
  availableAt?: Date;
  maxAttempts?: number;
};

export async function enqueueAgentJob(
  db: Db,
  input: EnqueueJobInput
): Promise<{ job: AgentJob; created: boolean }> {
  const maxAttempts = input.maxAttempts ?? getEnv().JOB_MAX_ATTEMPTS;

  if (input.idempotencyKey) {
    const existing = await db.query.agentJobs.findFirst({
      where: eq(agentJobs.idempotencyKey, input.idempotencyKey),
    });
    if (existing) {
      return { job: existing, created: false };
    }
  }

  try {
    const [job] = await db
      .insert(agentJobs)
      .values({
        jobType: input.jobType,
        payload: input.payload,
        workspaceId: input.workspaceId ?? null,
        conversationId: input.conversationId ?? null,
        messageId: input.messageId ?? null,
        webhookEventId: input.webhookEventId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        correlationId: input.correlationId ?? null,
        availableAt: input.availableAt ?? new Date(),
        maxAttempts,
        status: "pending",
      })
      .returning();
    return { job, created: true };
  } catch (err) {
    if (input.idempotencyKey) {
      const existing = await db.query.agentJobs.findFirst({
        where: eq(agentJobs.idempotencyKey, input.idempotencyKey),
      });
      if (existing) return { job: existing, created: false };
    }
    throw err;
  }
}

type ClaimRow = {
  id: string;
  workspace_id: string | null;
  conversation_id: string | null;
  message_id: string | null;
  webhook_event_id: string | null;
  job_type: string;
  status: AgentJob["status"];
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  available_at: string | Date;
  locked_at: string | Date | null;
  locked_by: string | null;
  last_error: string | null;
  idempotency_key: string | null;
  correlation_id: string | null;
  completed_at: string | Date | null;
  dead_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
};

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

function mapClaimRow(row: ClaimRow): AgentJob {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    webhookEventId: row.webhook_event_id,
    jobType: row.job_type,
    status: row.status,
    payload: row.payload ?? {},
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    availableAt: toDate(row.available_at)!,
    lockedAt: toDate(row.locked_at),
    lockedBy: row.locked_by,
    lastError: row.last_error,
    idempotencyKey: row.idempotency_key,
    correlationId: row.correlation_id,
    completedAt: toDate(row.completed_at),
    deadAt: toDate(row.dead_at),
    createdAt: toDate(row.created_at)!,
    updatedAt: toDate(row.updated_at)!,
  };
}

export async function claimJobs(
  db: Db,
  input: { workerId: string; limit: number }
): Promise<AgentJob[]> {
  const result = await db.execute(sql`
    UPDATE agent_jobs
    SET
      status = 'processing',
      locked_at = NOW(),
      locked_by = ${input.workerId},
      attempts = attempts + 1,
      updated_at = NOW()
    WHERE id IN (
      SELECT id
      FROM agent_jobs
      WHERE status IN ('pending', 'retry')
        AND available_at <= NOW()
      ORDER BY available_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${input.limit}
    )
    RETURNING *
  `);

  const rows = (Array.isArray(result) ? result : []) as ClaimRow[];
  return rows.map(mapClaimRow);
}

export async function completeJob(db: Db, jobId: string) {
  await db
    .update(agentJobs)
    .set({
      status: "completed",
      completedAt: new Date(),
      lockedAt: null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(agentJobs.id, jobId));
}

export async function failJob(
  db: Db,
  job: AgentJob,
  error: string
): Promise<"retry" | "failed"> {
  const attempts = job.attempts;
  const maxAttempts = job.maxAttempts;
  if (attempts < maxAttempts) {
    const delaySeconds = Math.min(60 * 2 ** Math.max(attempts - 1, 0), 3600);
    const availableAt = new Date(Date.now() + delaySeconds * 1000);
    await db
      .update(agentJobs)
      .set({
        status: "retry",
        lastError: error.slice(0, 4000),
        availableAt,
        lockedAt: null,
        lockedBy: null,
        updatedAt: new Date(),
      })
      .where(eq(agentJobs.id, job.id));
    logger.warn("agent_job_retry_scheduled", {
      job_id: job.id,
      attempts,
      available_at: availableAt.toISOString(),
    });
    return "retry";
  }

  await db
    .update(agentJobs)
    .set({
      status: "failed",
      lastError: error.slice(0, 4000),
      lockedAt: null,
      lockedBy: null,
      completedAt: new Date(),
      deadAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(agentJobs.id, job.id));
  logger.error("agent_job_failed", { job_id: job.id, attempts });
  return "failed";
}
