import { getDb, closeDb } from "@/db/client";
import { getEnv } from "@/config/env";
import { queueDueReminders, runAlertWatchdogTick } from "./queue-reminders";
import { runWeeklyDigests } from "./weekly-digest";
import { runDailyBriefs } from "./daily-brief";
import { logger } from "@/lib/logger";
import { beat } from "@/domain/health";

async function safeTick(name: string, fn: () => Promise<unknown>) {
  try {
    return await fn();
  } catch (err) {
    logger.error("scheduler_tick_part_error", {
      part: name,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Devolve heap ao SO depois de um tick pesado, se o processo subiu com --expose-gc. */
function releaseProcessMemory(reason: string) {
  const gc = (globalThis as { gc?: () => void }).gc;
  const before = Math.round(process.memoryUsage().rss / (1024 * 1024));
  if (typeof gc === "function") gc();
  const after = Math.round(process.memoryUsage().rss / (1024 * 1024));
  if (before - after >= 32) {
    logger.info("scheduler_memory_released", { reason, beforeMb: before, afterMb: after });
  }
}

async function loop() {
  const env = getEnv();
  logger.info("scheduler_started");
  let stopping = false;
  let digestTicks = 0;
  let watchdogTicks = 0;
  let integrityTicks = 0;
  const stop = async () => {
    stopping = true;
    await closeDb();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopping) {
    const db = getDb();
    await safeTick("beat", () => beat(db, "scheduler"));
    await safeTick("queue_reminders", () => queueDueReminders(db));

    // Watchdog entrega a cada ~6 ticks (~30s se poll=5s)
    watchdogTicks += 1;
    if (watchdogTicks >= 6) {
      watchdogTicks = 0;
      await safeTick("alert_watchdog", () => runAlertWatchdogTick(db));
    }

    // Integridade de CRIAÇÃO a cada ~12 ticks (~60s): inbound sem reminder
    integrityTicks += 1;
    if (integrityTicks >= 12) {
      integrityTicks = 0;
      const { runReminderIntegritySweep } = await import(
        "@/domain/reminder-integrity"
      );
      await safeTick("reminder_integrity", () =>
        runReminderIntegritySweep(db)
      );
      const { runReliabilityAlertTick } = await import(
        "@/domain/reliability-alerts"
      );
      await safeTick("reliability_alerts", () =>
        runReliabilityAlertTick(db)
      );
      releaseProcessMemory("before_infra");
      const { runInfraAlertTick } = await import("@/domain/dev-ops-metrics");
      await safeTick("infra_alerts", () => runInfraAlertTick(db));
    }

    digestTicks += 1;
    if (digestTicks >= 12) {
      digestTicks = 0;
      await safeTick("daily_brief", () => runDailyBriefs(db));
      await safeTick("weekly_digest", () => runWeeklyDigests(db));
      const { runFinanceAlerts } = await import("@/scheduler/finance-alerts");
      await safeTick("finance_alerts", () => runFinanceAlerts(db));
      const { runWeatherAlerts } = await import("@/scheduler/weather-alerts");
      await safeTick("weather_alerts", () => runWeatherAlerts(db));
      const { runHoroscopeAlerts } = await import("@/scheduler/horoscope-alerts");
      await safeTick("horoscope_alerts", () => runHoroscopeAlerts(db));
      const { runEveningWraps } = await import("@/scheduler/evening-wrap");
      await safeTick("evening_wrap", () => runEveningWraps(db));
      const { runOutboundGuardTick } = await import("@/domain/outbound-guard");
      await safeTick("outbound_guard", () => runOutboundGuardTick(db));
      const { runGoogleEventNudges } = await import(
        "@/scheduler/google-event-nudges"
      );
      await safeTick("google_event_nudges", () => runGoogleEventNudges(db));
      releaseProcessMemory("after_digest");
    }

    await new Promise((r) => setTimeout(r, env.SCHEDULER_POLL_MS));
  }
}

loop().catch(async (err) => {
  logger.error("scheduler_fatal", {
    error: err instanceof Error ? err.message : String(err),
  });
  await closeDb();
  process.exit(1);
});
