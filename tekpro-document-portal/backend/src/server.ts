import { createApp } from "./app.js";
import { buildContext } from "./bootstrap.js";
import { startScheduler } from "./jobs/scheduler.js";

const ctx = buildContext();
const { app, services } = createApp(ctx);

const server = app.listen(ctx.config.port, ctx.config.host, () => {
  ctx.logger.info(
    { port: ctx.config.port, env: ctx.config.env, storage: ctx.storage.name },
    "Tekpro Document Portal API listening",
  );
});
// Bounded request handling time; bodies are small JSON documents.
server.requestTimeout = 60_000;
server.headersTimeout = 30_000;

const stopScheduler = ctx.config.jobs.enabled ? startScheduler(services) : () => undefined;

const shutdown = (signal: string) => {
  ctx.logger.info({ signal }, "Shutting down");
  stopScheduler();
  server.close(async () => {
    await ctx.prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 15_000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
