/**
 * Browser end-to-end smoke test for a running Tekpro Document Portal.
 *
 * Exercises the real stack through the UI: Super Admin sign-in, customer
 * creation, folder creation, direct-to-storage uploads (single and multipart),
 * customer user invitation and folder grant, customer sign-in, permission-limited
 * browsing, pre-signed download and audit visibility.
 *
 * Requirements: a deployed/running portal whose Super Admin can see invitation
 * links (ALLOW_ADMIN_RESET_LINKS=true - use a NON-PRODUCTION environment), a
 * storage bucket with browser CORS configured, and Playwright with Chromium.
 *
 *   E2E_BASE_URL=http://localhost:3000 E2E_ADMIN_EMAIL=... E2E_ADMIN_PASSWORD=... \
 *     node tests/e2e/portal-smoke.mjs
 *
 * Optional: E2E_SCREENSHOT_DIR to save screenshots of each step.
 * Never run this against production: it creates customers, users and documents.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const SHOTS = process.env.E2E_SCREENSHOT_DIR;
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) throw new Error("Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD");
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const stamp = Date.now().toString(36).toUpperCase();
const customerName = `Antrix E2E ${stamp}`;
const customerCode = `AE2E${stamp}`.slice(0, 32);
const userEmail = `e2e.user.${stamp.toLowerCase()}@example.test`;
const userPassword = "Customer-Pass-2024!";
const PDF = Buffer.from("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n% Tekpro e2e\n%%EOF\n");
const BIG = Buffer.alloc(7 * 1024 * 1024 + 123, 0);
BIG.write("PK\u0003\u0004", 0, "latin1");

const results = [];
const step = async (name, fn) => {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.log(`FAIL  ${name}: ${err.message}`);
    throw err;
  }
};
const shot = async (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
const expectVisible = async (locator, timeout = 15_000) => locator.first().waitFor({ state: "visible", timeout });

const browser = await chromium.launch();
try {
  const adminCtx = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
  const admin = await adminCtx.newPage();
  const consoleErrors = [];
  admin.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));

  await step("Super Admin signs in", async () => {
    await admin.goto(`${BASE}/login`);
    await shot(admin, "01-login");
    await admin.getByLabel("Email address").fill(ADMIN_EMAIL);
    await admin.getByLabel("Password").fill(ADMIN_PASSWORD);
    await admin.getByRole("button", { name: "Sign in" }).click();
    await expectVisible(admin.getByRole("heading", { name: "Platform overview" }));
    await shot(admin, "02-admin-dashboard");
  });

  let customerUrl;
  await step("Super Admin creates a customer", async () => {
    await admin.getByRole("link", { name: "Customers", exact: true }).click();
    await admin.getByRole("button", { name: "New customer" }).click();
    await admin.getByLabel("Organisation name").fill(customerName);
    await admin.getByLabel("Customer code").fill(customerCode);
    await admin.getByRole("button", { name: "Save" }).click();
    await expectVisible(admin.getByRole("heading", { name: customerName }));
    customerUrl = admin.url();
  });

  await step("Super Admin creates a folder", async () => {
    await admin.getByRole("link", { name: "Open documents" }).click();
    await admin.getByRole("button", { name: "+ Folder" }).click();
    await admin.getByLabel("Folder name").fill("Reports");
    await admin.getByRole("button", { name: "Create folder" }).click();
    await admin.locator(".tree-label", { hasText: "Reports" }).click();
    await expectVisible(admin.getByText("This folder has no documents yet."));
  });

  await step("Direct-to-storage single and multipart uploads complete with server verification", async () => {
    const input = admin.getByTestId("file-input");
    await input.setInputFiles({ name: "Annual Report.pdf", mimeType: "application/pdf", buffer: PDF });
    await expectVisible(admin.locator(".upload-done", { hasText: "Annual Report.pdf" }), 30_000);
    await input.setInputFiles({ name: "Large Archive.zip", mimeType: "application/zip", buffer: BIG });
    await expectVisible(admin.locator(".upload-done", { hasText: "Large Archive.zip" }), 60_000);
    await expectVisible(admin.getByRole("cell", { name: /Annual Report\.pdf/ }));
    await expectVisible(admin.getByRole("cell", { name: /Large Archive\.zip/ }));
    await shot(admin, "03-explorer-after-upload");
  });

  await step("Disguised file is rejected after upload verification", async () => {
    await admin.getByTestId("file-input").setInputFiles({ name: "invoice.pdf", mimeType: "application/pdf", buffer: Buffer.from("MZ\u0090\u0000 not a pdf") });
    await expectVisible(admin.locator(".upload-failed", { hasText: "invoice.pdf" }), 30_000);
  });

  let inviteLink;
  await step("Super Admin invites a customer user", async () => {
    await admin.goto(customerUrl);
    await admin.getByRole("tab", { name: "Customer users" }).click();
    await admin.getByRole("button", { name: "New customer user" }).click();
    await admin.getByLabel("Full name").fill("E2E Customer User");
    await admin.getByLabel("Email address").fill(userEmail);
    await admin.getByRole("button", { name: "Create user" }).click();
    inviteLink = (await admin.locator(".copy-link").first().textContent())?.trim();
    if (!inviteLink?.includes("/reset-password?token=")) throw new Error("invite link not shown");
    await admin.getByRole("button", { name: "Done" }).click();
  });

  await step("Super Admin grants the user DOWNLOAD on Reports", async () => {
    await admin.getByRole("link", { name: "Manage" }).first().click();
    await admin.getByLabel("Folder", { exact: true }).selectOption({ label: "Reports" });
    await admin.getByLabel("Permission", { exact: true }).selectOption("DOWNLOAD");
    await admin.getByRole("button", { name: "Grant" }).click();
    await expectVisible(admin.getByLabel("Permission for Reports"));
    await shot(admin, "04-user-permissions");
  });

  const userCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const user = await userCtx.newPage();

  await step("Customer user sets a password from the invitation and signs in (mobile viewport)", async () => {
    await user.goto(inviteLink);
    await user.getByLabel("New password", { exact: true }).fill(userPassword);
    await user.getByLabel("Confirm new password").fill(userPassword);
    await user.getByRole("button", { name: "Save password" }).click();
    await user.getByRole("link", { name: "Go to sign in" }).click();
    await user.getByLabel("Email address").fill(userEmail);
    await user.getByLabel("Password").fill(userPassword);
    await user.getByRole("button", { name: "Sign in" }).click();
    await expectVisible(user.getByRole("heading", { name: customerName }));
    await shot(user, "05-customer-dashboard-mobile");
  });

  await step("Customer user sees documents but no management controls", async () => {
    await user.goto(`${BASE}/documents`);
    await expectVisible(user.getByText("Annual Report.pdf"));
    for (const name of ["Choose files", "+ Folder", "Rename Annual Report.pdf", "Delete Annual Report.pdf"]) {
      if (await user.getByRole("button", { name }).count()) throw new Error(`unexpected control: ${name}`);
    }
    await shot(user, "06-customer-explorer-mobile");
  });

  await step("Customer user downloads via a short-lived pre-signed URL", async () => {
    const [download] = await Promise.all([
      user.waitForEvent("download", { timeout: 20_000 }),
      user.getByRole("button", { name: "Download Annual Report.pdf" }).click(),
    ]);
    const file = await download.path();
    const { readFileSync } = await import("node:fs");
    if (!readFileSync(file).equals(PDF)) throw new Error("downloaded content differs");
    if (download.suggestedFilename() !== "Annual Report.pdf") throw new Error(`filename ${download.suggestedFilename()}`);
  });

  await step("Customer user is blocked from admin pages and upload API", async () => {
    await user.goto(`${BASE}/users`);
    await expectVisible(user.getByText("Access denied"));
    const me = await user.request.get(`${BASE}/api/v1/auth/me`);
    const { data } = await me.json();
    const res = await user.request.post(`${BASE}/api/v1/customers/${data.user.customerId}/uploads/initiate`, {
      headers: { "X-CSRF-Token": data.csrfToken, Origin: BASE },
      data: { folderId: "00000000-0000-4000-8000-000000000000", filename: "x.pdf", sizeBytes: 1 },
    });
    if (res.status() !== 403) throw new Error(`expected 403, got ${res.status()}`);
  });

  await step("Super Admin sees the download in the audit log", async () => {
    await admin.goto(`${BASE}/audit`);
    await expectVisible(admin.getByRole("cell", { name: "Download link issued" }));
    await shot(admin, "07-audit-log");
  });

  await step("No browser console errors (CSP, CORS) in the admin session", async () => {
    const relevant = consoleErrors.filter((e) => !/Failed to load resource: the server responded with a status of (4\d\d)/.test(e));
    if (relevant.length) throw new Error(relevant.join(" | "));
  });
} finally {
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} steps passed`);
  process.exitCode = failed ? 1 : 0;
}
