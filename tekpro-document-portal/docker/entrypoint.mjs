/**
 * Container entrypoint (the runtime image has no shell).
 *
 *   serve                                    apply migrations (if RUN_MIGRATIONS=true), then start the server
 *   migrate                                  apply pending database migrations
 *   bootstrap-superadmin --email E --name N  create the first Super Admin (once)
 *   jobs maintenance|reconcile [--fix]       maintenance jobs
 *   storage-check [--skip-write]             diagnose the platform storage bucket
 */
import { spawnSync } from "node:child_process";

const APP = "/app";
const [command = "serve", ...args] = process.argv.slice(2);

function migrate() {
  const res = spawnSync(
    process.execPath,
    [`${APP}/node_modules/prisma/build/index.js`, "migrate", "deploy", "--schema", `${APP}/backend/prisma/schema.prisma`],
    { stdio: "inherit", cwd: APP },
  );
  if (res.status !== 0) {
    console.error("Database migration failed; not starting.");
    process.exit(res.status ?? 1);
  }
}

/** Runs a compiled CLI in this process with the given arguments. */
async function run(script) {
  process.argv = [process.argv[0], script, ...args];
  await import(script);
}

switch (command) {
  case "serve":
    if ((process.env.RUN_MIGRATIONS ?? "true") === "true") {
      console.log("Applying database migrations...");
      migrate();
    }
    // Same process, so the server receives SIGTERM directly for graceful shutdown.
    await import(`${APP}/backend/dist/server.js`);
    break;
  case "migrate":
    migrate();
    break;
  case "bootstrap-superadmin":
    await run(`${APP}/backend/dist/cli/bootstrapSuperAdmin.js`);
    break;
  case "jobs":
    await run(`${APP}/backend/dist/cli/runJobs.js`);
    break;
  case "storage-check":
    await run(`${APP}/backend/dist/cli/storageCheck.js`);
    break;
  default:
    console.error(`Unknown command: ${command}\nUsage: serve | migrate | bootstrap-superadmin | jobs | storage-check`);
    process.exit(64);
}
