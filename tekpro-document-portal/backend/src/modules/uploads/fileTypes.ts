import { fileTypeFromBuffer } from "file-type";

/**
 * Server-controlled Content-Type per extension. The browser-declared MIME type
 * is never trusted; documents are always served as attachments.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  csv: "text/csv",
  txt: "text/plain",
  rtf: "application/rtf",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
  zip: "application/zip",
  "7z": "application/x-7z-compressed",
  gz: "application/gzip",
  tar: "application/x-tar",
  xml: "application/xml",
  json: "application/json",
  eml: "message/rfc822",
  msg: "application/vnd.ms-outlook",
  dwg: "image/vnd.dwg",
  dxf: "image/vnd.dxf",
};

export function mimeTypeForExtension(ext: string): string {
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

/**
 * Groups of extensions whose files share a binary signature. A file's detected
 * signature must fall into the same group as its declared extension.
 */
const SIGNATURE_GROUPS: string[][] = [
  ["pdf"],
  ["png"],
  ["jpg", "jpeg"],
  ["gif"],
  ["tif", "tiff"],
  ["webp"],
  ["7z"],
  ["gz"],
  ["tar"],
  ["rtf"],
  ["dwg"],
  // OOXML / ODF documents are ZIP containers; a short prefix may only reveal "zip".
  ["zip", "docx", "xlsx", "xlsm", "pptx", "odt", "ods", "odp"],
  // Legacy Office and Outlook files are OLE compound files.
  ["doc", "xls", "ppt", "msg", "cfb"],
];

/** Extensions that must carry a recognisable binary signature. */
const REQUIRES_SIGNATURE = new Set(SIGNATURE_GROUPS.flat().filter((e) => !["rtf", "dwg", "tar", "cfb"].includes(e)));

function groupOf(ext: string): string[] | undefined {
  return SIGNATURE_GROUPS.find((g) => g.includes(ext));
}

export interface ContentCheck {
  ok: boolean;
  detectedExtension?: string;
  detectedMime?: string;
  reason?: string;
}

/** Number of leading bytes read from storage for signature detection. */
export const SNIFF_BYTES = 4100;

/**
 * Validates the uploaded bytes against the declared extension and the allow-list.
 * This is a content-type consistency check, not malware scanning.
 */
export async function checkContent(prefix: Uint8Array, declaredExt: string, allowed: Set<string>): Promise<ContentCheck> {
  const detected = prefix.length ? await fileTypeFromBuffer(prefix) : undefined;
  if (!detected) {
    if (REQUIRES_SIGNATURE.has(declaredExt) && prefix.length > 0) {
      return { ok: false, reason: `content does not look like a .${declaredExt} file` };
    }
    return { ok: true };
  }
  const dext = detected.ext.toLowerCase();
  const declaredGroup = groupOf(declaredExt) ?? [declaredExt];
  if (declaredGroup.includes(dext)) return { ok: true, detectedExtension: dext, detectedMime: detected.mime };
  // XML-based and plain text formats can legitimately be detected as xml.
  if (dext === "xml" && ["xml", "txt", "csv", "json", "dxf", "eml"].includes(declaredExt)) {
    return { ok: true, detectedExtension: dext, detectedMime: detected.mime };
  }
  const allowedNote = allowed.has(dext) ? "" : " (type not permitted)";
  return {
    ok: false,
    detectedExtension: dext,
    detectedMime: detected.mime,
    reason: `content is .${dext}${allowedNote} but the file is named .${declaredExt}`,
  };
}
