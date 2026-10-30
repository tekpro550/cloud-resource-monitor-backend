import { describe, expect, it } from "vitest";
import type { FolderPermissionLevel } from "@prisma/client";
import { computeCustomerAccess, hasLevel } from "../../src/modules/permissions/accessPolicy.js";

/*
 * Tree:
 *   root
 *   ├── a
 *   │   ├── a1
 *   │   │   └── a1x
 *   │   └── a2
 *   └── hidden (hiddenFromCustomer)
 *       └── h1
 */
const folders = [
  { id: "root", parentFolderId: null, hiddenFromCustomer: false, name: "root" },
  { id: "a", parentFolderId: "root", hiddenFromCustomer: false, name: "a" },
  { id: "a1", parentFolderId: "a", hiddenFromCustomer: false, name: "a1" },
  { id: "a1x", parentFolderId: "a1", hiddenFromCustomer: false, name: "a1x" },
  { id: "a2", parentFolderId: "a", hiddenFromCustomer: false, name: "a2" },
  { id: "hidden", parentFolderId: "root", hiddenFromCustomer: true, name: "hidden" },
  { id: "h1", parentFolderId: "hidden", hiddenFromCustomer: false, name: "h1" },
];
const grants = (entries: [string, FolderPermissionLevel][]) => new Map(entries);
const asObject = (m: Map<string, string>) => Object.fromEntries([...m.entries()].sort());

describe("computeCustomerAccess", () => {
  it("customer admin sees every non-hidden folder with DOWNLOAD", () => {
    expect(asObject(computeCustomerAccess(folders, "CUSTOMER_ADMIN", grants([])))).toEqual({
      root: "DOWNLOAD",
      a: "DOWNLOAD",
      a1: "DOWNLOAD",
      a1x: "DOWNLOAD",
      a2: "DOWNLOAD",
    });
  });

  it("customer user without grants sees nothing", () => {
    expect(computeCustomerAccess(folders, "CUSTOMER_USER", grants([])).size).toBe(0);
  });

  it("grants are inherited by descendants", () => {
    expect(asObject(computeCustomerAccess(folders, "CUSTOMER_USER", grants([["a", "DOWNLOAD"]])))).toEqual({
      a: "DOWNLOAD",
      a1: "DOWNLOAD",
      a1x: "DOWNLOAD",
      a2: "DOWNLOAD",
    });
  });

  it("a nearer grant restricts a broader one", () => {
    const m = computeCustomerAccess(folders, "CUSTOMER_USER", grants([["a", "DOWNLOAD"], ["a1", "VIEW"]]));
    expect(m.get("a1")).toBe("VIEW");
    expect(m.get("a1x")).toBe("VIEW");
    expect(m.get("a2")).toBe("DOWNLOAD");
  });

  it("an explicit NONE denies the whole subtree and cannot be overridden by deeper grants", () => {
    const m = computeCustomerAccess(folders, "CUSTOMER_USER", grants([["root", "DOWNLOAD"], ["a1", "NONE"], ["a1x", "DOWNLOAD"]]));
    expect(m.has("a1")).toBe(false);
    expect(m.has("a1x")).toBe(false);
    expect(m.get("a2")).toBe("DOWNLOAD");
  });

  it("hidden folders override any grant", () => {
    const m = computeCustomerAccess(folders, "CUSTOMER_USER", grants([["root", "DOWNLOAD"], ["h1", "DOWNLOAD"]]));
    expect(m.has("hidden")).toBe(false);
    expect(m.has("h1")).toBe(false);
  });

  it("denies folders whose parent is missing (deleted) and survives corrupt cycles", () => {
    const orphan = [{ id: "x", parentFolderId: "gone", hiddenFromCustomer: false, name: "x" }];
    expect(computeCustomerAccess(orphan, "CUSTOMER_ADMIN", grants([])).size).toBe(0);
    const cycle = [
      { id: "p", parentFolderId: "q", hiddenFromCustomer: false, name: "p" },
      { id: "q", parentFolderId: "p", hiddenFromCustomer: false, name: "q" },
    ];
    expect(computeCustomerAccess(cycle, "CUSTOMER_USER", grants([["p", "DOWNLOAD"]])).has("q")).toBe(false);
  });

  it("orders access levels", () => {
    expect(hasLevel("MANAGE", "DOWNLOAD")).toBe(true);
    expect(hasLevel("VIEW", "DOWNLOAD")).toBe(false);
    expect(hasLevel(undefined, "VIEW")).toBe(false);
  });
});
