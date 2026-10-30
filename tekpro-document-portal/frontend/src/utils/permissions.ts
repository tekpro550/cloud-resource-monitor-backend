import type { Role } from "../types/api";

/**
 * UI capability map. This only decides what the interface shows; every action is
 * independently authorised by the API.
 */
export function capabilities(role: Role) {
  const superAdmin = role === "SUPER_ADMIN";
  const staff = role === "SUPER_ADMIN" || role === "TEKPRO_USER";
  return {
    manageCustomers: superAdmin,
    manageUsers: superAdmin,
    manageAssignments: superAdmin,
    manageFolderAccess: superAdmin,
    viewPlatformStats: superAdmin,
    manageSettings: superAdmin,
    browseAllCustomers: staff,
    uploadDocuments: staff,
    manageContent: staff,
    viewDocumentLifecycle: staff,
  };
}

export const isStaff = (role: Role) => role === "SUPER_ADMIN" || role === "TEKPRO_USER";
