/**
 * Maintenance jobs, intended for cron/systemd timers:
 *
 *   npm run jobs -- maintenance          # expire uploads, purge deleted documents, prune auth records
 *   npm run jobs -- reconcile            # report storage/database inconsistencies (read-only)
 *   npm run jobs -- reconcile --fix      # also repair them (removes orphans, flags missing objects)
 */
import { parseArgs } from "node:util";
import { createServices } from "../services.js";
import { buildContext } from "../bootstrap.js";
import { withJobLock } from "../jobs/jobLock.js";
import { reconcileStorage } from "../jobs/reconcile.js";
import { runMaintenance } from "../jobs/scheduler.js";

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { fix: { type: "boolean", default: false } } });
  const job = positionals[0];
  const s = createServices(buildContext());
  try {
    let result: unknown;
    if (job === "maintenance") result = await runMaintenance(s);
    else if (job === "reconcile") result = await withJobLock(s.prisma, "reconcile", 3600, () => reconcileStorage(s, { fix: values.fix }));
    else throw new Error("Usage: jobs <maintenance|reconcile> [--fix]");
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await s.prisma.$disconnect();
  }
}

main().catch((err: Error) => {
  process.stderr.write(`Job failed: ${err.message}\n`);
  process.exit(1);
});
