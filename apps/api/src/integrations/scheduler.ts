import type { PrismaClient } from '@prisma/client';

export interface ParsedFeedVideo {
  externalVideoId: string;
  title: string;
  videoUrl: string;
  publishedAt: Date;
  streamStatus?: 'LIVE' | 'FINALIZING' | 'REPLAY';
  thumbnailUrl?: string | null;
}

/** Parses usable entries from a public YouTube Atom feed in feed order. */
export function parseYouTubeAtomVideos(xml: string): ParsedFeedVideo[] {
  const videos = new Map<string, ParsedFeedVideo>();
  for (const [, entry = ''] of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
    const videoId = entry.match(/<yt:videoId>([\w-]{11})<\/yt:videoId>/i)?.[1];
    const title = entry.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim();
    const publication = entry.match(/<published>([^<]+)<\/published>/i)?.[1];
    const publishedAt = new Date(publication ?? '');
    if (!videoId || !title || Number.isNaN(publishedAt.getTime()) || videos.has(videoId)) continue;
    videos.set(videoId, {
      externalVideoId: videoId,
      title,
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
      publishedAt,
    });
  }
  return [...videos.values()];
}

export function parseYouTubeAtomLatestVideo(xml: string): ParsedFeedVideo | null {
  return parseYouTubeAtomVideos(xml)[0] ?? null;
}

/** Returns null when the channel URL is unsupported or the feed could not be read. */
export async function tryFetchYouTubeChannelVideos(channelUrl: string): Promise<ParsedFeedVideo[] | null> {
  try {
    const url = new URL(channelUrl);
    if (!['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) return null;
    let channelId = url.pathname.match(/^\/channel\/(UC[\w-]+)\/?$/)?.[1];
    if (!channelId) {
      const handle = url.pathname.match(/^\/(@[^/]+)(?:\/(?:streams|videos))?\/?$/)?.[1];
      if (!handle) return null;
      const page = await fetch(new URL(`/${handle}`, 'https://www.youtube.com'), {
        signal: AbortSignal.timeout(8_000), redirect: 'error',
      });
      if (!page.ok) return null;
      const html = await page.text();
      channelId = html.match(/<meta\s+itemprop="channelId"\s+content="(UC[\w-]{22})"/i)?.[1] ??
        html.match(/"externalId"\s*:\s*"(UC[\w-]{22})"/)?.[1];
    }
    if (!channelId) return null;
    const feedUrl = new URL('https://www.youtube.com/feeds/videos.xml');
    feedUrl.searchParams.set('channel_id', channelId);
    const res = await fetch(feedUrl, { signal: AbortSignal.timeout(5_000), redirect: 'error' });
    if (!res.ok) return null;
    const xml = await res.text();
    if (!/<feed\b[^>]*>/i.test(xml) || !/<\/feed>\s*$/i.test(xml)) return null;
    return parseYouTubeAtomVideos(xml);
  } catch {
    return null;
  }
}

/**
 * Starts a safe, non-overlapping background channel monitor interval.
 * Disabled automatically when NODE_ENV === 'test' or CHANNEL_MONITOR_INTERVAL_MS === '0'.
 */
export function startBackgroundMonitorScheduler(
  prisma: PrismaClient,
  onTickWorkspace: (workspaceId: string) => Promise<void>,
  syncConnector?: () => Promise<void>,
  onSuccessfulTick?: () => Promise<void>,
): () => Promise<void> {
  if (process.env['NODE_ENV'] === 'test') return async () => {};
  const intervalMs = Number(process.env['CHANNEL_MONITOR_INTERVAL_MS'] ?? 300_000);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return async () => {};

  let activeTick: Promise<void> | undefined;
  let stopping = false;
  const tick = async () => {
    let successful = true;
    try {
      if (syncConnector) {
        try {
          await syncConnector();
        } catch (error) {
          successful = false;
          console.error('Source connector sync failed', error instanceof Error ? error.name : 'UnknownError');
        }
      }
      const workspaces = await prisma.workspace.findMany({
        where: { OR: [{ creators: { some: { autoMonitorEnabled: true } } }, { publishPosts: { some: { status: 'SUBMITTED' } } }] },
        select: { id: true },
      });
      // Listing channels is network-bound, so a few workspaces are scanned at once.
      const width = Math.min(16, Math.max(1, Number(process.env['DISCOVERY_CONCURRENCY'] ?? 4) || 4));
      const queue = [...workspaces];
      await Promise.all(Array.from({ length: Math.min(width, queue.length) }, async () => {
        for (let ws = queue.shift(); ws && !stopping; ws = queue.shift()) {
          try {
            await onTickWorkspace(ws.id);
          } catch (error) {
            successful = false;
            console.error('Workspace monitor failed', ws.id, error instanceof Error ? error.name : 'UnknownError');
          }
        }
      }));
      if (stopping) return;
      if (successful && !stopping) await onSuccessfulTick?.();
    } catch (error) {
      console.error('Channel monitor tick failed', error instanceof Error ? error.name : 'UnknownError');
    }
  };
  const launch = () => {
    if (!stopping && !activeTick) {
      activeTick = tick().finally(() => { activeTick = undefined; });
    }
  };
  const timer = setInterval(launch, Math.max(30_000, intervalMs));
  if (syncConnector || onSuccessfulTick) launch();

  return async () => {
    stopping = true;
    clearInterval(timer);
    await activeTick;
  };
}
