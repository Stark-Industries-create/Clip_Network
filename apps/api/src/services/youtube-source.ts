import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { ParsedFeedVideo } from '../integrations/scheduler.js';

const run = promisify(execFile);

export async function discoverYouTubeReplays(channelUrl: string, cursor?: string | null): Promise<ParsedFeedVideo[]> {
  const channel = new URL(channelUrl);
  if (channel.protocol !== 'https:' || !['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(channel.hostname) ||
    channel.username || channel.password || channel.port) return [];
  const path = channel.pathname.match(/^(\/(?:@[^/]+|channel\/UC[\w-]+))(?:\/(streams|videos))?\/?$/);
  if (!path) return [];
  const url = new URL(`${path[1]}/${path[2] || 'videos'}`, 'https://www.youtube.com').href;
  // Exit code 101 means --break-match-filters stopped at the cursor: caught up, not a failure.
  const stdout = await run(process.env['YOUTUBE_SOURCE_PYTHON'] || 'python3', [
    '-m', 'yt_dlp', '--ignore-config', '--js-runtimes', 'node', '--flat-playlist', ...(cursor && /^[\w-]{11}$/.test(cursor)
      ? ['--break-match-filters', `id != ${cursor}`] : ['--playlist-end', '15']),
    '--socket-timeout', '10', '--retries', '0', '--no-warnings', '--output-na-placeholder', 'null',
    '--print', '[%(id)j,%(live_status)j,%(title)j,%(timestamp)j]', url,
  ], { timeout: 90_000, maxBuffer: 4 * 1024 * 1024 }).then(result => result.stdout, (error: { code?: number; stdout?: string }) => {
    if (error.code === 101 && typeof error.stdout === 'string') return error.stdout;
    throw error;
  });
  return stdout.trim().split(/\r?\n/).flatMap((line) => {
    if (!line.startsWith('[')) return [];
    const [id, status, title, timestamp] = JSON.parse(line) as [string, string, string, number | null];
    if (!/^[\w-]{11}$/.test(id) || !title || status === 'is_upcoming' ||
      (path[2] === 'streams' && !['is_live', 'post_live', 'was_live'].includes(status))) return [];
    const streamStatus = status === 'is_live' ? 'LIVE' : status === 'post_live' ? 'FINALIZING' : 'REPLAY';
    return [{ externalVideoId: id, videoUrl: `https://www.youtube.com/watch?v=${id}`,
      title, streamStatus, publishedAt: new Date(typeof timestamp === 'number' ? timestamp * 1000 : Date.now()) }];
  });
}

/**
 * Read scene changes, pause ends and loud audio moments from one FFmpeg analysis pass.
 * Times are converted from chunk-relative to recording seconds.
 */
export function readRecordingSignals(log: string, start: number, end: number) {
  const scenes: number[] = [];
  const pauses: number[] = [];
  const levels: { t: number; db: number }[] = [];
  let pendingLevelTime: number | undefined;
  for (const line of log.split(/\r?\n/)) {
    if (line.includes('Parsed_showinfo')) {
      const match = /pts_time:([0-9.]+)/.exec(line);
      if (match) scenes.push(start + Number(match[1]));
    } else if (line.includes('Parsed_ametadata')) {
      const time = /pts_time:([0-9.]+)/.exec(line);
      if (time) pendingLevelTime = Number(time[1]);
      const level = /RMS_level=(-?inf|-?[0-9.]+)/.exec(line);
      if (level && pendingLevelTime !== undefined) {
        levels.push({ t: start + pendingLevelTime, db: /inf/.test(level[1]!) ? -120 : Number(level[1]) });
        pendingLevelTime = undefined;
      }
    } else {
      const match = /silence_end: ([0-9.]+)/.exec(line);
      if (match) pauses.push(start + Number(match[1]));
    }
  }
  const sorted = levels.map(level => level.db).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? -120;
  const peaks: number[] = [];
  for (const [i, level] of levels.entries()) {
    const louder = level.db >= median + 9 && level.db > -30 &&
      level.db >= (levels[i - 1]?.db ?? -Infinity) && level.db > (levels[i + 1]?.db ?? -Infinity);
    if (louder && level.t - (peaks.at(-1) ?? -Infinity) >= 4) peaks.push(level.t);
  }
  const inRange = (t: number) => Number.isFinite(t) && t >= start && t <= end;
  return {
    beats: [...scenes, ...pauses].filter(inRange).sort((a, b) => a - b),
    peaks: peaks.filter(inRange),
    scenes: scenes.filter(inRange),
  };
}

/** Check the worker's media tools. Without a local model (hosted transcription only), whisper is not needed. */
export async function checkYouTubeSourceTools(modelPath?: string) {
  const python = process.env['YOUTUBE_SOURCE_PYTHON'] || 'python3';
  if (!modelPath) {
    await Promise.all([run(python, ['-m', 'yt_dlp', '--version'], { timeout: 10_000 }), run('ffmpeg', ['-version'], { timeout: 10_000 })]);
    return;
  }
  await access(modelPath);
  const cli = process.env['YOUTUBE_WHISPER_CLI']?.trim();
  if (cli) {
    const vad = process.env['YOUTUBE_WHISPER_VAD_MODEL']?.trim();
    if (!vad) throw new Error('YOUTUBE_WHISPER_VAD_MODEL is required with whisper-cli');
    await access(vad);
  }
  const [, { stdout }] = await Promise.all([
    run(python, ['-m', 'yt_dlp', '--version'], { timeout: 10_000 }),
    cli ? run(cli, ['--help'], { timeout: 10_000 }) : run('ffmpeg', ['-hide_banner', '-filters'], { timeout: 10_000 }),
  ]);
  if (!cli && !/\bwhisper\s+A->A\b/.test(stdout)) throw new Error('Configure whisper-cli or an FFmpeg build with the whisper filter');
}
