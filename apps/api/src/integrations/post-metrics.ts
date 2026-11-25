import { bearer, META_VERSION, providerRequest, type DirectCredential } from './direct-social.js';

/** Engagement read from the destination platform itself. Fields a platform does not report stay undefined. */
export interface LiveMetrics {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  watchTimeAvgSec?: number;
}

/** The account's authorization does not include analytics; the user must reconnect it once. */
export class MetricsPermissionError extends Error {}

const count = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
};

export function parseYouTubeStatistics(body: unknown): LiveMetrics | null {
  const stats = (body as { items?: { statistics?: Record<string, unknown> }[] })?.items?.[0]?.statistics;
  if (!stats) return null;
  return { views: count(stats['viewCount']), likes: count(stats['likeCount']), comments: count(stats['commentCount']), shares: 0 };
}

/** Meta insights: `data: [{ name, values: [{ value }] }]` or `{ name, total_value: { value } }`. */
function metaValues(body: unknown) {
  const rows = (body as { data?: { name?: string; values?: { value?: unknown }[]; total_value?: { value?: unknown } }[] })?.data ?? [];
  const values = new Map<string, unknown>();
  for (const row of rows) {
    if (row.name) values.set(row.name, row.total_value?.value ?? row.values?.at(-1)?.value);
  }
  return values;
}

export function parseInstagramInsights(body: unknown): LiveMetrics {
  const v = metaValues(body);
  return { views: count(v.get('views') ?? v.get('plays')), likes: count(v.get('likes')), comments: count(v.get('comments')), shares: count(v.get('shares')) };
}

export function parseFacebookReelInsights(body: unknown): LiveMetrics {
  const v = metaValues(body);
  const reactions = v.get('post_video_likes_by_reaction_type');
  const social = v.get('post_video_social_actions') as Record<string, unknown> | undefined;
  const avgMs = Number(v.get('post_video_avg_time_watched'));
  return {
    views: count(v.get('blue_reels_play_count') ?? v.get('fb_reels_total_plays')),
    likes: reactions && typeof reactions === 'object' ? Object.values(reactions).reduce<number>((sum, n) => sum + count(n), 0) : 0,
    comments: count(social?.['COMMENT'] ?? social?.['comment']),
    shares: count(social?.['SHARE'] ?? social?.['share']),
    ...(Number.isFinite(avgMs) && avgMs > 0 ? { watchTimeAvgSec: Math.round(avgMs / 100) / 10 } : {}),
  };
}

export function parseTikTokVideoQuery(body: unknown): LiveMetrics | null {
  const video = (body as { data?: { videos?: Record<string, unknown>[] } })?.data?.videos?.[0];
  if (!video) return null;
  return { views: count(video['view_count']), likes: count(video['like_count']), comments: count(video['comment_count']), shares: count(video['share_count']) };
}

export function parseXPublicMetrics(body: unknown): LiveMetrics | null {
  const metrics = (body as { data?: { public_metrics?: Record<string, unknown> } })?.data?.public_metrics;
  if (!metrics) return null;
  return {
    views: count(metrics['impression_count']), likes: count(metrics['like_count']), comments: count(metrics['reply_count']),
    shares: count(metrics['retweet_count']) + count(metrics['quote_count']),
  };
}

/** Provider requests that fail for missing permissions become MetricsPermissionError. */
async function request<T>(url: string, init: RequestInit = {}) {
  try {
    return await providerRequest<T>(url, init);
  } catch (error) {
    if (error instanceof Error && /HTTP (401|403)\b|rejected the request/.test(error.message)) {
      throw new MetricsPermissionError('Reconnect this account to allow analytics.');
    }
    throw error;
  }
}

/**
 * Current engagement for a post published through a direct connection. `externalPostId` is what
 * publishing stored: the Instagram media ID, the YouTube or Facebook video ID, or a TikTok publish ID
 * (resolved here to the public video ID). Returns null while the platform has nothing to report yet.
 */
export async function fetchDirectMetrics(credential: DirectCredential, externalPostId: string): Promise<LiveMetrics | null> {
  const id = encodeURIComponent(externalPostId);
  const headers = bearer(credential.accessToken);
  switch (credential.provider) {
    case 'youtube':
      return parseYouTubeStatistics(await request(`https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${id}`, { headers }));
    case 'instagram':
      return parseInstagramInsights(await request(
        `https://graph.instagram.com/${META_VERSION}/${id}/insights?metric=views,likes,comments,shares&period=lifetime`, { headers }));
    case 'facebook':
      return parseFacebookReelInsights(await request(
        `https://graph.facebook.com/${META_VERSION}/${id}/video_insights?metric=blue_reels_play_count,post_video_likes_by_reaction_type,post_video_social_actions,post_video_avg_time_watched`,
        { headers }));
    case 'tiktok': {
      // Inbox uploads return a publish ID; the public video ID appears once the creator posts it.
      const status = await request<{ data?: { publicaly_available_post_id?: (string | number)[] } }>(
        'https://open.tiktokapis.com/v2/post/publish/status/fetch/',
        { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ publish_id: externalPostId }) });
      const videoId = status.data?.publicaly_available_post_id?.[0];
      if (videoId === undefined) return null;
      return parseTikTokVideoQuery(await request(
        'https://open.tiktokapis.com/v2/video/query/?fields=id,view_count,like_count,comment_count,share_count',
        { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ filters: { video_ids: [String(videoId)] } }) }));
    }
    case 'x':
      return parseXPublicMetrics(await request(`https://api.x.com/2/tweets/${id}?tweet.fields=public_metrics`, { headers }));
  }
}
