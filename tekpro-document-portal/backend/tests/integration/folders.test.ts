import { beforeEach, describe, expect, it } from "vitest";
import { api, createFolder, createTestApp, login, prisma, resetDb, seedTwoTenants, type LoggedIn, type Seed, type TestHarness } from "../helpers/testApp.js";

describe("folders", () => {
  let h: TestHarness;
  let seed: Seed;
  let staff: LoggedIn;
  const base = () => `/api/v1/customers/${seed.customers.antrix.id}/folders`;

  beforeEach(async () => {
    await resetDb();
    h = createTestApp();
    seed = await seedTwoTenants(h.storage);
    staff = await login(h.app, "staff@tekpro.test");
  });

  it("creates nested folders and returns breadcrumbs", async () => {
    const a = await api(staff).post(base(), { name: "Projects" });
    const b = await api(staff).post(base(), { name: "Alpha", parentFolderId: a.body.data.id });
    expect(b.status).toBe(201);
    const res = await api(staff).get(`/api/v1/folders/${b.body.data.id}`);
    expect(res.body.data.breadcrumb.map((f: { name: string }) => f.name)).toEqual(["Projects"]);
  });

  it("rejects duplicate sibling names case-insensitively but allows them in different parents", async () => {
    expect((await api(staff).post(base(), { name: "contracts" })).status).toBe(409);
    expect((await api(staff).post(base(), { name: "Contracts", parentFolderId: seed.folders.reports.id })).status).toBe(201);
  });

  it("validates folder names", async () => {
    for (const name of ["..", "a/b", "a\\b", "", "  ", "x".repeat(300), "bad\u0000name"]) {
      expect((await api(staff).post(base(), { name })).status, JSON.stringify(name)).toBe(400);
    }
  });

  it("prevents cycles when moving folders", async () => {
    expect((await api(staff).patch(`/api/v1/folders/${seed.folders.reports.id}`, { parentFolderId: seed.folders.reports2024.id })).status).toBe(400);
    expect((await api(staff).patch(`/api/v1/folders/${seed.folders.reports.id}`, { parentFolderId: seed.folders.reports.id })).status).toBe(400);
  });

  it("moves folders within a customer and to the root", async () => {
    const moved = await api(staff).patch(`/api/v1/folders/${seed.folders.reports2024.id}`, { parentFolderId: seed.folders.contracts.id });
    expect(moved.status).toBe(200);
    expect(moved.body.data.parentFolderId).toBe(seed.folders.contracts.id);
    const root = await api(staff).patch(`/api/v1/folders/${seed.folders.reports2024.id}`, { parentFolderId: null });
    expect(root.body.data.parentFolderId).toBeNull();
  });

  it("enforces the maximum nesting depth", async () => {
    let parent: string | null = null;
    for (let i = 0; i < 20; i++) parent = (await createFolder(seed.customers.antrix.id, `L${i}`, parent)).id;
    expect((await api(staff).post(base(), { name: "too deep", parentFolderId: parent })).status).toBe(400);
  });

  it("refuses to delete a non-empty folder without explicit confirmation", async () => {
    const res = await api(staff).delete(`/api/v1/folders/${seed.folders.reports.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("FOLDER_NOT_EMPTY");
    expect(res.body.error.details).toEqual({ subfolders: 2, documents: 3 });
    const wrongName = await api(staff).delete(`/api/v1/folders/${seed.folders.reports.id}`, { recursive: true, confirmName: "reports" });
    expect(wrongName.status).toBe(400);
    expect((await prisma().folder.findUniqueOrThrow({ where: { id: seed.folders.reports.id } })).deletedAt).toBeNull();
  });

  it("recursive deletion soft-deletes the subtree and its documents, leaving other folders untouched", async () => {
    const res = await api(staff).delete(`/api/v1/folders/${seed.folders.reports.id}`, { recursive: true, confirmName: "Reports" });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ subfoldersDeleted: 2, documentsDeleted: 3 });
    const docs = await prisma().document.findMany({ where: { customerId: seed.customers.antrix.id } });
    const byName = Object.fromEntries(docs.map((d) => [d.displayName, d.status]));
    expect(byName).toMatchObject({
      "Annual Report.pdf": "DELETED",
      "Q1 Summary.pdf": "DELETED",
      "Secret Plan.pdf": "DELETED",
      "Master Contract.pdf": "AVAILABLE",
    });
    // Objects are kept until the retention period ends.
    expect(h.storage.objects.has(seed.docs.report.objectKey)).toBe(true);
    // The name can be reused once the folder is deleted.
    expect((await api(staff).post(base(), { name: "Reports" })).status).toBe(201);
  });

  it("deletes an empty folder directly", async () => {
    const f = await api(staff).post(base(), { name: "Empty" });
    expect((await api(staff).delete(`/api/v1/folders/${f.body.data.id}`)).status).toBe(200);
  });

  it("allows only the Super Admin to hide folders from customers", async () => {
    const sa = await login(h.app, "super@tekpro.test");
    expect((await api(sa).patch(`/api/v1/folders/${seed.folders.contracts.id}`, { hiddenFromCustomer: true })).status).toBe(200);
    const admin = await login(h.app, "admin@antrix.test");
    expect((await api(admin).get(`/api/v1/documents/${seed.docs.contract.id}/download`)).status).toBe(404);
  });

  it("reports document counts per folder", async () => {
    const res = await api(staff).get(base());
    const reports = res.body.data.find((f: { name: string }) => f.name === "Reports");
    expect(reports.documentCount).toBe(1);
    expect(reports.access).toBe("MANAGE");
  });

  it("shows customer users their granted subfolder as a root when its parent is not visible", async () => {
    await prisma().customerUserFolderPermission.deleteMany({});
    await prisma().customerUserFolderPermission.create({
      data: { userId: seed.users.antrixUser.id, customerId: seed.customers.antrix.id, folderId: seed.folders.reports2024.id, permission: "DOWNLOAD" },
    });
    const user = await login(h.app, "user@antrix.test");
    const res = await api(user).get(base());
    expect(res.body.data).toEqual([expect.objectContaining({ name: "2024", parentFolderId: null, access: "DOWNLOAD" })]);
    const crumb = await api(user).get(`/api/v1/folders/${seed.folders.reports2024.id}`);
    expect(crumb.body.data.breadcrumb).toEqual([]);
  });
});
