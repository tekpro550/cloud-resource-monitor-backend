/**
 * Browser smoke test for per-customer storage connectors (NON-PRODUCTION only).
 *
 * Signs in as a Super Admin, creates a customer, connects it to a customer-owned
 * bucket via the Storage tab (IAM role), verifies the connection, then uploads a
 * document through the explorer and downloads it again.
 *
 *   E2E_BASE_URL=http://localhost:5173 E2E_ADMIN_EMAIL=... E2E_ADMIN_PASSWORD=... \
 *   E2E_CONNECTOR_BUCKET=customer-demo E2E_CONNECTOR_REGION=us-east-1 \
 *   E2E_CONNECTOR_ROLE_ARN=arn:aws:iam::123456789012:role/TekproPortalAccess \
 *   [E2E_CONNECTOR_ENDPOINT=http://localhost:5050]   # S3-compatible endpoint (local dev)
 *   node tests/e2e/connector-smoke.mjs
 */
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const env = process.env;
const BASE = env.E2E_BASE_URL ?? "http://localhost:5173";
for (const k of ["E2E_ADMIN_EMAIL", "E2E_ADMIN_PASSWORD", "E2E_CONNECTOR_BUCKET", "E2E_CONNECTOR_REGION", "E2E_CONNECTOR_ROLE_ARN"]) {
  if (!env[k]) throw new Error(`Set ${k}`);
}
const SHOTS = env.E2E_SCREENSHOT_DIR;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const stamp = Date.now().toString(36).toUpperCase();
const PDF = Buffer.from("%PDF-1.7\n% stored in the customer's own bucket\n%%EOF\n");

let passed = 0;
let failed = 0;
const step = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}: ${err.message}`);
    throw err;
  }
};
const shot = (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
const visible = (loc, timeout = 20_000) => loc.first().waitFor({ state: "visible", timeout });

const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true })).newPage();

  await step("Super Admin signs in and creates a customer", async () => {
    await page.goto(`${BASE}/login`);
    await page.getByLabel("Email address").fill(env.E2E_ADMIN_EMAIL);
    await page.getByLabel("Password").fill(env.E2E_ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await visible(page.getByRole("heading", { name: "Platform overview" }));
    await page.goto(`${BASE}/customers`);
    await page.getByRole("button", { name: "New customer" }).click();
    await page.getByLabel("Organisation name").fill(`Own Bucket ${stamp}`);
    await page.getByLabel("Customer code").fill(`OWN${stamp}`.slice(0, 32));
    await page.getByRole("button", { name: "Save" }).click();
    await visible(page.getByRole("heading", { name: `Own Bucket ${stamp}` }));
  });

  await step("Connects the customer's bucket with an IAM role", async () => {
    await page.getByRole("tab", { name: "Storage" }).click();
    await visible(page.getByText("Tekpro platform storage"));
    if (env.E2E_CONNECTOR_ENDPOINT) {
      await page.getByLabel("Storage type").selectOption("S3_COMPATIBLE");
      await page.getByLabel("Endpoint").fill(env.E2E_CONNECTOR_ENDPOINT);
      await page.getByLabel(/path-style/).check();
    }
    await page.getByLabel("Bucket name").fill(env.E2E_CONNECTOR_BUCKET);
    await page.getByLabel("Region").fill(env.E2E_CONNECTOR_REGION);
    await page.getByLabel("Role ARN").fill(env.E2E_CONNECTOR_ROLE_ARN);
    await page.getByRole("button", { name: "Save connection" }).click();
    await visible(page.getByText("Needs verification"));
    await visible(page.getByText("Setup instructions for the customer"));
    await shot(page, "c1-connector-pending");
  });

  await step("Verification passes every check and activates the connection", async () => {
    await page.getByRole("button", { name: "Verify connection" }).click();
    await visible(page.getByText("Verification passed"), 60_000);
    const failures = await page.locator(".check-fail").count();
    if (failures) throw new Error(`${failures} check(s) failed`);
    await visible(page.locator(".badge", { hasText: "Active" }));
    await shot(page, "c2-connector-active");
  });

  await step("Uploads go to the customer's bucket and download back intact", async () => {
    await page.getByRole("link", { name: "Open documents" }).click();
    await page.getByRole("button", { name: "+ Folder" }).click();
    await page.getByLabel("Folder name").fill("Inbox");
    await page.getByRole("button", { name: "Create folder" }).click();
    await page.locator(".tree-label", { hasText: "Inbox" }).click();
    await page.getByTestId("file-input").setInputFiles({ name: "Own Bucket.pdf", mimeType: "application/pdf", buffer: PDF });
    await visible(page.locator(".upload-done", { hasText: "Own Bucket.pdf" }), 30_000);
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 20_000 }),
      page.getByRole("button", { name: "Download Own Bucket.pdf" }).click(),
    ]);
    if (!readFileSync(await download.path()).equals(PDF)) throw new Error("downloaded content differs");
    if (!download.url().includes(env.E2E_CONNECTOR_BUCKET)) throw new Error("download did not come from the customer bucket");
    await shot(page, "c3-explorer");
  });
} finally {
  await browser.close();
  console.log(`\n${passed}/${passed + failed} steps passed`);
  process.exitCode = failed ? 1 : 0;
}
