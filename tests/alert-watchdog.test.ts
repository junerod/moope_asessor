import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, truncateAll } from "./helpers/db";
import { registerUser } from "@/lib/auth";
import { alertOutbox, reminders } from "@/db/schema";
import {
  reminderOccurrenceKey,
  runAlertWatchdog,
} from "@/domain/alert-delivery";
import type { Db } from "@/db/client";
import type postgres from "postgres";

describe("Watchdog de alertas", () => {
  let db: Db;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await truncateAll(sql);
  });

  async function fixture() {
    const registered = await registerUser(db, {
      email: "watchdog@example.com",
      name: "Watch Dog",
      password: "senha-segura-123",
    });
    return { userId: registered.user.id, workspaceId: registered.workspace.id };
  }

  it("fecha a outbox de lembrete cancelado uma vez e não reabre", async () => {
    const { userId, workspaceId } = await fixture();
    const fireAt = new Date(Date.now() - 13 * 24 * 60 * 60 * 1000);
    const [reminder] = await db
      .insert(reminders)
      .values({
        workspaceId,
        userId,
        title: "já cancelei",
        fireAt,
        status: "cancelled",
      })
      .returning();
    await db.insert(alertOutbox).values({
      workspaceId,
      userId,
      sourceType: "reminder",
      sourceId: reminder.id,
      occurrenceKey: reminderOccurrenceKey(reminder.id, fireAt),
      fireAt,
      title: reminder.title,
      status: "pending",
      nextAttemptAt: fireAt,
    });

    const first = await runAlertWatchdog(db);
    const second = await runAlertWatchdog(db);

    const outbox = await db.query.alertOutbox.findFirst({
      where: eq(alertOutbox.sourceId, reminder.id),
    });
    const after = await db.query.reminders.findFirst({
      where: eq(reminders.id, reminder.id),
    });
    expect(first.closed).toBe(1);
    expect(first.repaired).toBe(0);
    expect(second.closed).toBe(0);
    expect(second.repaired).toBe(0);
    expect(outbox?.status).toBe("cancelled");
    expect(after?.status).toBe("cancelled");
  });

  it("não mexe em lembrete devido que já tem outbox pending", async () => {
    const { userId, workspaceId } = await fixture();
    const fireAt = new Date(Date.now() - 2 * 60 * 1000);
    const [reminder] = await db
      .insert(reminders)
      .values({
        workspaceId,
        userId,
        title: "ainda vai sair pelo claim",
        fireAt,
        status: "scheduled",
        nextAttemptAt: new Date(),
      })
      .returning();
    await db.insert(alertOutbox).values({
      workspaceId,
      userId,
      sourceType: "reminder",
      sourceId: reminder.id,
      occurrenceKey: reminderOccurrenceKey(reminder.id, fireAt),
      fireAt,
      title: reminder.title,
      status: "pending",
      nextAttemptAt: new Date(),
    });

    const result = await runAlertWatchdog(db);
    const outbox = await db.query.alertOutbox.findFirst({
      where: eq(alertOutbox.sourceId, reminder.id),
    });
    const after = await db.query.reminders.findFirst({
      where: eq(reminders.id, reminder.id),
    });

    expect(result.repaired).toBe(0);
    expect(result.closed).toBe(0);
    expect(outbox?.status).toBe("pending");
    expect(after?.status).toBe("scheduled");
  });

  it("cria a outbox que falta e não repete no tick seguinte", async () => {
    const { userId, workspaceId } = await fixture();
    const fireAt = new Date(Date.now() - 2 * 60 * 1000);
    const [reminder] = await db
      .insert(reminders)
      .values({
        workspaceId,
        userId,
        title: "sem outbox",
        fireAt,
        status: "scheduled",
      })
      .returning();

    const first = await runAlertWatchdog(db);
    const second = await runAlertWatchdog(db);
    const rows = await db.query.alertOutbox.findMany({
      where: and(
        eq(alertOutbox.sourceId, reminder.id),
        eq(alertOutbox.status, "pending")
      ),
    });

    expect(first.repaired).toBe(1);
    expect(second.repaired).toBe(0);
    expect(rows).toHaveLength(1);
  });

  it("devolve processing com lock velho e deixa lock fresco em paz", async () => {
    const { userId, workspaceId } = await fixture();
    const staleFire = new Date(Date.now() - 10 * 60 * 1000);
    const freshFire = new Date(Date.now() - 2 * 60 * 1000);
    const [stale] = await db
      .insert(reminders)
      .values({
        workspaceId,
        userId,
        title: "lock velho",
        fireAt: staleFire,
        status: "queued",
        lockedAt: new Date(Date.now() - 10 * 60 * 1000),
        lockedBy: "worker:dead",
      })
      .returning();
    const [fresh] = await db
      .insert(reminders)
      .values({
        workspaceId,
        userId,
        title: "lock fresco",
        fireAt: freshFire,
        status: "queued",
        lockedAt: new Date(),
        lockedBy: "worker:alive",
      })
      .returning();
    await db.insert(alertOutbox).values([
      {
        workspaceId,
        userId,
        sourceType: "reminder",
        sourceId: stale.id,
        occurrenceKey: reminderOccurrenceKey(stale.id, staleFire),
        fireAt: staleFire,
        title: stale.title,
        status: "processing",
        lockedAt: new Date(Date.now() - 10 * 60 * 1000),
        nextAttemptAt: staleFire,
      },
      {
        workspaceId,
        userId,
        sourceType: "reminder",
        sourceId: fresh.id,
        occurrenceKey: reminderOccurrenceKey(fresh.id, freshFire),
        fireAt: freshFire,
        title: fresh.title,
        status: "processing",
        lockedAt: new Date(),
        nextAttemptAt: freshFire,
      },
    ]);

    const result = await runAlertWatchdog(db);
    const staleOut = await db.query.alertOutbox.findFirst({
      where: eq(alertOutbox.sourceId, stale.id),
    });
    const freshOut = await db.query.alertOutbox.findFirst({
      where: eq(alertOutbox.sourceId, fresh.id),
    });
    const staleRem = await db.query.reminders.findFirst({
      where: eq(reminders.id, stale.id),
    });
    const freshRem = await db.query.reminders.findFirst({
      where: eq(reminders.id, fresh.id),
    });

    expect(result.repaired).toBe(1);
    expect(staleOut?.status).toBe("pending");
    expect(staleRem?.status).toBe("scheduled");
    expect(freshOut?.status).toBe("processing");
    expect(freshRem?.status).toBe("queued");
  });
});
