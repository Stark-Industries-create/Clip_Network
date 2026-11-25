import { Prisma, type PrismaClient } from '@prisma/client';
import { tryFetchYouTubeChannelVideos, type ParsedFeedVideo } from '../integrations/scheduler.js';
import { refreshCreatorProfile } from './channel-profile.js';

export interface ChannelScanResult {
  creatorsScanned: number;
  unavailableChannels: string[];
  unsupportedChannels: number;
  detectedVideos: unknown[];
  clipsCreated: number;
  postsRouted: number;
}

export async function scanWorkspaceChannels(params: {
  prisma: PrismaClient;
  workspaceId: string;
  userId?: string;
  creatorId?: string;
  /** Lists a channel's recordings on YouTube, Twitch or Kick (see services/recording-sources.ts). */
  discoverReplays?: (platform: string, channelUrl: string, cursor?: string | null) => Promise<ParsedFeedVideo[]>;
  /** True when an external recording connector delivers this workspace's Twitch and Kick recordings. */
  connectorManaged?: boolean;
  trackConversion?: (eventName: string, workspaceId?: string, metadata?: unknown) => Promise<void>;
  logAudit?: (
    action: string,
    entityType: string,
    entityId: string,
    details: unknown,
    workspaceId?: string,
    userId?: string,
  ) => Promise<void>;
}): Promise<ChannelScanResult | null> {
  const { prisma, workspaceId, userId, creatorId } = params;
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } });
  if (!workspace) return null;

  const creators = await prisma.creatorAccount.findMany({
    where: {
      workspaceId,
      ...(creatorId ? { id: creatorId } : { autoMonitorEnabled: true }),
    },
  });

  const detectedVideos: unknown[] = [];
  const unavailableChannels: string[] = [];
  let creatorsScanned = 0;
  let unsupportedChannels = 0;
  for (const creator of creators) {
    // Fill in a missing channel photo in the background; it never delays discovery.
    if (!creator.avatarUrl && process.env['NODE_ENV'] !== 'test') void refreshCreatorProfile(prisma, creator).catch(() => null);
    const reportAccess = (sourceAccessError: string | null) => prisma.creatorAccount.update({
      where: { id: creator.id }, data: { sourceAccessError, sourceAccessCheckedAt: new Date() },
    });
    const youtube = creator.platform === 'YOUTUBE';
    if (!youtube && !params.discoverReplays) {
      unsupportedChannels++;
      // Without the worker's recording discovery, Twitch and Kick can only arrive through a connector.
      await reportAccess(params.connectorManaged ? null
        : `Recording discovery for ${creator.platform === 'KICK' ? 'Kick' : 'Twitch'} runs in the worker. Retry after it starts.`);
      continue;
    }
    let videos: ParsedFeedVideo[] | null = null;
    let replayDiscoverySucceeded = false;
    let discoveryError = '';
    if (params.discoverReplays) {
      try {
        videos = await params.discoverReplays(creator.platform, creator.channelUrl, creator.discoveryCursor);
        replayDiscoverySucceeded = true;
      } catch (error) {
        discoveryError = error instanceof Error && /channel URL/.test(error.message) ? error.message : '';
        console.warn('Replay discovery unavailable', creator.id);
      }
    }
    // The public upload feed only exists for YouTube.
    if (youtube) videos ??= await tryFetchYouTubeChannelVideos(creator.channelUrl);
    if (!videos) {
      unavailableChannels.push(creator.displayName);
      await reportAccess(discoveryError || 'Could not read the recordings for this channel. Check the channel URL, then retry.');
      continue;
    }
    creatorsScanned++;
    const newestReplay = videos.find(video => !video.streamStatus || video.streamStatus === 'REPLAY');
    const firstWorkerScan = replayDiscoverySucceeded && !creator.discoveryCursor;

    const existing = await prisma.channelVideo.findMany({
      where: { creatorId: creator.id, externalVideoId: { in: videos.map((video) => video.externalVideoId) } },
      select: { id: true, externalVideoId: true, detectionStatus: true },
    });
    const known = new Map(existing.map((video) => [video.externalVideoId, video]));

    for (const video of videos) {
      const { streamStatus, ...metadata } = video;
      const detectionStatus = streamStatus === 'LIVE' || streamStatus === 'FINALIZING' ? streamStatus : 'DETECTED';
      const previous = known.get(video.externalVideoId);
      if (previous) {
        if (streamStatus && ['LIVE', 'FINALIZING', 'DETECTED'].includes(previous.detectionStatus) &&
          previous.detectionStatus !== detectionStatus) {
          await prisma.channelVideo.updateMany({
            where: { id: previous.id, clipJobId: null, detectionStatus: previous.detectionStatus },
            data: { detectionStatus, nextAutomationAttemptAt: null },
          });
        }
        continue;
      }
      const created = await prisma.channelVideo.create({
        data: {
          ...metadata,
          // YouTube thumbnails follow a fixed URL; Twitch and Kick listings report their own.
          thumbnailUrl: metadata.thumbnailUrl ?? (youtube ? `https://i.ytimg.com/vi/${encodeURIComponent(video.externalVideoId)}/mqdefault.jpg` : null),
          workspaceId,
          creatorId: creator.id,
          durationSec: 0,
          detectionSource: !replayDiscoverySucceeded ? 'YOUTUBE_ATOM_FEED' : `${creator.platform}_REPLAY_MONITOR`,
          detectionStatus: firstWorkerScan && detectionStatus === 'DETECTED' && video !== newestReplay ? 'SKIPPED' : detectionStatus,
        },
      }).catch((error: unknown) => {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return null;
        throw error;
      });
      if (!created) continue;
      detectedVideos.push({ ...created, creator });
      await params.trackConversion?.('VIDEO_DETECTED', workspaceId, {
        platform: creator.platform,
        source: created.detectionSource,
      });
    }

    await prisma.creatorAccount.update({
      where: { id: creator.id },
      data: {
        lastPolledAt: new Date(), sourceAccessCheckedAt: new Date(),
        sourceAccessError: params.discoverReplays && !replayDiscoverySucceeded
          ? 'Replay discovery failed, so only recent uploads were checked. Retry to catch up.' : null,
        ...(replayDiscoverySucceeded && newestReplay ? { discoveryCursor: newestReplay.externalVideoId } : {}) },
    });
  }

  if (params.logAudit) {
    await params.logAudit(
      'CHANNEL_MONITOR_SCAN_COMPLETED',
      'Workspace',
      workspaceId,
      {
        creatorsScanned,
        videosDetected: detectedVideos.length,
      },
      workspaceId,
      userId,
    );
  }

  return {
    creatorsScanned,
    unavailableChannels,
    unsupportedChannels,
    detectedVideos,
    clipsCreated: 0,
    postsRouted: 0,
  };
}
