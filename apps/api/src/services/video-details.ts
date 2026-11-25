/**
 * Public statistics for a detected recording, for the creator video browser. YouTube uses the Data API
 * when a key is configured (YOUTUBE_API_KEY, settable in the Control Center) and otherwise reads the
 * public watch page. Twitch and Kick have no keyless statistics API, so only stored details are shown.
 */
export type SourceVideoStats = {
  source: 'YOUTUBE_DATA_API' | 'YOUTUBE_PAGE';
  views: number | null;
  likes: number | null;
  comments: number | null;
  durationSec: number | null;
  publishedAt: string | null;
  channelTitle: string | null;
  description: string | null;
};

const cache = new Map<string, { at: number; stats: SourceVideoStats | null }>();
const CACHE_MS = 30 * 60_000;

function count(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number(value.replace(/[^\d]/g, '')) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
}

/** ISO 8601 durations such as PT1H2M3S. */
export function isoDurationSec(value: string | undefined): number | null {
  const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value ?? '');
  if (!match) return null;
  const [, d = '0', h = '0', m = '0', s = '0'] = match;
  return Number(d) * 86400 + Number(h) * 3600 + Number(m) * 60 + Number(s);
}

async function fromDataApi(id: string, key: string): Promise<SourceVideoStats | null> {
  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.search = new URLSearchParams({ part: 'snippet,statistics,contentDetails', id, key }).toString();
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) return null;
  const item = (await response.json() as { items?: {
    snippet?: { publishedAt?: string; channelTitle?: string; description?: string };
    statistics?: Record<string, string>; contentDetails?: { duration?: string };
  }[] }).items?.[0];
  if (!item) return null;
  return {
    source: 'YOUTUBE_DATA_API',
    views: count(item.statistics?.['viewCount']), likes: count(item.statistics?.['likeCount']),
    comments: count(item.statistics?.['commentCount']),
    durationSec: isoDurationSec(item.contentDetails?.duration), publishedAt: item.snippet?.publishedAt ?? null,
    channelTitle: item.snippet?.channelTitle ?? null, description: item.snippet?.description?.slice(0, 2000) ?? null,
  };
}

/** Reads the figures YouTube embeds in its own public watch page. */
export function parseWatchPage(html: string): SourceVideoStats | null {
  const views = /"viewCount":"(\d+)"/.exec(html)?.[1];
  if (!views) return null;
  const likes = /"likeCount":"(\d+)"/.exec(html)?.[1]
    ?? /"accessibilityText":"([\d,.]+) likes?"/i.exec(html)?.[1];
  const comments = /"commentCount":\{"simpleText":"([\d,.]+)"/.exec(html)?.[1];
  const length = /"lengthSeconds":"(\d+)"/.exec(html)?.[1];
  const published = /"publishDate":"([^"]+)"/.exec(html)?.[1] ?? /"uploadDate":"([^"]+)"/.exec(html)?.[1];
  const channel = /"ownerChannelName":"([^"]+)"/.exec(html)?.[1];
  return {
    source: 'YOUTUBE_PAGE', views: count(views), likes: count(likes), comments: count(comments),
    durationSec: count(length), publishedAt: published ?? null, channelTitle: channel ?? null, description: null,
  };
}

async function fromWatchPage(id: string): Promise<SourceVideoStats | null> {
  const response = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(id)}&hl=en`, {
    headers: { 'Accept-Language': 'en-US,en;q=0.8', Cookie: 'SOCS=CAI; CONSENT=YES+' },
    redirect: 'follow', signal: AbortSignal.timeout(10_000),
  });
  // After redirects the page must still be YouTube's (an empty url means no redirect happened).
  if (!response.ok || (response.url && !/(^|\.)youtube\.com$/.test(new URL(response.url).hostname))) {
    await response.body?.cancel();
    return null;
  }
  return parseWatchPage((await response.text()).slice(0, 4_000_000));
}

export async function fetchSourceVideoStats(platform: string, externalVideoId: string): Promise<SourceVideoStats | null> {
  if (platform !== 'YOUTUBE' || !/^[\w-]{11}$/.test(externalVideoId)) return null;
  const cached = cache.get(externalVideoId);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.stats;
  const key = process.env['YOUTUBE_API_KEY']?.trim();
  let stats: SourceVideoStats | null = null;
  try {
    stats = (key ? await fromDataApi(externalVideoId, key) : null) ?? await fromWatchPage(externalVideoId);
  } catch {
    stats = null;
  }
  cache.set(externalVideoId, { at: Date.now(), stats });
  if (cache.size > 2000) cache.delete(cache.keys().next().value!);
  return stats;
}

/** The platform's own embeddable player for a recording, when it has one. */
export function embedFor(platform: string, externalVideoId: string): { kind: 'YOUTUBE' | 'TWITCH'; id: string } | null {
  if (platform === 'YOUTUBE' && /^[\w-]{11}$/.test(externalVideoId)) return { kind: 'YOUTUBE', id: externalVideoId };
  if (platform === 'TWITCH' && /^v\d{5,15}$/.test(externalVideoId)) return { kind: 'TWITCH', id: externalVideoId.slice(1) };
  return null;
}
