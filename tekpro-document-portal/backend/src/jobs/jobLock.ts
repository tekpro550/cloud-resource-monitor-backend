import type { PrismaClient } from "@prisma/client";

/**
 * Lease-based lock stored in SystemSetting so that only one application
 * instance (or CLI invocation) runs a maintenance job at a time.
 */
export async function withJobLock<T>(prisma: PrismaClient, name: string, leaseSeconds: number, fn: () => Promise<T>): Promise<T | "LOCKED"> {
  const key = `job_lock:${name}`;
  const until = new Date(Date.now() + leaseSeconds * 1000).toISOString();
  const acquired = await prisma.$queryRaw<{ key: string }[]>`
    INSERT INTO "SystemSetting" (key, value, "updatedAt")
    VALUES (${key}, jsonb_build_object('until', ${until}::text), now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()
    WHERE ("SystemSetting".value->>'until')::timestamptz < now()
    RETURNING key`;
  if (acquired.length === 0) return "LOCKED";
  try {
    return await fn();
  } finally {
    await prisma.$executeRaw`
      UPDATE "SystemSetting" SET value = jsonb_build_object('until', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')), "updatedAt" = now()
      WHERE key = ${key}`;
  }
}
