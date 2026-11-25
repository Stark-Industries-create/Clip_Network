import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
import type { CaptionStyleId, LayoutMode } from '@clip-network/shared';
import { buildAutoSfxCuesForCuts, buildSfxMixFilterGraph, type SfxCue } from './sfx-engine.js';
import { buildWordSyncedAss, type TimedSpeechCue } from './caption-engine.js';

export interface RenderVerticalClipOptions {
  sourceVideoPath: string;
  outputMp4Path: string;
  segments: ReadonlyArray<{ startSec: number; endSec: number }>;
  cues: readonly TimedSpeechCue[];
  assScript?: string;
  layout: LayoutMode;
  captionStyle: CaptionStyleId;
  enableSfx: boolean;
  sfxCues?: readonly SfxCue[] | undefined;
  speakerShots?: readonly { start: number; end: number; center: number }[];
  facecamCrop?: { x: number; y: number; width: number; height: number } | undefined;
}

export interface RenderedClipMetadata {
  outputMp4Path: string;
  durationSec: number;
  sizeBytes: number;
  sfxAppliedCount: number;
  captionCueCount: number;
}

/**
 * Renders a 1080x1920 (9:16) vertical short with zero added logos, word-synced ASS karaoke
 * captions, optional split-screen facecam layout, procedural SFX, and -14 LUFS loudnorm.
 */
export async function renderVerticalShortWithSfx(
  opts: RenderVerticalClipOptions,
): Promise<RenderedClipMetadata> {
  const outDir = path.dirname(opts.outputMp4Path);
  fs.mkdirSync(outDir, { recursive: true });

  const assPath = opts.outputMp4Path.replace(/\.mp4$/i, '.ass');
  const assContent = opts.assScript ?? buildWordSyncedAss(opts.cues, opts.captionStyle);
  fs.writeFileSync(assPath, assContent, 'utf8');

  const escapedAss = path.basename(assPath);
  const filterParts: string[] = [];
  const concatInputs: string[] = [];

  // Preserve a delayed audio track on the same timeline as the video and caption cues.
  const audioSegments = opts.segments.map((_, idx) => `[audio${idx}]`).join('');
  filterParts.push(
    opts.segments.length === 1
      ? '[0:a]aresample=async=1:first_pts=0[audio0]'
      : `[0:a]aresample=async=1:first_pts=0,asplit=${opts.segments.length}${audioSegments}`,
  );
  opts.segments.forEach((seg, idx) => {
    filterParts.push(`[0:v]trim=start=${seg.startSec}:end=${seg.endSec},setpts=PTS-STARTPTS[v${idx}]`);
    filterParts.push(`[audio${idx}]atrim=start=${seg.startSec}:end=${seg.endSec},asetpts=PTS-STARTPTS[a${idx}]`);
    concatInputs.push(`[v${idx}][a${idx}]`);
  });

  filterParts.push(`${concatInputs.join('')}concat=n=${opts.segments.length}:v=1:a=1[vc][ac]`);

  if (opts.layout === 'SPLIT_FACECAM_BOTTOM' && opts.facecamCrop) {
    const fc = opts.facecamCrop;
    filterParts.push('[vc]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,split=2[vtop_in][vbot_in]');
    filterParts.push('[vtop_in]split=2[scene][backdrop]');
    filterParts.push('[scene]scale=1080:608:flags=lanczos[scene_fit]');
    filterParts.push('[backdrop]scale=270:288:force_original_aspect_ratio=increase,crop=270:288,boxblur=20:2,eq=brightness=-0.13,scale=1080:1152[scene_background]');
    filterParts.push('[scene_background][scene_fit]overlay=0:(H-h)/2[vtop]');
    filterParts.push(
      `[vbot_in]crop=${fc.width}:${fc.height}:${fc.x}:${fc.y},scale=1080:768:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:768[vbot]`,
    );
    filterParts.push(`[vtop][vbot]vstack=inputs=2,setsar=1,fps=30,ass='${escapedAss}'[vout]`);
  } else if (opts.layout === 'SPLIT_FACECAM_BOTTOM' || opts.speakerShots) {
    // Preserve the scene when the creator has no verified facecam crop.
    const shots = opts.speakerShots ?? [];
    filterParts.push(shots.length ? '[vc]split=3[scene][backdrop][focus]' : '[vc]split=2[scene][backdrop]');
    filterParts.push('[scene]scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,setsar=1[scene_fit]');
    filterParts.push('[backdrop]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=20:2,eq=brightness=-0.13,scale=1080:1920,setsar=1[scene_background]');
    filterParts.push('[scene_background][scene_fit]overlay=(W-w)/2:(H-h)/2,setsar=1[wide]');
    if (shots.length) {
      const active = shots.map(shot => `between(t,${shot.start},${shot.end})`).join('+');
      const center = shots.reduce((expr, shot) => `if(between(t,${shot.start},${shot.end}),${shot.center},${expr})`, '0.5');
      filterParts.push(`[focus]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:'max(0,min(iw-ow,iw*(${center})-ow/2))':(ih-oh)/2,setsar=1[portrait]`);
      filterParts.push(`[wide][portrait]overlay=enable='${active}'[framed]`);
    }
    filterParts.push(`[${shots.length ? 'framed' : 'wide'}]fps=30,ass='${escapedAss}'[vout]`);
  } else {
    filterParts.push(
      `[vc]scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920:(iw-1080)/2:(ih-1920)/2,setsar=1,fps=30,ass='${escapedAss}'[vout]`,
    );
  }

  const durations = opts.segments.map((s) => Math.max(0.1, s.endSec - s.startSec));
  const cuesToMix = opts.enableSfx ? (opts.sfxCues ?? buildAutoSfxCuesForCuts(durations)) : [];
  const sfxGraph = buildSfxMixFilterGraph({
    cues: cuesToMix,
    baseAudioLabel: 'ac',
    outputLabel: 'aout',
  });
  filterParts.push(...sfxGraph.filterParts);

  await run(
    'ffmpeg',
    [
      '-y',
      '-protocol_whitelist', 'file',
      '-f', 'mov',
      '-enable_drefs', '0',
      '-i', path.resolve(opts.sourceVideoPath),
      '-filter_complex', filterParts.join(';'),
      '-map', '[vout]',
      '-map', `[${sfxGraph.outputLabel}]`,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '48000',
      '-movflags', '+faststart',
      path.resolve(opts.outputMp4Path),
    ],
    { cwd: outDir, timeout: 120_000, maxBuffer: 1024 * 1024 },
  );

  const stat = fs.statSync(opts.outputMp4Path);
  const totalDur = durations.reduce((a, b) => a + b, 0);
  const probe = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,duration',
    '-of', 'json', opts.outputMp4Path,
  ], { timeout: 15_000, maxBuffer: 16_384 });
  const video = (JSON.parse(probe.stdout) as {
    streams?: { width: number; height: number; duration: string }[];
  }).streams?.[0];
  const durationSec = Number(video?.duration);
  if (video?.width !== 1080 || video.height !== 1920 || !Number.isFinite(durationSec) ||
    durationSec <= 0 || Math.abs(durationSec - totalDur) > 0.25) {
    throw new Error('Rendered video does not match the requested clip');
  }

  return {
    outputMp4Path: opts.outputMp4Path,
    durationSec: Math.round(durationSec * 100) / 100,
    sizeBytes: stat.size,
    sfxAppliedCount: sfxGraph.appliedCueCount,
    captionCueCount: opts.cues.length,
  };
}
