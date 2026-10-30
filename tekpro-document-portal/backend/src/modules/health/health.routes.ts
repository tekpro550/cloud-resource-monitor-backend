import { Router } from "express";
import type { Services } from "../../services.js";

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms).unref())]);

/**
 * Liveness: the process is running.
 * Readiness: the database and object storage are reachable. Component status is
 * reported without any configuration details or error text.
 */
export function healthRoutes(s: Services): Router {
  const r = Router();

  r.get("/live", (_req, res) => {
    res.json({ status: "ok" });
  });

  r.get("/ready", async (_req, res) => {
    const check = async (fn: () => Promise<unknown>) => {
      try {
        await withTimeout(fn(), 5000);
        return "ok" as const;
      } catch {
        return "unavailable" as const;
      }
    };
    const [database, storage] = await Promise.all([
      check(() => s.prisma.$queryRaw`SELECT 1`),
      check(() => s.storage.checkConnectivity()),
    ]);
    const ok = database === "ok" && storage === "ok";
    if (!ok) s.logger.warn({ database, storage }, "Readiness check failed");
    res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "degraded", checks: { database, storage } });
  });

  return r;
}
