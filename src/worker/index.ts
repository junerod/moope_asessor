import { getDb, closeDb } from "@/db/client";
import { getEnv } from "@/config/env";
import { claimJobs } from "@/domain/jobs";
import { processAgentJob } from "./process-job";
import { logger } from "@/lib/logger";
import { randomToken } from "@/lib/crypto";
import { beat } from "@/domain/health";

async function loop() {
  const env = getEnv();
  const db = getDb();
  const workerId = `worker_${randomToken(6)}`;
  logger.info("worker_started", { worker_id: workerId });

  let stopping = false;
  const stop = async () => {
    stopping = true;
    logger.info("worker_stopping");
    await closeDb();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopping) {
    try {
      await beat(db, "worker", { worker_id: workerId });
      const jobs = await claimJobs(db, {
        workerId,
        limit: env.WORKER_BATCH_SIZE,
      });
      if (!jobs.length) {
        await new Promise((r) => setTimeout(r, env.WORKER_POLL_MS));
        continue;
      }
      for (const job of jobs) {
        await processAgentJob(db, job);
      }
    } catch (err) {
      logger.error("worker_loop_error", {
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise((r) => setTimeout(r, env.WORKER_POLL_MS));
    }
  }
}

loop().catch(async (err) => {
  logger.error("worker_fatal", {
    error: err instanceof Error ? err.message : String(err),
  });
  await closeDb();
  process.exit(1);
});
