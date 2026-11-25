import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ClipJob, Prisma, PrismaClient } from '@prisma/client';
import {
  alignTranscriptToSpeechWindows, buildWordSyncedAss, containsDevanagari, DEVANAGARI_CAPTION_FONT, renderVerticalShortWithSfx,
} from '@clip-network/clip-engine';
import { CreateCreatorRequestSchema, evaluateClipCompliance, type CaptionStyleId, type LayoutMode } from '@clip-network/shared';
import { buildTenantClipObjectKey, createPresignedS3Url, type S3StorageConfig } from '../integrations/storage.js';
import { transcribeSpeech } from './speech-timing.js';

export const MAX_SOURCE_BYTES = 250 * 1024 * 1024;
export const RENDER_LEASE_MS = 10 * 60_000;

async function detectFacecam(source: string, startSec: number, endSec: number) {
  const model = process.env['FACECAM_YUNET_MODEL']?.trim();
  if (!model) return undefined;
  try {
    const script = fileURLToPath(new URL('../../scripts/detect-facecam.py', import.meta.url));
    const { stdout } = await promisify(execFile)(process.env['YOUTUBE_SOURCE_PYTHON'] || 'python3',
      [script, model, source, String(startSec), String(endSec)], { timeout: 35_000, maxBuffer: 8192 });
    return CreateCreatorRequestSchema.shape.facecamCrop.parse(JSON.parse(stdout) ?? undefined);
  } catch {
    // Unavailable inference keeps the full source in view.
    return undefined;
  }
}

async function refreshSourceStatus(tx: Prisma.TransactionClient, clip: ClipJob, fallback: string) {
  if (!clip.sourceVideoId) {
    await tx.channelVideo.updateMany({ where: { workspaceId: clip.workspaceId, clipJobId: clip.id }, data: { detectionStatus: fallback } });
    return;
  }
  // Serialize sibling completions before reading their combined state.
  await tx.channelVideo.update({ where: { id: clip.sourceVideoId }, data: { detectionStatus: 'PROCESSING' } });
  const jobs = await tx.clipJob.findMany({ where: { sourceVideoId: clip.sourceVideoId }, select: { executionStatus: true } });
  const pending = jobs.some(job => ['QUEUED', 'RUNNING', 'PENDING'].includes(job.executionStatus));
  if (pending) return;
  const failed = jobs.some(job => job.executionStatus !== 'COMPLETED');
  await tx.channelVideo.update({ where: { id: clip.sourceVideoId }, data: { detectionStatus: failed ? 'NEEDS_REVIEW' : 'CLIPPED' } });
}

const fontChecks = new Map<string, Promise<boolean | null>>();

/**
 * Whether fontconfig (which libass uses on Linux) has the named family for a language. Returns null
 * when fontconfig is not installed, for example on a developer machine, so the check never blocks there.
 */
export function hasCaptionFont(family: string, lang: string) {
  const key = `${family}:${lang}`;
  if (!fontChecks.has(key)) {
    fontChecks.set(key, promisify(execFile)('fc-list', [`:lang=${lang}`, 'family'], { timeout: 10_000 })
      .then(({ stdout }) => stdout.split(/\r?\n/).some(line => line.split(',').some(name => name.trim() === family)))
      .catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? null : false)));
  }
  return fontChecks.get(key)!;
}

const WIDE_CAPTION_MARGIN_V = 420;
const NEWLINE = '\n';

