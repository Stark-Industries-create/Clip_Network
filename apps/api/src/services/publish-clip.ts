import type { PrismaClient } from '@prisma/client';
import { dispatchSocialPublish, listPostizPostStates, validatePostForPlatform } from '../integrations/publishing.js';
import { createPresignedS3Url, getS3StorageConfig } from '../integrations/storage.js';

import { directPlatform, encodeDirectCredential, readDirectCredential, refreshDirectCredential, type DirectCredential } from '../integrations/direct-social.js';
import { finishInstagramVideo, getDirectVideoStatus, submitDirectVideo } from '../integrations/direct-video.js';

/**
 * Automatic publishing needs the workspace's own opt-in (each destination must also have
 * autoPublishApproved). AUTO_PUBLISH_DISABLED=true is a global kill switch for every workspace.
 */
export async function autoPublishAllowed(prisma: Pick<PrismaClient, 'workspace'>, workspaceId: string) {
  if (process.env['AUTO_PUBLISH_DISABLED'] === 'true') return false;
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { autoPublishEnabled: true } });
  return workspace?.autoPublishEnabled === true;
}

export async function refreshAccount(prisma: PrismaClient, id: string, encryptedToken: string, credential: DirectCredential) {
  const refreshed = await refreshDirectCredential(credential);
  if (refreshed === credential) return credential;
  const saved = await prisma.socialAccount.updateMany({
    where: { id, encryptedToken }, data: { encryptedToken: encodeDirectCredential(refreshed) },
  });
  if (!saved.count) throw new Error('Social authorization changed during refresh');
  return refreshed;
}

export async function publishClipPost(prisma: PrismaClient, id: string, workspaceId: string, sendTikTokDraft = false) {
  const post = await prisma.publishPost.findFirst({
    where: { id, workspaceId },
    include: { clipJob: true, socialAccount: true },
  });
  if (!post) return null;

  const clip = post.clipJob;
  const credential = readDirectCredential(post.socialAccount.encryptedToken);
  if (credential && directPlatform(credential.provider) !== post.platform) return { post, dispatched: false };
  if (credential?.provider === 'tiktok' && !sendTikTokDraft) return { post, dispatched: false };
  const storage = getS3StorageConfig();
  const mediaUrl = storage && clip.outputMp4Path
    ? createPresignedS3Url({ config: storage, method: 'GET', objectKey: clip.outputMp4Path, expiresSec: 3600 })
    : null;
  const requiresMedia = Boolean(credential) || process.env['NODE_ENV'] === 'production' || Boolean(process.env['POSTIZ_API_KEY']?.trim());
  if (requiresMedia && !mediaUrl) return { post, dispatched: false };

  const claimed = await prisma.$transaction(async (tx) => {
    // Serialize approval and cancellation with the publish claim on the clip row.
    const discovered = await tx.channelVideo.findFirst({ where: { workspaceId, ...(clip.sourceVideoId ? { id: clip.sourceVideoId } : { clipJobId: clip.id }) }, select: { id: true } });
    const route = discovered && await tx.creatorRouteRule.findFirst({
      where: { workspaceId, creatorId: clip.creatorId, socialAccountId: post.socialAccountId, enabled: true },
      select: { minComplianceScore: true },
    });
    const allowAuto = !discovered || (route && route.minComplianceScore <= clip.complianceScore &&
      Boolean(clip.automationSourceKey) && await autoPublishAllowed(tx, workspaceId)
    );
    const eligible = await tx.clipJob.updateMany({
      where: {
        id: clip.id,
        executionStatus: 'COMPLETED',
        compliancePassed: true,
        OR: [
          { approvalStatus: 'APPROVED' },
          ...(allowAuto ? [{
            approvalStatus: 'AWAITING_APPROVAL',
            ...(discovered ? { creator: { autoMonitorEnabled: true } } : {}),
            publishPosts: { some: { id, socialAccount: { autoPublishApproved: true } } },
          }] : []),
        ],
      },
      data: { updatedAt: new Date() },
    });
    if (!eligible.count) return false;
    const claim = await tx.publishPost.updateMany({
      where: { id, workspaceId, status: { in: ['AWAITING_APPROVAL', 'FAILED'] } },
      data: { status: 'PUBLISHING', errorMessage: null },
    });
    return Boolean(claim.count);
  });
  if (!claimed) {
    const current = await prisma.publishPost.findUnique({ where: { id } });
    return current ? { post: current, dispatched: false } : null;
  }

  if (credential && post.socialAccount.encryptedToken && mediaUrl) {
    const youtubeAudience = process.env['YOUTUBE_MADE_FOR_KIDS'];
    if (credential.provider === 'youtube' && !['yes', 'no'].includes(youtubeAudience ?? '')) {
      const failed = await prisma.publishPost.update({
        where: { id }, data: { status: 'FAILED', errorMessage: 'Set the YouTube audience before publishing.' },
      });
      return { post: failed, dispatched: true };
    }
    const validation = validatePostForPlatform({ platform: post.platform, durationSec: clip.durationSec, captionText: post.captionText });
    if (!validation.valid) {
      const failed = await prisma.publishPost.update({ where: { id }, data: { status: 'FAILED', errorMessage: validation.errors.join(' ') } });
      return { post: failed, dispatched: true };
    }
    let refreshed: DirectCredential;
    try {
      refreshed = await refreshAccount(prisma, post.socialAccountId, post.socialAccount.encryptedToken, credential);
    } catch {
      const failed = await prisma.publishPost.update({
        where: { id }, data: { status: 'FAILED', errorMessage: 'Reconnect the social account and retry.' },
      });
      return { post: failed, dispatched: true };
    }
    try {
      const remoteId = await submitDirectVideo(refreshed, mediaUrl, post.captionText);
      const submitted = await prisma.publishPost.update({
        where: { id }, data: { status: 'SUBMITTED', executionMode: 'LIVE_OAUTH', directProvider: credential.provider, externalPostId: remoteId, publishedAt: null },
      });
      return { post: submitted, dispatched: true };
    } catch {
      // A provider may have accepted the post before the response failed. Keep the claim for review.
      const uncertain = await prisma.publishPost.update({
        where: { id }, data: { errorMessage: 'The provider did not confirm submission. Check the destination before retrying.' },
      });
      return { post: uncertain, dispatched: true };
    }
  }

  const dispatch = await dispatchSocialPublish({
    platform: post.platform,
    accountHandle: post.socialAccount.accountHandle,
    encryptedToken: post.socialAccount.encryptedToken,
    captionText: post.captionText,
    idempotencyKey: post.idempotencyKey,
    mediaUrl,
    durationSec: clip.durationSec,
  });
  const updated = await prisma.publishPost.update({
    where: { id },
    data: dispatch.success
      ? { status: dispatch.status, executionMode: dispatch.executionMode, externalPostId: dispatch.externalPostId ?? null, publishedAt: dispatch.status === 'PUBLISHED_SANDBOX' ? new Date() : null }
      : { status: dispatch.needsReconciliation ? 'PUBLISHING' : 'FAILED', executionMode: dispatch.executionMode, errorMessage: dispatch.errorMessage ?? 'Publishing failed.' },
  });
  return { post: updated, dispatched: true };
}

