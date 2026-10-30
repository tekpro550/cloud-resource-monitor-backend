import { beforeEach, describe, expect, it } from "vitest";
import { purgeDeletedDocuments } from "../../src/jobs/purgeDeleted.js";
import { api, createDocument, createTestApp, login, prisma, resetDb, seedTwoTenants, type LoggedIn, type Seed, type TestHarness } from "../helpers/testApp.js";

describe("document listing, search and actions", () => {
  let h: TestHarness;
  let seed: Seed;
  let staff: LoggedIn;
  const list = (qs = "") => api(staff).get(`/api/v1/customers/${seed.customers.antrix.id}/documents${qs}`);

  beforeEach(async () => {
    await resetDb();
    h = createTestApp();
    seed = await seedTwoTenants(h.storage);
    staff = await login(h.app, "staff@tekpro.test");
  });

  it("paginates on the database with stable ordering", async () => {
    for (let i = 0; i < 12; i++) {
      await createDocument(h.storage, seed.customers.antrix.id, seed.folders.contracts.id, `Doc ${String(i).padStart(2, "0")}.pdf`);
    }
    const p1 = await list(`?folderId=${seed.folders.contracts.id}&sort=name&order=asc&pageSize=5&page=1`);
    const p3 = await list(`?folderId=${seed.folders.contracts.id}&sort=name&order=asc&pageSize=5&page=3`);
    expect(p1.body.data.pagination).toEqual({ page: 1, pageSize: 5, total: 13, totalPages: 3 });
    expect(p1.body.data.items.map((d: { displayName: string }) => d.displayName)).toEqual([
      "Doc 00.pdf",
      "Doc 01.pdf",
      "Doc 02.pdf",
      "Doc 03.pdf",
      "Doc 04.pdf",
    ]);
    expect(p3.body.data.items).toHaveLength(3);
    expect((await list("?pageSize=1000")).status).toBe(400);
  });

  it("searches by name case-insensitively and treats wildcards literally", async () => {
    await createDocument(h.storage, seed.customers.antrix.id, seed.folders.contracts.id, "100% done.pdf");
    await createDocument(h.storage, seed.customers.antrix.id, seed.folders.contracts.id, "file_one.pdf");
    await createDocument(h.storage, seed.customers.antrix.id, seed.folders.contracts.id, "fileXone.pdf");
    expect((await list("?q=annual")).body.data.items.map((d: { displayName: string }) => d.displayName)).toEqual(["Annual Report.pdf"]);
    expect((await list("?q=%25")).body.data.items.map((d: { displayName: string }) => d.displayName)).toEqual(["100% done.pdf"]);
    expect((await list("?q=file_")).body.data.items.map((d: { displayName: string }) => d.displayName)).toEqual(["file_one.pdf"]);
  });

  it("filters by type and date and sorts by size", async () => {
    await createDocument(h.storage, seed.customers.antrix.id, seed.folders.contracts.id, "sheet.xlsx", "PK\u0003\u0004 a much longer body for size sorting");
    await createDocument(h.storage, seed.customers.antrix.id, seed.folders.contracts.id, "old.pdf", "%PDF", { createdAt: new Date("2020-01-01") });
    const sheets = await list("?type=spreadsheet");
    expect(sheets.body.data.items.map((d: { displayName: string }) => d.displayName)).toEqual(["sheet.xlsx"]);
    const old = await list("?to=2021-01-01");
    expect(old.body.data.items.map((d: { displayName: string }) => d.displayName)).toEqual(["old.pdf"]);
    const bySize = await list("?sort=size&order=desc&pageSize=1");
    expect(bySize.body.data.items[0].displayName).toBe("sheet.xlsx");
  });

  it("lists a folder recursively", async () => {
    const res = await list(`?folderId=${seed.folders.reports.id}&recursive=true`);
    expect(res.body.data.items.map((d: { displayName: string }) => d.displayName).sort()).toEqual([
      "Annual Report.pdf",
      "Q1 Summary.pdf",
      "Secret Plan.pdf",
    ]);
  });

  it("renames without touching storage and keeps the extension fixed", async () => {
    const key = seed.docs.report.objectKey;
    const res = await api(staff).patch(`/api/v1/documents/${seed.docs.report.id}`, { displayName: "Annual Report 2024.pdf" });
    expect(res.status).toBe(200);
    expect(h.storage.objects.has(key)).toBe(true);
    expect((await prisma().document.findUniqueOrThrow({ where: { id: seed.docs.report.id } })).objectKey).toBe(key);
    expect((await api(staff).patch(`/api/v1/documents/${seed.docs.report.id}`, { displayName: "Annual.exe" })).status).toBe(400);
    expect(await prisma().auditLog.count({ where: { action: "document.renamed" } })).toBe(1);
  });

  it("moves documents between folders of the same customer and audits it", async () => {
    const res = await api(staff).patch(`/api/v1/documents/${seed.docs.report.id}`, { folderId: seed.folders.contracts.id });
    expect(res.status).toBe(200);
    const audit = await prisma().auditLog.findFirstOrThrow({ where: { action: "document.moved" } });
    expect(audit.metadata).toMatchObject({ from: seed.folders.reports.id, to: seed.folders.contracts.id });
    // The customer user loses access because the document left its permitted folder.
    const user = await login(h.app, "user@antrix.test");
    expect((await api(user).get(`/api/v1/documents/${seed.docs.report.id}/download`)).status).toBe(404);
  });

  it("soft-deletes, hides from customers, restores, then purges after retention", async () => {
    const admin = await login(h.app, "admin@antrix.test");
    const del = await api(staff).delete(`/api/v1/documents/${seed.docs.contract.id}`);
    expect(del.status).toBe(200);
    expect((await api(admin).get(`/api/v1/documents/${seed.docs.contract.id}`)).status).toBe(404);
    const deleted = await list("?status=DELETED");
    expect(deleted.body.data.items.map((d: { id: string }) => d.id)).toEqual([seed.docs.contract.id]);

    expect((await api(staff).post(`/api/v1/documents/${seed.docs.contract.id}/restore`)).status).toBe(200);
    expect((await api(admin).get(`/api/v1/documents/${seed.docs.contract.id}`)).status).toBe(200);

    await api(staff).delete(`/api/v1/documents/${seed.docs.contract.id}`);
    await prisma().document.update({ where: { id: seed.docs.contract.id }, data: { purgeAfter: new Date(Date.now() - 1000) } });
    const result = await purgeDeletedDocuments(h.services);
    expect(result).toEqual({ purged: 1, failed: 0 });
    expect(h.storage.objects.has(seed.docs.contract.objectKey)).toBe(false);
    expect((await prisma().document.findUniqueOrThrow({ where: { id: seed.docs.contract.id } })).status).toBe("PURGED");
    expect((await api(staff).get(`/api/v1/documents/${seed.docs.contract.id}`)).status).toBe(404);
  });

  it("keeps the document recoverable when storage deletion fails, and retries later", async () => {
    await api(staff).delete(`/api/v1/documents/${seed.docs.contract.id}`);
    await prisma().document.update({ where: { id: seed.docs.contract.id }, data: { purgeAfter: new Date(Date.now() - 1000) } });
    h.storage.failNext("deleteObject", "UNAVAILABLE");
    expect(await purgeDeletedDocuments(h.services)).toEqual({ purged: 0, failed: 1 });
    const doc = await prisma().document.findUniqueOrThrow({ where: { id: seed.docs.contract.id } });
    expect(doc.status).toBe("DELETED");
    expect(doc.purgeAttempts).toBe(1);
    expect(await prisma().auditLog.count({ where: { action: "document.purge_failed" } })).toBe(1);
    expect(await purgeDeletedDocuments(h.services)).toEqual({ purged: 1, failed: 0 });
  });

  it("purges immediately when retention is zero days", async () => {
    const immediate = createTestApp({ DELETED_DOCUMENT_RETENTION_DAYS: "0" });
    immediate.storage.objects.set(seed.docs.contract.objectKey, h.storage.objects.get(seed.docs.contract.objectKey)!);
    const sa = await login(immediate.app, "super@tekpro.test");
    expect((await api(sa).delete(`/api/v1/documents/${seed.docs.contract.id}`)).status).toBe(200);
    expect(immediate.storage.objects.has(seed.docs.contract.objectKey)).toBe(false);
    expect((await prisma().document.findUniqueOrThrow({ where: { id: seed.docs.contract.id } })).status).toBe("PURGED");
  });
});
