import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ParsedFeedVideo } from '../integrations/scheduler.js';
import { isCreatorPlatformUrl } from '../integrations/source-connector.js';
import { discoverYouTubeReplays } from './youtube-source.js';

const run = promisify(execFile);

export type RecordingPlatform = 'YOUTUBE' | 'TWITCH' | 'KICK';

const python = () => process.env['YOUTUBE_SOURCE_PYTHON'] || 'python3';
// Missing fields print as JSON null instead of yt-dlp's default "NA", which is not valid JSON.
const ytDlp = ['-m', 'yt_dlp', '--ignore-config', '--socket-timeout', '15', '--retries', '1', '--no-warnings',
  '--output-na-placeholder', 'null'];

/** The channel slug from a Twitch or Kick channel URL, e.g. https://www.twitch.tv/nasa -> "nasa". */
export function channelSlug(platform: 'TWITCH' | 'KICK', channelUrl: string): string | null {
  if (!isCreatorPlatformUrl(platform, channelUrl)) return null;
  const match = new URL(channelUrl).pathname.match(/^\/([A-Za-z0-9_-]{2,40})(?:\/(?:videos)?)?\/?$/);
  return match ? match[1]!.toLowerCase() : null;
}

/** Listing and live URLs for a channel. Kept separate so they can be tested without the network. */
export function recordingUrls(platform: 'TWITCH' | 'KICK', slug: string) {
  return platform === 'TWITCH'
    ? { list: `https://www.twitch.tv/${slug}/videos?filter=archives&sort=time`, live: `https://www.twitch.tv/${slug}` }
    : { list: `https://kick.com/${slug}/videos`, live: `https://kick.com/${slug}` };
}

/** An https thumbnail URL from a listing, with Twitch's size placeholders filled in. */
function listingThumbnail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const filled = raw.replace('%{width}', '640').replace('%{height}', '360').replace('{width}', '640').replace('{height}', '360');
  try {
    const url = new URL(filled);
    return url.protocol === 'https:' && !url.username && !url.password && filled.length < 2000 ? url.href : null;
  } catch { return null; }
}

/**
 * Parse one `--print` line from a flat channel listing. Kick URLs carry a yt-dlp fragment that is
 * stripped so the stored URL is the plain public VOD page.
 */
export function parseListingLine(platform: 'TWITCH' | 'KICK', slug: string, line: string): ParsedFeedVideo | null {
  if (!line.startsWith('[')) return null;
  let id: unknown, title: string | null, timestamp: number | null, thumbnail: unknown;
  try {
    // yt-dlp log lines also start with "[" (e.g. "[download] ..."); only our printed JSON arrays parse.
    [id, title, timestamp, thumbnail] = JSON.parse(line) as [unknown, string | null, number | null, unknown];
  } catch {
    return null;
  }
  if (typeof id !== 'string') return null;
  const valid = platform === 'TWITCH' ? /^v\d{5,15}$/.test(id) : /^[0-9a-f-]{36}$/.test(id);
  if (!valid) return null;
  const videoUrl = platform === 'TWITCH'
    ? `https://www.twitch.tv/videos/${id.slice(1)}`
    : `https://kick.com/${slug}/videos/${id}`;
  return {
    externalVideoId: id, videoUrl, title: (title || `${slug} broadcast`).slice(0, 300), streamStatus: 'REPLAY',
    publishedAt: new Date(typeof timestamp === 'number' ? timestamp * 1000 : Date.now()),
    thumbnailUrl: listingThumbnail(thumbnail),
  };
}

/**
 * Run a yt-dlp channel listing. Exit code 101 means `--break-match-filters` stopped at the cursor, which
 * is the normal "caught up" outcome, so its output is returned rather than treated as a failure.
 */
export async function runListing(args: string[], timeout = 90_000) {
  try {
    return (await run(python(), args, { timeout, maxBuffer: 4 * 1024 * 1024 })).stdout;
  } catch (error) {
    const failed = error as { code?: number; stdout?: string };
    if (failed.code === 101 && typeof failed.stdout === 'string') return failed.stdout;
    throw error;
  }
}

/** True while the channel is broadcasting. yt-dlp reports an offline channel as an error. */
async function isLive(url: string) {
  try {
    const { stdout } = await run(python(), [...ytDlp, '--skip-download', '--print', '%(is_live)j', url],
      { timeout: 60_000, maxBuffer: 64 * 1024 });
    return stdout.trim().split(/\r?\n/).at(-1) === 'true';
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? '');
    if (/not currently live|is offline|not live/i.test(stderr)) return false;
    throw error;
  }
}

/**
 * Newest-first recordings for a tagged channel on any supported platform. With a cursor, listing stops
 * at the last recording already seen, so missed uploads are caught up after downtime.
 *
 * Twitch and Kick: the archive being recorded during a live broadcast is listed first, so while the
 * channel is live that entry is reported as LIVE and only becomes a REPLAY once the broadcast ends.
 */
export async function discoverRecordings(platform: string, channelUrl: string, cursor?: string | null): Promise<ParsedFeedVideo[]> {
  if (platform === 'YOUTUBE') return discoverYouTubeReplays(channelUrl, cursor);
  if (platform !== 'TWITCH' && platform !== 'KICK') return [];
  const slug = channelSlug(platform, channelUrl);
  if (!slug) throw new Error(`Use a ${platform === 'TWITCH' ? 'twitch.tv' : 'kick.com'} channel URL.`);
  const urls = recordingUrls(platform, slug);
  const knownCursor = cursor && (platform === 'TWITCH' ? /^v\d{5,15}$/ : /^[0-9a-f-]{36}$/).test(cursor) ? cursor : null;
  const [stdout, live] = await Promise.all([
    runListing([...ytDlp, '--flat-playlist',
      ...(knownCursor ? ['--break-match-filters', `id != ${knownCursor}`, '--playlist-end', '50'] : ['--playlist-end', '15']),
      '--print', '[%(id)j,%(title)j,%(timestamp)j,%(thumbnail)j]', urls.list]),
    isLive(urls.live),
  ]);
  const videos = stdout.trim().split(/\r?\n/).flatMap(line => {
    const parsed = parseListingLine(platform, slug, line.trim());
    return parsed ? [parsed] : [];
  });
  if (live && videos[0]) videos[0] = { ...videos[0], streamStatus: 'LIVE' };
  return videos;
}