export async function reconcileSubmittedPosts(prisma: PrismaClient, workspaceId: string) {
  const submitted = await prisma.publishPost.findMany({
    where: { workspaceId, status: 'SUBMITTED', externalPostId: { not: null } },
    orderBy: { updatedAt: 'asc' }, take: 25,
  });
  if (!submitted.length) return;
  const legacy = [];
  for (const post of submitted) {
    if (!post.directProvider) {
      legacy.push(post);
      continue;
    }
    const current = await prisma.socialAccount.findUnique({ where: { id: post.socialAccountId } });
    const encrypted = current?.encryptedToken;
    const direct = readDirectCredential(encrypted ?? null);
    const where = { id: post.id, workspaceId, status: 'SUBMITTED' };
    if (!direct || !encrypted || direct.provider !== post.directProvider) {
      await prisma.publishPost.updateMany({ where, data: { errorMessage: 'Reconnect the original destination to confirm publication.' } });
      continue;
    }
    try {
      const refreshed = await refreshAccount(prisma, post.socialAccountId, encrypted, direct);
      const status = await getDirectVideoStatus(refreshed, post.externalPostId!);
      if (status === 'finish-instagram') {
        const claim = await prisma.publishPost.updateMany({ where, data: { status: 'PUBLISHING' } });
        if (!claim.count) continue;
        try {
          const id = await finishInstagramVideo(refreshed, post.externalPostId!);
          await prisma.publishPost.update({ where: { id: post.id }, data: { status: 'PUBLISHED_LIVE', externalPostId: id, publishedAt: new Date() } });
        } catch {
          await prisma.publishPost.update({ where: { id: post.id }, data: { errorMessage: 'Instagram publication needs reconciliation.' } });
        }
      } else {
        await prisma.publishPost.updateMany({
          where,
          data: status === 'published' ? { status: 'PUBLISHED_LIVE', publishedAt: new Date(), errorMessage: null }
            : status === 'failed' ? { status: 'FAILED', errorMessage: 'The destination reported a publishing failure.' }
              : { updatedAt: new Date(), ...(status === 'inbox' ? { errorMessage: 'Open your TikTok inbox to finish publishing.' } : {}) },
        });
      }
    } catch {
      await prisma.publishPost.updateMany({
        where, data: { updatedAt: new Date(), errorMessage: 'Could not check the destination. The worker will retry.' },
      });
    }
  }
  if (!legacy.length) return;
  const startDate = new Date(Math.min(...legacy.map((post) => post.createdAt.getTime())) - 60_000);
  const states = new Map((await listPostizPostStates(startDate)).map((post) => [post.id, post]));
  for (const post of legacy) {
    const state = states.get(post.externalPostId!);
    const where = { id: post.id, workspaceId, status: 'SUBMITTED' };
    if (state?.state === 'PUBLISHED' && state.releaseURL?.startsWith('https://')) {
      const publishedAt = new Date(state.publishDate ?? '');
      await prisma.publishPost.updateMany({
        where, data: { status: 'PUBLISHED_LIVE', publishedAt: Number.isNaN(publishedAt.getTime()) ? new Date() : publishedAt },
      });
    } else if (state?.state === 'ERROR') {
      await prisma.publishPost.updateMany({ where, data: { status: 'FAILED', errorMessage: 'Postiz reported a publishing failure.' } });
    } else {
      await prisma.publishPost.updateMany({ where, data: { updatedAt: new Date() } });
    }
  }
}