function assSeconds(value: string) {
  const [h, m, s] = value.split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

/**
 * In a 1080x1920 frame the letterboxed 16:9 scene spans y=656..1264, which is where faces are. A
 * caption shown while the wide shot is on screen is lifted off the faces into the blurred band below
 * (event-level MarginV). Captions during a speaker close-up keep the style's position.
 */
export function placeCaptionsOutsideScene(ass: string, shots: readonly { start: number; end: number }[]) {
  return ass.split(NEWLINE).map((line) => {
    const match = /^Dialogue: (\d+),([^,]+),([^,]+),([^,]*),([^,]*),(\d+),(\d+),(\d+),/.exec(line);
    if (!match) return line;
    const middle = (assSeconds(match[2]!) + assSeconds(match[3]!)) / 2;
    if (shots.some(shot => middle >= shot.start && middle < shot.end)) return line;
    return line.replace(match[0], `Dialogue: ${match[1]},${match[2]},${match[3]},${match[4]},${match[5]},${match[6]},${match[7]},${WIDE_CAPTION_MARGIN_V},`);
  }).join(NEWLINE);
}

async function writeTurns(directory: string, turnsJson: string) {
  const path = join(directory, 'speaker-turns.json');
  await writeFile(path, turnsJson);
  return path;
}

/**
 * Download only [fromSec, toSec] of a platform recording, re-timed so it starts at zero, as
 * `source.mp4`. This is the only video a caption-first clip ever downloads.
 */
async function downloadSection(url: string, fromSec: number, toSec: number, directory: string) {
  const youtube = /(^|\.)youtube\.com$|^youtu\.be$/.test(new URL(url).hostname);
  await promisify(execFile)(process.env['YOUTUBE_SOURCE_PYTHON'] || 'python3', [
    '-m', 'yt_dlp', '--ignore-config', '--no-playlist', '--socket-timeout', '15', '--retries', '2', '--no-warnings',
    '--no-progress', ...(youtube ? ['--js-runtimes', 'node'] : []),
    '--download-sections', `*${fromSec.toFixed(2)}-${toSec.toFixed(2)}`, '--force-keyframes-at-cuts',
    '-f', 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b',
    '--merge-output-format', 'mp4', '-o', 'section.%(ext)s', url,
  ], { cwd: directory, timeout: 300_000, maxBuffer: 1024 * 1024 });
  // One normalization pass, as for analysis chunks, so audio and video clocks both start at zero.
  await promisify(execFile)('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'section.mp4', '-map', '0:v:0', '-map', '0:a:0',
    '-c:v', 'copy', '-af', 'aresample=async=1:first_pts=0', '-c:a', 'aac', 'source.mp4'],
  { cwd: directory, timeout: 120_000, maxBuffer: 256 * 1024 });
  if ((await stat(join(directory, 'source.mp4'))).size > MAX_SOURCE_BYTES) throw new Error('Recording section is too large');
}

/** Keys for the consecutive analysis chunks a clip spans. Non-chunked sources always use one key. */
export function sourceChunkKeys(firstKey: string, count: number) {
  const match = /^(.*\/chunks\/)(\d+)\.mp4$/.exec(firstKey);
  if (!match || count <= 1) return [firstKey];
  if (count > 2) throw new Error('A clip may span at most two recording chunks');
  return Array.from({ length: count }, (_, index) => `${match[1]}${Number(match[2]) + index}.mp4`);
}

