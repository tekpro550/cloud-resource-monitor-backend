import type { Services } from "../services.js";
import { cleanupExpiredUploads, pruneAuthRecords } from "./cleanupUploads.js";
import { withJobLock } from "./jobLock.js";
import { purgeDeletedDocuments } from "./purgeDeleted.js";

/** Routine maintenance: expire abandoned uploads, purge deleted documents, prune auth records. */
export async function runMaintenance(s: Services) {
  return withJobLock(s.prisma, "maintenance", 15 * 60, async () => {
    const uploads = await cleanupExpiredUploads(s);
    const purge = await purgeDeletedDocuments(s);
    const auth = await pruneAuthRecords(s);
    return { uploads, purge, auth };
  });
}

/** Optional in-process scheduler (JOBS_ENABLED=true). Safe with several instances thanks to the job lock. */
export function startScheduler(s: Services): () => void {
  const tick = async () => {
    try {
      const result = await runMaintenance(s);
      s.logger.info({ result }, "Maintenance run finished");
    } catch (err) {
      s.logger.error({ err }, "Maintenance run failed");
    }
  };
  const timer = setInterval(tick, s.config.jobs.intervalSeconds * 1000);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
