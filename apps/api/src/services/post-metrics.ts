import type { Prisma, PrismaClient } from '@prisma/client';
import { readDirectCredential } from '../integrations/direct-social.js';
import { fetchDirectMetrics, MetricsPermissionError } from '../integrations/post-metrics.js';
import { refreshAccount } from './publish-clip.js';

const HOUR = 3600_000;
/** On-demand refreshes reuse any fetch from the last six hours. */
export const METRICS_CACHE_MS = 6 * HOUR;
/** A failed fetch is not retried by the schedule for an hour. */
const RETRY_AFTER_MS = HOUR;

/**
 * Posts due for a scheduled snapshot: 24 hours after publishing, then 72 hours. Engagement is not polled
 * in between; dashboards refresh on demand.
 */
export function dueMetricsWhere(now = new Date()) {
  const ago = (ms: number) => new Date(now.getTime() - ms);
  return {
    status: 'PUBLISHED_LIVE', directProvider: { not: null }, externalPostId: { not: null },
    OR: [
      { metricsStage: 0, publishedAt: { lte: ago(24 * HOUR) } },
      { metricsStage: 1, publishedAt: { lte: ago(72 * HOUR) } },
    ],
    AND: [{ OR: [{ metricsCheckedAt: null }, { metricsCheckedAt: { lte: ago(RETRY_AFTER_MS) } }] }],
  } satisfies Prisma.PublishPostWhereInput;
}

export function dueMetricPosts(prisma: PrismaClient, workspaceId: string, take = 10, now = new Date()) {
  return prisma.publishPost.findMany({
    where: { workspaceId, ...dueMetricsWhere(now) }, orderBy: { publishedAt: 'asc' }, take, select: { id: true },
  });
}

/** Simulated growth for sandbox posts only, so demo workspaces still show charts. */
function sandboxMetrics(postId: string, previous?: { views: number; likes: number; comments: number; shares: number; completionRatePct: number }) {
  const seed = postId.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const delta = 450 + (seed % 1400);
  return {
    views: (previous?.views ?? 1200) + delta,
    likes: (previous?.likes ?? 95) + Math.round(delta * 0.085),
    comments: (previous?.comments ?? 12) + Math.round(delta * 0.011),
    shares: (previous?.shares ?? 19) + Math.round(delta * 0.018),
    watchTimeAvgSec: 16.4,
    completionRatePct: Math.min(98, (previous?.completionRatePct ?? 64) + 1.5),
  };
}

export type MetricsOutcome = 'LIVE' | 'SIMULATED' | 'NOT_YET' | 'NEEDS_RECONNECT' | 'UNSUPPORTED' | 'FAILED';

/**
 * Fetch one post's engagement and store a snapshot. Real posts only ever get numbers from their
 * platform; nothing is estimated. When `advanceSchedule` is set, a successful fetch also moves the
 * post past its 24 h or 72 h checkpoint.
 */
export async function refreshPostMetrics(prisma: PrismaClient, postId: string, advanceSchedule = false): Promise<MetricsOutcome> {
  const post = await prisma.publishPost.findUnique({
    where: { id: postId },
    include: { socialAccount: true, metricSnapshots: { orderBy: { capturedAt: 'desc' }, take: 1 } },
  });
  if (!post) return 'FAILED';
  const now = new Date();
  const mark = (data: { metricsError: string | null; metricsStage?: number }) =>
    prisma.publishPost.update({ where: { id: post.id }, data: { metricsCheckedAt: now, ...data } });

  if (post.status === 'PUBLISHED_SANDBOX') {
    await prisma.postMetricSnapshot.create({
      data: { workspaceId: post.workspaceId, publishPostId: post.id, sourceMode: 'SANDBOX_SIMULATED', ...sandboxMetrics(post.id, post.metricSnapshots[0]) },
    });
    await mark({ metricsError: null });
    return 'SIMULATED';
  }
  if (post.status !== 'PUBLISHED_LIVE' || !post.externalPostId) return 'NOT_YET';

  const credential = readDirectCredential(post.socialAccount.encryptedToken);
  if (!post.directProvider || !credential || credential.provider !== post.directProvider) {
    await mark({ metricsError: post.directProvider
      ? 'Reconnect the original destination account to see its metrics.'
      : 'Metrics are not available for posts published through Postiz yet.' });
    return post.directProvider ? 'NEEDS_RECONNECT' : 'UNSUPPORTED';
  }
  try {
    const fresh = await refreshAccount(prisma, post.socialAccountId, post.socialAccount.encryptedToken!, credential);
    const metrics = await fetchDirectMetrics(fresh, post.externalPostId);
    if (!metrics) {
      await mark({ metricsError: null });
      return 'NOT_YET';
    }
    await prisma.postMetricSnapshot.create({
      data: {
        workspaceId: post.workspaceId, publishPostId: post.id, sourceMode: 'LIVE_PLATFORM_API',
        views: metrics.views, likes: metrics.likes, comments: metrics.comments, shares: metrics.shares,
        watchTimeAvgSec: metrics.watchTimeAvgSec ?? 0, completionRatePct: 0,
      },
    });
    const ageMs = now.getTime() - (post.publishedAt ?? now).getTime();
    await mark({
      metricsError: null,
      ...(advanceSchedule ? { metricsStage: ageMs >= 72 * HOUR ? 2 : Math.max(post.metricsStage, 1) } : {}),
    });
    return 'LIVE';
  } catch (error) {
    const permission = error instanceof MetricsPermissionError;
    await mark({ metricsError: permission
      ? 'Reconnect this account once to allow analytics.'
      : 'Could not read metrics from the platform. They will be retried.' });
    return permission ? 'NEEDS_RECONNECT' : 'FAILED';
  }
}

/**
 * Dashboard refresh: fetch only published posts not checked in the last six hours, newest first,
 * at most `limit` per request. Everything else is served from stored snapshots.
 */
export async function refreshStaleMetrics(prisma: PrismaClient, workspaceId: string, limit = 50, now = new Date()) {
  const posts = await prisma.publishPost.findMany({
    where: {
      workspaceId, status: { in: ['PUBLISHED_SANDBOX', 'PUBLISHED_LIVE'] },
      OR: [{ metricsCheckedAt: null }, { metricsCheckedAt: { lte: new Date(now.getTime() - METRICS_CACHE_MS) } }],
    },
    orderBy: { publishedAt: 'desc' }, take: limit, select: { id: true },
  });
  const outcomes: Record<MetricsOutcome, number> = { LIVE: 0, SIMULATED: 0, NOT_YET: 0, NEEDS_RECONNECT: 0, UNSUPPORTED: 0, FAILED: 0 };
  for (const post of posts) outcomes[await refreshPostMetrics(prisma, post.id)]++;
  return { refreshed: posts.length, outcomes };
}