async function downloadSource(storage: S3StorageConfig, key: string, target: string, budget: number) {
  const response = await fetch(createPresignedS3Url({ config: storage, method: 'GET', objectKey: key }), {
    redirect: 'error', signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok || !response.body) throw new Error('Source video upload is missing');
  if (Number(response.headers.get('content-length')) > budget) {
    await response.body.cancel();
    throw new Error('Source video is too large');
  }
  const body = response.body;
  let bytes = 0;
  await pipeline(async function* () {
    for await (const chunk of body) {
      bytes += chunk.byteLength;
      if (bytes > budget) throw new Error('Source video is too large');
      yield chunk;
    }
  }, createWriteStream(target));
  return bytes;
}

/**
 * Captions come from the final audio, so their clock matches playback. What remains to check is whether
 * the cut itself clipped a phrase at either end.
 */
export function reviewCaptionTiming(cues: readonly { startSec: number; endSec: number; text: string }[], durationSec: number) {
  for (const [index, cue] of cues.entries()) {
    if (cue.startSec < 0 || cue.endSec > durationSec + 0.05 || cue.endSec <= cue.startSec ||
      (index > 0 && cue.startSec < cues[index - 1]!.endSec - 0.001)) return 'Caption timing does not match the rendered audio.';
  }
  const first = cues[0];
  const last = cues.at(-1);
  if (first && first.startSec < 0.02 && /^[a-z]/.test(first.text.trim())) return 'The opening phrase starts mid-sentence.';
  if (last && last.endSec >= durationSec - 0.02 && !/[.!?…।॥]["')\]]?$/.test(last.text.trim())) return 'The closing phrase is cut off.';
  return undefined;
}

export async function renderStoredClip(prisma: PrismaClient, clip: ClipJob, storage: S3StorageConfig) {
  const startedAt = new Date();
  const staleBefore = new Date(startedAt.getTime() - RENDER_LEASE_MS);
  const claim = await prisma.clipJob.updateMany({
    where: {
      id: clip.id,
      OR: [
        { executionStatus: { in: ['PENDING', 'QUEUED', 'FAILED', 'TIMED_OUT', 'CANCELLED'] } },
        { executionStatus: 'RUNNING', updatedAt: { lt: staleBefore } },
        { executionStatus: 'COMPLETED', outputMp4Path: null },
      ],
    },
    data: { executionStatus: 'RUNNING', errorMessage: null, updatedAt: startedAt, renderAttempts: { increment: 1 } },
  });
  if (!claim.count) return null;
  let qualityIssue: string | undefined;
  let directory: string | undefined;
  let failureMessage = 'Could not render the supplied MP4. Check its format and selected timestamps.';
  try {
    directory = await mkdtemp(join(tmpdir(), 'clip-network-'));
    const source = join(directory, 'source.mp4');
    const output = join(directory, 'output.mp4');
    const sourceKey = clip.automationSourceKey ?? buildTenantClipObjectKey(clip.workspaceId, clip.id, 'source.mp4');
    const sourceKeys = clip.sourceSectionUrl ? [] : sourceChunkKeys(sourceKey, clip.sourceChunkCount);
    if (clip.sourceSectionUrl) {
      failureMessage = 'Could not download this section of the recording. Check that it is still available.';
      await downloadSection(clip.sourceSectionUrl, clip.sourceOffsetSec, clip.endSec + 1, directory);
      failureMessage = 'Could not render the supplied MP4. Check its format and selected timestamps.';
    }
    let downloaded = 0;
    for (const [index, key] of sourceKeys.entries()) {
      const target = sourceKeys.length === 1 ? source : join(directory, `part-${index}.mp4`);
      downloaded += await downloadSource(storage, key, target, MAX_SOURCE_BYTES - downloaded);
    }
    if (sourceKeys.length > 1) {
      await writeFile(join(directory, 'parts.txt'), sourceKeys.map((_, index) => `file 'part-${index}.mp4'`).join('\n'));
      await promisify(execFile)('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0',
        '-protocol_whitelist', 'file', '-i', 'parts.txt', '-c', 'copy', 'source.mp4'],
      { cwd: directory, timeout: 120_000, maxBuffer: 256 * 1024 });
    }
    const creator = await prisma.creatorAccount.findUnique({
      where: { id: clip.creatorId, workspaceId: clip.workspaceId },
      select: { facecamCropJson: true, requiredTopicsJson: true, bannedKeywordsJson: true, disallowLogos: true, spokenLanguage: true },
    });
    const configuredCrop = creator?.facecamCropJson
      ? CreateCreatorRequestSchema.shape.facecamCrop.parse(JSON.parse(creator.facecamCropJson))
      : undefined;
    // A wide retry keeps the full scene: no inferred facecam crop and no speaker push-in.
    const wide = clip.framingMode === 'WIDE';
    // An inferred facecam split only suits gameplay. In a conversation the face *is* the scene, so
    // cropping it into a bottom panel would duplicate it and block speaker switching.
    const inferFacecam = clip.layout === 'SPLIT_FACECAM_BOTTOM' && !wide &&
      (!clip.automationSourceKey || clip.contentType === 'GAMEPLAY');
    const facecamCrop = configuredCrop ?? (inferFacecam
      ? await detectFacecam(source, clip.startSec - clip.sourceOffsetSec, clip.endSec - clip.sourceOffsetSec)
      : undefined);
    const speakerShots: { start: number; end: number; center: number }[] = [];
    if (clip.automationSourceKey && !wide && clip.contentType !== 'GAMEPLAY' && !facecamCrop && process.env.FACECAM_YUNET_MODEL) {
      const script = fileURLToPath(new URL('../../scripts/speaker-framing.py', import.meta.url));
      try {
        const { stdout } = await promisify(execFile)(process.env.YOUTUBE_SOURCE_PYTHON || 'python3', [
          script, process.env.FACECAM_YUNET_MODEL, source, String(clip.startSec - clip.sourceOffsetSec),
          String(clip.endSec - clip.sourceOffsetSec),
          // Diarized turns let the script match each voice to one face across the whole clip.
          ...(clip.speakerTurnsJson !== '[]' ? [await writeTurns(directory, clip.speakerTurnsJson)] : []),
        ], { timeout: 40_000 });
        speakerShots.push(...JSON.parse(stdout));
      } catch {
        // Wide framing preserves the scene when speaker evidence is unavailable.
      }
    }
    const captionModel = clip.automationSourceKey &&
      (process.env['CLIP_FINAL_CAPTION_MODEL']?.trim() || process.env['YOUTUBE_WHISPER_MODEL']?.trim());
    const captionStyle = clip.captionStyle as CaptionStyleId;
    // The wide shot letterboxes the 16:9 scene into the middle band, so captions move below it.
    const letterboxed = !facecamCrop && (clip.layout === 'SPLIT_FACECAM_BOTTOM' || clip.automationSourceKey !== null);
    const place = (ass: string) => (letterboxed ? placeCaptionsOutsideScene(ass, speakerShots) : ass);
    const initialOutput = captionModel ? join(directory, 'uncaptioned.mp4') : output;
    const rendered = await renderVerticalShortWithSfx({
      sourceVideoPath: source,
      outputMp4Path: initialOutput,
      segments: [{ startSec: clip.startSec - clip.sourceOffsetSec, endSec: clip.endSec - clip.sourceOffsetSec }],
      cues: alignTranscriptToSpeechWindows(clip.transcript, [{ startSec: 0, endSec: clip.durationSec }]),
      assScript: captionModel ? buildWordSyncedAss([], captionStyle) : place(clip.assScript),
      layout: clip.layout as LayoutMode,
      captionStyle: clip.captionStyle as CaptionStyleId,
      enableSfx: clip.enableSfx,
      ...(clip.automationSourceKey ? { sfxCues: JSON.parse(clip.sfxCuesJson) } : {}),
      facecamCrop,
      ...(clip.automationSourceKey ? { speakerShots } : {}),
    });
    let captionUpdate: { assScript: string; transcript: string } | undefined;
    let complianceUpdate: { compliancePassed: boolean; complianceScore: number; complianceReportJson: string } | undefined;
    if (captionModel) {
      failureMessage = 'Could not generate timed subtitles from the rendered audio.';
      const cues = await transcribeSpeech(directory, 'uncaptioned.mp4', captionModel, rendered.durationSec, undefined,
        creator?.spokenLanguage);
      if (!cues.length && clip.contentType !== 'GAMEPLAY') throw new Error('No timed speech in the rendered clip');
      qualityIssue = reviewCaptionTiming(cues, rendered.durationSec) ??
        (cues.some(cue => containsDevanagari(cue.text)) && await hasCaptionFont(DEVANAGARI_CAPTION_FONT, 'hi') === false
          ? `Devanagari captions need the ${DEVANAGARI_CAPTION_FONT} font (Debian fonts-noto-core).` : undefined);
      captionUpdate = {
        assScript: place(buildWordSyncedAss(cues, captionStyle, false)),
        transcript: cues.map(({ text }) => text).join(' '),
      };
      if (creator) {
        const report = evaluateClipCompliance({
          transcript: captionUpdate.transcript, caption: '',
          requiredTopics: JSON.parse(creator.requiredTopicsJson) as string[],
          bannedKeywords: JSON.parse(creator.bannedKeywordsJson) as string[],
          disallowLogos: creator.disallowLogos, hasAddedLogos: false,
        });
        complianceUpdate = {
          compliancePassed: report.passed, complianceScore: report.score, complianceReportJson: JSON.stringify(report),
        };
      }
      await writeFile(join(directory, 'captions.ass'), captionUpdate.assScript);
      await promisify(execFile)('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file',
        '-i', 'uncaptioned.mp4', '-vf', 'ass=captions.ass', '-map', '0:v:0', '-map', '0:a:0',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-c:a', 'copy', '-movflags', '+faststart', 'output.mp4'],
      { cwd: directory, timeout: 120_000, maxBuffer: 256 * 1024 });
    }

    failureMessage = 'Rendered media failed playback checks. Review the source and retry.';
    const probe = await promisify(execFile)('ffprobe', ['-v', 'error', '-show_entries',
      'stream=codec_type,width,height:format=duration', '-of', 'json', output], { timeout: 15_000 });
    const metadata = JSON.parse(probe.stdout) as { streams: { codec_type: string; width?: number; height?: number }[]; format: { duration: string } };
    const outputDuration = Number(metadata.format.duration);
    if (!Number.isFinite(outputDuration) || Math.abs(outputDuration - clip.durationSec) > 0.25 ||
      !metadata.streams.some(stream => stream.codec_type === 'video' && stream.width === 1080 && stream.height === 1920) ||
      !metadata.streams.some(stream => stream.codec_type === 'audio')) throw new Error('Invalid rendered streams or duration');
    await promisify(execFile)('ffmpeg', ['-v', 'error', '-xerror', '-i', output, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], { timeout: 120_000 });

    failureMessage = 'Could not store the rendered MP4.';
    if ((await stat(output)).size > MAX_SOURCE_BYTES) throw new Error('Rendered video is too large');
    const objectKey = buildTenantClipObjectKey(clip.workspaceId, clip.id, `${randomUUID()}.mp4`);
    const upload = await fetch(createPresignedS3Url({ config: storage, method: 'PUT', objectKey }), {
      method: 'PUT', body: new Uint8Array(await readFile(output)), redirect: 'error',
      headers: { 'Content-Type': 'video/mp4' }, signal: AbortSignal.timeout(60_000),
    });
    if (!upload.ok) throw new Error('Could not store rendered clip');
    const compliancePassed = complianceUpdate?.compliancePassed ?? clip.compliancePassed;
    const approvalStatus = !compliancePassed ? 'DISQUALIFIED' : qualityIssue ? 'NEEDS_REVIEW' : 'AWAITING_APPROVAL';
    await prisma.$transaction(async (tx) => {
      const completed = await tx.clipJob.updateMany({
        where: { id: clip.id, executionStatus: 'RUNNING', updatedAt: startedAt },
        data: {
          executionStatus: 'COMPLETED', outputMp4Path: objectKey, durationMs: Date.now() - startedAt.getTime(),
          ...captionUpdate,
          ...complianceUpdate,
          approvalStatus, qualityIssue: qualityIssue ?? null,
          executionLogsJson: JSON.stringify([
            ...(JSON.parse(clip.executionLogsJson) as string[]),
            ...(captionUpdate ? ['Generated subtitles from rendered audio'] : []),
            ...(clip.framingMode === 'WIDE' ? ['Rendered with wide framing after an earlier attempt failed'] : []),
            ...(qualityIssue ? [`Sent to review: ${qualityIssue}`] : []),
            'Rendered MP4 and stored media',
          ]),
        },
      });
      if (completed.count) {
        await refreshSourceStatus(tx, clip, 'CLIPPED');
        if (compliancePassed && !qualityIssue) {
          await tx.publishPost.updateMany({
            where: { clipJobId: clip.id, status: 'BLOCKED' },
            data: { status: 'AWAITING_APPROVAL', errorMessage: null },
          });
        }
      }
    });
  } catch (error) {
    console.error('Clip rendering failed', clip.id, error);
    // Retry an automatic clip once with wide framing before asking a person to review it.
    const retryWide = Boolean(clip.automationSourceKey) && clip.framingMode !== 'WIDE';
    await prisma.$transaction(async (tx) => {
      const failed = await tx.clipJob.updateMany({
        where: { id: clip.id, executionStatus: 'RUNNING', updatedAt: startedAt },
        data: retryWide
          ? { executionStatus: 'QUEUED', framingMode: 'WIDE', errorMessage: null, qualityIssue: failureMessage }
          : { executionStatus: 'FAILED', errorMessage: failureMessage, qualityIssue: failureMessage },
      });
      if (failed.count && !retryWide) await refreshSourceStatus(tx, clip, 'FAILED');
    });
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
  return prisma.clipJob.findUniqueOrThrow({ where: { id: clip.id } });
}
