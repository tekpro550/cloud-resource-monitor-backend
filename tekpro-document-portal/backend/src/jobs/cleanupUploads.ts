import { expireSession } from "../modules/uploads/uploads.routes.js";
import type { Services } from "../services.js";

/** A COMPLETING session older than this is assumed to belong to a crashed request. */
const STUCK_COMPLETING_MS = 60 * 60 * 1000;

/**
 * Expires abandoned upload sessions: aborts multipart uploads, removes partial
 * objects and marks the pending document UPLOAD_FAILED. Also prunes expired
 * login sessions and password tokens.
 */
export async function cleanupExpiredUploads(s: Services, batchSize = 200): Promise<{ expired: number; failed: number }> {
  const now = new Date();
  const sessions = await s.prisma.uploadSession.findMany({
    where: {
      OR: [
        { status: "INITIATED", expiresAt: { lte: now } },
        { status: "COMPLETING", updatedAt: { lte: new Date(now.getTime() - STUCK_COMPLETING_MS) }, expiresAt: { lte: now } },
      ],
    },
    include: { document: true },
    take: batchSize,
  });
  let expired = 0;
  let failed = 0;
  for (const session of sessions) {
    if (await expireSession(s, session, null)) expired++;
    else failed++;
  }
  return { expired, failed };
}

export async function pruneAuthRecords(s: Services): Promise<{ sessions: number; tokens: number }> {
  const cutoff = new Date(Date.now() - 7 * 86400_000);
  const sessions = await s.prisma.session.deleteMany({
    where: { OR: [{ expiresAt: { lte: cutoff } }, { revokedAt: { lte: cutoff } }] },
  });
  const tokens = await s.prisma.passwordToken.deleteMany({
    where: { OR: [{ expiresAt: { lte: cutoff } }, { usedAt: { lte: cutoff } }] },
  });
  return { sessions: sessions.count, tokens: tokens.count };
}
