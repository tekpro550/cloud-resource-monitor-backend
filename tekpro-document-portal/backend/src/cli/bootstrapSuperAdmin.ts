/**
 * One-time provisioning of the first Super Admin.
 *
 *   npm run bootstrap:superadmin -- --email admin@tekpro.example --name "Platform Admin"
 *
 * The password is read from an interactive prompt (input hidden), or from the
 * BOOTSTRAP_SUPERADMIN_PASSWORD environment variable for non-interactive use.
 * The command refuses to run if any Super Admin already exists; additional
 * Super Admins are created from the administration UI. It never runs on
 * application startup.
 */
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { PrismaClient } from "@prisma/client";
import { loadConfigOrExit } from "../bootstrap.js";
import { AuditAction } from "../modules/audit/audit.service.js";
import { hashPassword, validatePasswordStrength } from "../modules/auth/password.js";

async function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new Error("No TTY available; set BOOTSTRAP_SUPERADMIN_PASSWORD instead");
  process.stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(value);
        }
        if (c === "\u0003") {
          stdin.setRawMode(false);
          return reject(new Error("Cancelled"));
        }
        if (c === "\u007f") value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on("data", onData);
  });
}

async function main() {
  const { values } = parseArgs({ options: { email: { type: "string" }, name: { type: "string" } } });
  // Missing values are asked for interactively (e.g. `az containerapp exec` into the container).
  const ask = async (question: string) => {
    if (!process.stdin.isTTY) return undefined;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  };
  const email = (values.email ?? (await ask("Email: ")))?.trim().toLowerCase();
  const fullName = (values.name ?? (await ask("Full name: ")))?.trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !fullName) {
    throw new Error('Usage: bootstrap:superadmin -- --email <email> --name "<full name>"');
  }
  const config = loadConfigOrExit();
  const prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
  try {
    if ((await prisma.user.count({ where: { role: "SUPER_ADMIN" } })) > 0) {
      throw new Error("A Super Admin already exists. Bootstrap is only allowed once; manage administrators in the portal.");
    }
    let password = process.env.BOOTSTRAP_SUPERADMIN_PASSWORD;
    if (!password) {
      password = await promptHidden("Password: ");
      const confirm = await promptHidden("Confirm password: ");
      if (password !== confirm) throw new Error("Passwords do not match");
    }
    validatePasswordStrength(password, config.passwordMinLength, email);
    const passwordHash = await hashPassword(password);

    // Serialisable transaction + advisory lock so two concurrent runs cannot both succeed.
    const user = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(727274001)`;
        if ((await tx.user.count({ where: { role: "SUPER_ADMIN" } })) > 0) throw new Error("A Super Admin already exists");
        if (await tx.user.findUnique({ where: { email } })) throw new Error("A user with this email already exists");
        const u = await tx.user.create({
          data: { email, fullName, role: "SUPER_ADMIN", passwordHash, passwordChangedAt: new Date() },
        });
        await tx.auditLog.create({
          data: {
            action: AuditAction.USER_CREATED,
            resourceType: "User",
            resourceId: u.id,
            outcome: "SUCCESS",
            metadata: { email, role: "SUPER_ADMIN", via: "bootstrap-cli" },
          },
        });
        return u;
      },
      { isolationLevel: "Serializable" },
    );
    process.stdout.write(`Super Admin created: ${user.email} (${user.id})\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: Error) => {
  process.stderr.write(`Bootstrap failed: ${err.message}\n`);
  process.exit(1);
});
