import { execSync } from "node:child_process";

/**
 * Applies pending migrations to the dedicated test database once per run
 * (non-destructive). Individual suites empty the tables they use via resetDb().
 * TEST_DATABASE_URL must point at a disposable database - never production.
 */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgresql://portal:portal@localhost:5432/portal_test";
  if (!/test/i.test(new URL(url).pathname)) {
    throw new Error("Refusing to run: TEST_DATABASE_URL database name must contain 'test'");
  }
  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
  });
}
