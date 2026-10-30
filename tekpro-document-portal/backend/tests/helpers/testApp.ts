import { PrismaClient, type Role } from "@prisma/client";
import type { Express } from "express";
import { pino } from "pino";
import request from "supertest";
import TestAgent from "supertest/lib/agent.js";
import { createApp } from "../../src/app.js";
import { loadConfig, type AppConfig } from "../../src/config/env.js";
import { RecordingMailer } from "../../src/modules/mail/mailer.js";
import { hashPassword } from "../../src/modules/auth/password.js";
import type { Services } from "../../src/services.js";
import { MemoryStorageAdapter } from "../../src/storage/memoryStorage.js";
import { objectKeyFor } from "../../src/storage/storage.js";

export const PASSWORD = "Correct-Horse-Battery-9";

let sharedPrisma: PrismaClient | undefined;
export function prisma(): PrismaClient {
  sharedPrisma ??= new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } });
  return sharedPrisma;
}

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    SESSION_SECRET: "test-session-secret-0123456789abcdef0123456789",
    APP_BASE_URL: "http://portal.test",
    STORAGE_DRIVER: "memory",
    LOG_LEVEL: "silent",
    RATE_LIMIT_MAX_REQUESTS: "100000",
    RATE_LIMIT_LOGIN_MAX: "100000",
    RATE_LIMIT_PASSWORD_RESET_MAX: "100000",
    UPLOAD_MULTIPART_THRESHOLD_BYTES: String(6 * 1024 * 1024),
    UPLOAD_PART_SIZE_BYTES: String(5 * 1024 * 1024),
    UPLOAD_MAX_FILE_SIZE_BYTES: String(1024 * 1024 * 1024),
    ...overrides,
  });
}

export interface TestHarness {
  app: Express;
  services: Services;
  storage: MemoryStorageAdapter;
  mailer: RecordingMailer;
}

export function createTestApp(overrides: Record<string, string> = {}): TestHarness {
  const config = testConfig(overrides);
  const storage = new MemoryStorageAdapter();
  const mailer = new RecordingMailer();
  const { app, services } = createApp({ config, prisma: prisma(), storage, mailer, logger: pino({ level: "silent" }) });
  return { app, services, storage, mailer };
}

/** Empties every table. The audit-log immutability trigger is bypassed only here. */
export async function resetDb(): Promise<void> {
  if (!/test/i.test(new URL(process.env.TEST_DATABASE_URL!).pathname)) throw new Error("resetDb only runs against a test database");
  const db = prisma();
  await db.$executeRawUnsafe(`ALTER TABLE "AuditLog" DISABLE TRIGGER USER`);
  await db.$executeRawUnsafe(
    `TRUNCATE "AuditLog", "UploadSession", "Document", "CustomerUserFolderPermission", "Folder",
      "TekproUserCustomerAssignment", "Session", "PasswordToken", "SystemSetting", "User", "Customer" CASCADE`,
  );
  await db.$executeRawUnsafe(`ALTER TABLE "AuditLog" ENABLE TRIGGER USER`);
}

let cachedHash: string | undefined;
export async function createUser(opts: { email: string; role: Role; customerId?: string | null; fullName?: string; status?: "ACTIVE" | "INACTIVE" }) {
  cachedHash ??= await hashPassword(PASSWORD);
  return prisma().user.create({
    data: {
      email: opts.email,
      fullName: opts.fullName ?? opts.email.split("@")[0]!,
      role: opts.role,
      customerId: opts.customerId ?? null,
      passwordHash: cachedHash,
      status: opts.status ?? "ACTIVE",
    },
  });
}

export async function createFolder(customerId: string, name: string, parentFolderId: string | null = null, extra: { hiddenFromCustomer?: boolean } = {}) {
  return prisma().folder.create({ data: { customerId, name, parentFolderId, ...extra } });
}

/** Creates an AVAILABLE document and its stored object. */
export async function createDocument(
  storage: MemoryStorageAdapter,
  customerId: string,
  folderId: string,
  displayName: string,
  content = "%PDF-1.7 test document",
  extra: { createdAt?: Date } = {},
) {
  const id = crypto.randomUUID();
  const ext = displayName.split(".").pop()!.toLowerCase();
  const key = objectKeyFor(customerId, id);
  storage.putObject(key, content);
  return prisma().document.create({
    data: {
      id,
      customerId,
      folderId,
      displayName,
      extension: ext,
      objectKey: key,
      mimeType: "application/pdf",
      sizeBytes: BigInt(new TextEncoder().encode(content).length),
      status: "AVAILABLE",
      availableAt: new Date(),
      ...(extra.createdAt ? { createdAt: extra.createdAt } : {}),
    },
  });
}

