import { badRequest } from "./errors.js";

const MAX_NAME_LENGTH = 255;
// Control characters, path separators and characters that are invalid on common file systems.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f<>:"/\\|?*]/;
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069\u200e\u200f]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Validates a user-supplied display name for a document or folder. Names are only
 * metadata - they are never used to build storage keys or file system paths - but
 * they are still constrained so they cannot carry path traversal sequences,
 * control characters or right-to-left override tricks into downloads.
 */
export function validateDisplayName(raw: string, kind: "File name" | "Folder name"): string {
  const name = raw.normalize("NFC").trim();
  if (!name) throw badRequest(`${kind} is required`);
  if (name.length > MAX_NAME_LENGTH) throw badRequest(`${kind} must be at most ${MAX_NAME_LENGTH} characters`);
  if (FORBIDDEN_CHARS.test(name)) throw badRequest(`${kind} contains characters that are not allowed (< > : " / \\ | ? *)`);
  if (BIDI_CONTROLS.test(name)) throw badRequest(`${kind} contains invisible direction-control characters`);
  if (name === "." || name === ".." || /^\.+$/.test(name)) throw badRequest(`${kind} is not valid`);
  if (name.endsWith(".") || name.endsWith(" ")) throw badRequest(`${kind} cannot end with a dot or space`);
  if (WINDOWS_RESERVED.test(name)) throw badRequest(`${kind} uses a reserved name`);
  return name;
}

export function fileExtension(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx <= 0 || idx === name.length - 1) return "";
  return name.slice(idx + 1).toLowerCase();
}

/** RFC 6266 / RFC 5987 Content-Disposition value forcing a download. */
export function attachmentContentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
