import type { PrismaClient } from '@prisma/client';
import { isCreatorPlatformUrl } from '../integrations/source-connector.js';

export type ChannelProfile = { avatarUrl: string | null; displayName: string | null };

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.8',
  // Skips YouTube's cookie consent interstitial in regions that show it.
  Cookie: 'SOCS=CAI; CONSENT=YES+',
};

const PROFILE_HOSTS: Record<string, RegExp> = {
  YOUTUBE: /(^|\.)youtube\.com$/,
  TWITCH: /(^|\.)twitch\.tv$/,
  KICK: /(^|\.)kick\.com$/,
};

function httpsImage(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.replace(/&amp;/g, '&'));
    return url.protocol === 'https:' && !url.username && !url.password && url.href.length < 2000 ? url.href : null;
  } catch { return null; }
}

function metaContent(html: string, property: string) {
  const tag = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]*>`, 'i'))?.[0];
  return tag?.match(/content=["']([^"']*)["']/i)?.[1] ?? null;
}

function decodeEntities(text: string) {
  return text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

async function readPage(url: string, platform: string) {
  const response = await fetch(url, { headers: BROWSER_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(10_000) });
  // Only trust pages that stayed on the platform after redirects.
  if (!response.ok || !PROFILE_HOSTS[platform]!.test(new URL(response.url).hostname)) {
    await response.body?.cancel();
    return null;
  }
  return (await response.text()).slice(0, 3_000_000);
}

/**
 * The channel's public profile photo and name, read from the platform's own channel page (YouTube,
 * Twitch) or public channel API (Kick). Returns nulls when the platform does not answer.
 */
export async function fetchChannelProfile(platform: string, channelUrl: string): Promise<ChannelProfile> {
  const empty = { avatarUrl: null, displayName: null };
  if (!PROFILE_HOSTS[platform] || !isCreatorPlatformUrl(platform, channelUrl)) return empty;
  try {
    if (platform === 'KICK') {
      const slug = new URL(channelUrl).pathname.split('/').filter(Boolean)[0];
      if (!slug || !/^[\w-]{2,40}$/.test(slug)) return empty;
      const response = await fetch(`https://kick.com/api/v2/channels/${slug}`, {
        headers: { ...BROWSER_HEADERS, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return empty;
      const data = await response.json() as { user?: { username?: string; profile_pic?: string } };
      return { avatarUrl: httpsImage(data.user?.profile_pic), displayName: data.user?.username?.slice(0, 100) || null };
    }
    const html = await readPage(channelUrl, platform);
    if (!html) return empty;
    const title = metaContent(html, 'og:title');
    return {
      avatarUrl: httpsImage(metaContent(html, 'og:image')),
      displayName: title ? decodeEntities(title).replace(/\s+-\s+Twitch$/i, '').trim().slice(0, 100) || null : null,
    };
  } catch {
    return empty;
  }
}

/** Saves the channel's profile photo. Errors are swallowed: a missing photo never blocks clipping. */
export async function refreshCreatorProfile(prisma: Pick<PrismaClient, 'creatorAccount'>, creator: { id: string; platform: string; channelUrl: string }) {
  const profile = await fetchChannelProfile(creator.platform, creator.channelUrl);
  if (!profile.avatarUrl) return null;
  await prisma.creatorAccount.update({ where: { id: creator.id }, data: { avatarUrl: profile.avatarUrl } }).catch(() => null);
  return profile;
}