export interface LoggedIn {
  agent: InstanceType<typeof TestAgent>;
  csrf: string;
  userId: string;
}

export async function login(app: Express, email: string, password = PASSWORD): Promise<LoggedIn> {
  const agent = request.agent(app);
  const res = await agent.post("/api/v1/auth/login").send({ email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, csrf: res.body.data.csrfToken, userId: res.body.data.user.id };
}

/** Convenience wrappers that attach the CSRF header. */
export const api = (u: LoggedIn) => ({
  get: (url: string) => u.agent.get(url),
  post: (url: string, body?: object) => u.agent.post(url).set("X-CSRF-Token", u.csrf).send(body ?? {}),
  put: (url: string, body?: object) => u.agent.put(url).set("X-CSRF-Token", u.csrf).send(body ?? {}),
  patch: (url: string, body?: object) => u.agent.patch(url).set("X-CSRF-Token", u.csrf).send(body ?? {}),
  delete: (url: string, body?: object) => u.agent.delete(url).set("X-CSRF-Token", u.csrf).send(body ?? {}),
});

/**
 * Standard two-tenant fixture:
 *   Antrix (A): folders Reports/{2024, Confidential}, Contracts, Hidden (hidden from customers)
 *   Beta   (B): folder Beta Docs
 *   Users: super admin, Tekpro user assigned to Antrix only, a second unassigned
 *   Tekpro user, Antrix admin, Antrix customer user with DOWNLOAD on Reports
 *   (but NONE on Confidential), Beta admin.
 */
export async function seedTwoTenants(storage: MemoryStorageAdapter) {
  const db = prisma();
  const antrix = await db.customer.create({ data: { name: "Antrix", customerCode: "ANTRIX" } });
  const beta = await db.customer.create({ data: { name: "Beta Corp", customerCode: "BETA" } });

  const superAdmin = await createUser({ email: "super@tekpro.test", role: "SUPER_ADMIN" });
  const staff = await createUser({ email: "staff@tekpro.test", role: "TEKPRO_USER" });
  const otherStaff = await createUser({ email: "staff2@tekpro.test", role: "TEKPRO_USER" });
  await db.tekproUserCustomerAssignment.create({ data: { userId: staff.id, customerId: antrix.id, assignedByUserId: superAdmin.id } });
  await db.tekproUserCustomerAssignment.create({ data: { userId: otherStaff.id, customerId: beta.id, assignedByUserId: superAdmin.id } });
  const antrixAdmin = await createUser({ email: "admin@antrix.test", role: "CUSTOMER_ADMIN", customerId: antrix.id });
  const antrixUser = await createUser({ email: "user@antrix.test", role: "CUSTOMER_USER", customerId: antrix.id });
  const betaAdmin = await createUser({ email: "admin@beta.test", role: "CUSTOMER_ADMIN", customerId: beta.id });

  const reports = await createFolder(antrix.id, "Reports");
  const reports2024 = await createFolder(antrix.id, "2024", reports.id);
  const confidential = await createFolder(antrix.id, "Confidential", reports.id);
  const contracts = await createFolder(antrix.id, "Contracts");
  const hidden = await createFolder(antrix.id, "Internal", null, { hiddenFromCustomer: true });
  const betaDocs = await createFolder(beta.id, "Beta Docs");

  await db.customerUserFolderPermission.create({
    data: { userId: antrixUser.id, customerId: antrix.id, folderId: reports.id, permission: "DOWNLOAD" },
  });
  await db.customerUserFolderPermission.create({
    data: { userId: antrixUser.id, customerId: antrix.id, folderId: confidential.id, permission: "NONE" },
  });

  const docs = {
    report: await createDocument(storage, antrix.id, reports.id, "Annual Report.pdf"),
    report2024: await createDocument(storage, antrix.id, reports2024.id, "Q1 Summary.pdf"),
    secret: await createDocument(storage, antrix.id, confidential.id, "Secret Plan.pdf"),
    contract: await createDocument(storage, antrix.id, contracts.id, "Master Contract.pdf"),
    internal: await createDocument(storage, antrix.id, hidden.id, "Internal Notes.pdf"),
    beta: await createDocument(storage, beta.id, betaDocs.id, "Beta Secret Pricing.pdf"),
  };

  return {
    customers: { antrix, beta },
    users: { superAdmin, staff, otherStaff, antrixAdmin, antrixUser, betaAdmin },
    folders: { reports, reports2024, confidential, contracts, hidden, betaDocs },
    docs,
  };
}

export type Seed = Awaited<ReturnType<typeof seedTwoTenants>>;
