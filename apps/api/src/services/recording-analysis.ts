import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { groupWordsIntoCues, SENTENCE_END, timedWords, type TimedSpeechCue, type TimedWord } from '@clip-network/clip-engine';
import { transcribeWithApi, type HostedTranscriptionConfig } from '../integrations/hosted-transcription.js';
import { rankWithLlm, type HighlightLlmConfig, type LlmPick } from '../integrations/llm-highlights.js';
import { createPresignedS3Url, type S3StorageConfig } from '../integrations/storage.js';
import { classifySegment, padToPauses, selectHighlight, selectHighlights, type SelectedHighlight } from './source-automation.js';
import { diarizeCues, readSilences, snapWordsToPauses, transcribeSpeech } from './speech-timing.js';
import { readRecordingSignals } from './youtube-source.js';

/** A pause this long in caption audio is treated as the end of a sentence. */
const CAPTION_SENTENCE_PAUSE_SEC = 0.45;

const run = promisify(execFile);

/** Whisper runs on audio windows of this length so each call stays well inside its timeout. */
const WHISPER_WINDOW_SEC = 120;
/** Hosted transcription windows: ten minutes of mono 32 kbps audio is about 2.4 MB per upload. */
const HOSTED_WINDOW_SEC = 600;
/** Audio signals and diarization run per window so a long stream never loads into memory at once. */
const SIGNAL_WINDOW_SEC = 600;
/** Audio context kept around each candidate when it is re-transcribed for exact sentence edges. */
const REFINE_CONTEXT_SEC = 20;

export interface AnalysisCost {
  /** CAPTIONS: the platform's own transcript. WHISPER: the full recording was transcribed here. */
  transcriptSource: 'CAPTIONS' | 'WHISPER';
  /** LLM: moments chosen by the language model. RULES: the built-in ranking. */
  rankedBy: 'LLM' | 'RULES';
  recordingSec: number;
  wallSec: number;
  audioBytes: number;
  /** Seconds of audio that went through local whisper (whole recording, or candidate windows only). */
  whisperAudioSec: number;
  /** Seconds of audio sent to the hosted transcription API. */
  hostedAsrSec: number;
  llmInputTokens: number;
  llmOutputTokens: number;
  captionWords: number;
  candidatesRefined: number;
}

export interface AnalysisRequest {
  platform: string;
  videoUrl: string;
  title: string;
  spokenLanguage: string;
  requiredTopics: readonly string[];
  bannedKeywords: readonly string[];
  /** Compliance-aware quality score used by selection (0 rejects). */
  score: (transcript: string) => number;
  /** Longest recording the workspace plan allows, in seconds. */
  maxRecordingSec: number;
  /**
   * Candidates to keep per clip slot. Shared analyses keep a wider pool (for example 3) so every
   * workspace can pick its own best moments under its own rules.
   */
  candidatePool?: number;
}

export type AnalysisOutcome =
  | { status: 'READY'; cost: AnalysisCost }
  | { status: 'NOT_READY'; reason: string }
  | { status: 'TOO_LONG'; durationSec: number };

/**
 * Words from a YouTube json3 caption track. Auto-generated tracks time every word (tOffsetMs); a word
 * ends where the next one starts, or where its caption event ends. Manual tracks time whole lines, which
 * are shared across their words by length.
 */
export function parseJson3Words(json: unknown): TimedWord[] {
  const events = (json as { events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string; tOffsetMs?: number }[] }[] })
    ?.events ?? [];
  const words: TimedWord[] = [];
  for (const event of events) {
    if (typeof event.tStartMs !== 'number' || !event.segs?.length) continue;
    const eventEnd = (event.tStartMs + (event.dDurationMs ?? 0)) / 1000;
    const segs = event.segs.filter(seg => (seg.utf8 ?? '').trim() && seg.utf8 !== '\n');
    const timed = segs.some(seg => typeof seg.tOffsetMs === 'number');
    if (!timed) {
      const text = segs.map(seg => seg.utf8).join('').replace(/\s+/g, ' ').trim();
      if (text) words.push(...timedWords({ startSec: event.tStartMs / 1000, endSec: Math.max(eventEnd, event.tStartMs / 1000 + 0.2), text }));
      continue;
    }
    segs.forEach((seg, index) => {
      const startSec = (event.tStartMs! + (seg.tOffsetMs ?? 0)) / 1000;
      const next = segs[index + 1];
      const endSec = next ? (event.tStartMs! + (next.tOffsetMs ?? 0)) / 1000 : eventEnd;
      for (const text of seg.utf8!.trim().split(/\s+/)) {
        if (text) words.push({ startSec, endSec: Math.max(startSec + 0.05, endSec), text });
      }
    });
  }
  words.sort((a, b) => a.startSec - b.startSec);
  for (let i = 0; i < words.length - 1; i++) words[i]!.endSec = Math.min(words[i]!.endSec, Math.max(words[i]!.startSec + 0.05, words[i + 1]!.startSec));
  return words;
}

/**
 * Automatic captions have no punctuation or capitals, but selection looks for sentence edges. A pause of
 * `pauseSec` or more is treated as a sentence end: the line before it gets a period and the line after
 * it a capital. Exact punctuation comes later, when candidates are re-transcribed.
 */
export function punctuateByPauses(cues: TimedSpeechCue[], pauseSec = 0.6): TimedSpeechCue[] {
  const punctuated = cues.some(cue => /[.!?।]$/.test(cue.text.trim()));
  if (punctuated) return cues;
  return cues.map((cue, index) => {
    const next = cues[index + 1];
    const previous = cues[index - 1];
    const ends = !next || next.startSec - cue.endSec >= pauseSec;
    const starts = !previous || cue.startSec - previous.endSec >= pauseSec;
    let text = cue.text.trim();
    if (starts) text = text.charAt(0).toLocaleUpperCase() + text.slice(1);
    if (ends) text = `${text}.`;
    return { ...cue, text };
  });
}

/** yt-dlp caption language list for a creator's spoken language. */
export function captionLanguages(spokenLanguage: string) {
  // "-orig" is YouTube's automatic transcript in the spoken language (not a machine translation).
  return spokenLanguage === 'auto' ? '.*-orig' : `${spokenLanguage},${spokenLanguage}-orig`;
}

function ytDlpArgs(platform: string) {
  return ['-m', 'yt_dlp', '--ignore-config', '--no-playlist', '--socket-timeout', '15', '--retries', '2',
    '--no-warnings', '--output-na-placeholder', 'null', ...(platform === 'YOUTUBE' ? ['--js-runtimes', 'node'] : [])];
}

/** YouTube usually publishes automatic captions within this long after a recording becomes available. */
export const CAPTION_WAIT_MS = 45 * 60_000;

/**
 * Wait (free) instead of transcribing (paid) while a YouTube recording's captions may still appear.
 * Twitch and Kick never get captions, so they never wait.
 */
export function shouldWaitForCaptions(platform: string, captioned: boolean, waitingSinceMs: number, nowMs: number) {
  return platform === 'YOUTUBE' && !captioned && nowMs - waitingSinceMs < CAPTION_WAIT_MS;
}

/**
 * Turn the model's line ranges into candidate clips. Ranges must be 10-60 seconds and pass the creator's
 * compliance score; the best hook wins, overlaps are dropped, and at most one clip per ten minutes
 * (rounded up) is kept. Weak picks are dropped rather than used to fill slots.
 */
export function picksToHighlights(picks: readonly LlmPick[], cues: readonly TimedSpeechCue[], durationSec: number,
  score: (text: string) => number, peaks: readonly number[] = [], minHook = 50, limit = Math.ceil(durationSec / 600)): SelectedHighlight[] {
  const candidates = picks.flatMap(pick => {
    if (pick.hookScore < minHook) return [];
    const range = cues.slice(pick.firstLine, pick.lastLine + 1);
    const startSec = range[0]?.startSec;
    const endSec = range.at(-1)?.endSec;
    if (startSec === undefined || endSec === undefined || endSec - startSec < 10 || endSec - startSec > 60) return [];
    const transcript = range.map(cue => cue.text.trim()).join(' ');
    if (!score(transcript)) return [];
    const highlight: SelectedHighlight = {
      startSec, endSec, transcript, rank: pick.hookScore,
      contentType: classifySegment(cues, startSec, endSec, peaks),
      cues: range.map(cue => ({ ...cue, startSec: cue.startSec - startSec, endSec: cue.endSec - startSec })),
    };
    return [highlight];
  }).sort((a, b) => b.rank - a.rank);
  const kept: SelectedHighlight[] = [];
  for (const candidate of candidates) {
    if (kept.length >= limit) break;
    if (kept.some(other => candidate.startSec < other.endSec && other.startSec < candidate.endSec)) continue;
    kept.push(candidate);
  }
  return kept.sort((a, b) => a.startSec - b.startSec);
}

/**
 * Snap a model-chosen range to exact sentence edges in a precise transcript of the same audio: start at
 * the sentence that begins nearest the old start, end at the first sentence end at or just after the old
 * end. The moment itself is kept; only its edges move by a few seconds.
 */
export function snapToSentences(precise: readonly TimedSpeechCue[], startSec: number, endSec: number) {
  const opens = (i: number) => i === 0 || SENTENCE_END.test(precise[i - 1]!.text.trim());
  const starts = precise.map((cue, i) => ({ cue, i })).filter(({ cue, i }) => opens(i) && Math.abs(cue.startSec - startSec) <= 3);
  const first = starts.sort((a, b) => Math.abs(a.cue.startSec - startSec) - Math.abs(b.cue.startSec - startSec))[0];
  if (!first) return null;
  // Prefer finishing the sentence in progress; end up to two seconds early only if it runs on too long.
  const closesWithin = (from: number) => precise.findIndex((cue, i) => i >= first.i && cue.endSec >= from &&
    cue.endSec <= endSec + 6 && SENTENCE_END.test(cue.text.trim()));
  const after = closesWithin(endSec);
  const lastIndex = after >= 0 ? after : closesWithin(endSec - 2);
  if (lastIndex < 0) return null;
  const range = precise.slice(first.i, lastIndex + 1);
  const duration = precise[lastIndex]!.endSec - first.cue.startSec;
  return duration >= 10 && duration <= 60 ? range : null;
}

export interface AnalyzerOptions {
  /** Local whisper model; used when no hosted transcription is configured, and as its fallback. */
  modelPath?: string | undefined;
  asr?: HostedTranscriptionConfig | null | undefined;
  llm?: HighlightLlmConfig | null | undefined;
}

/**
 * Analyze a recording from YouTube, Twitch or Kick without downloading its video.
 *
 * 1. Words: the platform's caption track when it has one (YouTube; fresh recordings wait up to 45 minutes
 *    for it). Otherwise the audio is transcribed, by a hosted Whisper API when configured.
 * 2. Audio only: loud moments, real pauses and per-window speaker labels.
 * 3. Moments: an LLM ranks numbered transcript lines (with loud and most-replayed markers) when
 *    configured; the rule-based ranking is the fallback. Only the audio around each chosen moment is
 *    re-transcribed, to cut on exact sentence edges. Video is fetched later for the chosen sections only.
 *
 * Writes transcript.json (with the chosen `highlights`) under `prefix` and returns its measured cost.
 */
export function createRecordingAnalyzer(options: AnalyzerOptions) {
  const python = process.env['YOUTUBE_SOURCE_PYTHON'] || 'python3';
  const { modelPath, asr, llm } = options;
  if (!modelPath && !asr) throw new Error('Recording analysis needs a local whisper model or a hosted transcription API');

  return async (request: AnalysisRequest, storage: S3StorageConfig, prefix: string): Promise<AnalysisOutcome> => {
    const started = Date.now();
    const args = ytDlpArgs(request.platform);
    const { stdout } = await run(python, [...args, '--skip-download', '--print', '%(duration)j', '--print', '%(live_status)j',
      '--print', '%(heatmap)j', request.videoUrl], { timeout: 60_000, maxBuffer: 1024 * 1024 });
    const [durationJson, statusJson, heatmapJson] = stdout.trim().split(/\r?\n/);
    const durationSec = Number(JSON.parse(durationJson || 'null'));
    const status: unknown = JSON.parse(statusJson || 'null');
    if (['is_live', 'is_upcoming', 'post_live'].includes(String(status))) return { status: 'NOT_READY', reason: 'The broadcast is still live or processing.' };
    if (!Number.isFinite(durationSec) || durationSec < 12) return { status: 'NOT_READY', reason: 'The recording is not available yet.' };
    if (durationSec > request.maxRecordingSec) return { status: 'TOO_LONG', durationSec };

    // Generous but bounded: about real time for locally transcribed recordings, minutes otherwise.
    const signal = AbortSignal.timeout(Math.min(6 * 3600, 600 + durationSec * 1.5) * 1000);
    const heatmap = JSON.parse(heatmapJson || 'null') as { start_time: number; value: number }[] | null;
    const replayPeaks = Array.isArray(heatmap) ? heatmap.filter((point, i) =>
      Number.isFinite(point.start_time) && point.start_time >= 0 && point.start_time <= durationSec &&
      point.value > 0.7 && point.value > (heatmap[i - 1]?.value ?? 0) && point.value >= (heatmap[i + 1]?.value ?? 0),
    ).map(point => point.start_time) : [];

    const objectUrl = (name: string, method: 'GET' | 'PUT') => createPresignedS3Url({ config: storage, method, objectKey: `${prefix}/${name}` });
    const put = async (name: string, body: string, type = 'application/json') => {
      const response = await fetch(objectUrl(name, 'PUT'), { method: 'PUT', body, headers: { 'Content-Type': type }, signal });
      if (!response.ok) throw new Error('Could not store analysis output');
    };
    const getJson = async <T>(name: string): Promise<T | null> => {
      const response = await fetch(objectUrl(name, 'GET'), { signal });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error('Could not read analysis progress');
      return await response.json() as T;
    };

    const directory = await mkdtemp(join(tmpdir(), 'clip-analysis-'));
    const cost: AnalysisCost = {
      transcriptSource: 'CAPTIONS', rankedBy: 'RULES', recordingSec: durationSec, wallSec: 0, audioBytes: 0, whisperAudioSec: 0,
      hostedAsrSec: 0, captionWords: 0, candidatesRefined: 0, llmInputTokens: 0, llmOutputTokens: 0,
    };
    /** Transcribe a local audio file with the hosted API when configured, else (or on failure) local whisper. */
    const transcribe = async (file: string, length: number): Promise<TimedSpeechCue[]> => {
      if (asr) {
        try {
          const words = await transcribeWithApi(asr, join(directory, file), length, request.spokenLanguage, signal);
          cost.hostedAsrSec += length;
          return groupWordsIntoCues(words);
        } catch (error) {
          if (!modelPath || signal.aborted) throw error;
          console.warn('Hosted transcription failed; using local whisper', error instanceof Error ? error.message : 'unknown');
        }
      }
      cost.whisperAudioSec += length;
      return transcribeSpeech(directory, file, modelPath!, length, signal, request.spokenLanguage);
    };
    // Small mono audio: cheap to upload and quick to decode locally.
    const extract = (from: number, length: number, output: string, file: string) => run('ffmpeg', ['-y', '-v', 'error',
      '-ss', String(from), '-t', String(length), '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '32k', output],
    { cwd: directory, timeout: 300_000, signal });

    try {
      // 1. Platform captions (YouTube). Free, and seconds instead of CPU-hours.
      let words: TimedWord[] = [];
      if (request.platform === 'YOUTUBE') {
        await run(python, [...args, '--skip-download', '--write-subs', '--write-auto-subs', '--sub-format', 'json3',
          '--sub-langs', captionLanguages(request.spokenLanguage), '-o', 'captions.%(ext)s', request.videoUrl],
        { cwd: directory, timeout: 120_000, maxBuffer: 1024 * 1024, signal }).catch(() => undefined);
        const files = (await readdir(directory)).filter(name => name.endsWith('.json3'));
        // Prefer a creator-uploaded track (punctuated) over the automatic one.
        const chosen = files.find(name => !name.includes('-orig')) ?? files[0];
        if (chosen) words = parseJson3Words(JSON.parse(await readFile(join(directory, chosen), 'utf8')));
        cost.captionWords = words.length;
      }
      const captioned = words.length >= Math.max(20, durationSec / 30);
      if (request.platform === 'YOUTUBE' && !captioned) {
        // YouTube adds automatic captions some minutes after a recording appears. Waiting is free;
        // transcribing the whole recording is not. Twitch and Kick never get captions, so they never wait.
        const wait = await getJson<{ since: number }>('caption-wait.json');
        const since = wait?.since ?? Date.now();
        if (!wait) await put('caption-wait.json', JSON.stringify({ since }));
        if (shouldWaitForCaptions(request.platform, captioned, since, Date.now())) {
          return { status: 'NOT_READY', reason: 'Waiting for YouTube captions (up to 45 minutes after the recording appears).' };
        }
      }

      // 2. Audio only. A 3-hour stream is about 150-200 MB, against several GB of video.
      await run(python, [...args, '--no-progress', '-f', 'ba[ext=m4a]/ba/b', '-x', '--audio-format', 'm4a',
        '-o', 'audio.%(ext)s', request.videoUrl], { cwd: directory, timeout: Math.max(300_000, durationSec * 400), maxBuffer: 1024 * 1024, signal });
      const audio = (await readdir(directory)).find(name => name.startsWith('audio.'));
      if (!audio) throw new Error('Audio download produced no file');
      cost.audioBytes = (await stat(join(directory, audio))).size;

      // 3a. Audio signals and real pauses, one window at a time (bounded memory on long streams).
      const beats = [...replayPeaks];
      const peaks: number[] = [];
      const silences: { startSec: number; endSec: number }[] = [];
      const extractSpan = (start: number, end: number) => run('ffmpeg', ['-y', '-v', 'error', '-ss', String(start), '-t', String(end - start),
        '-i', audio, '-vn', '-c:a', 'aac', 'span.m4a'], { cwd: directory, timeout: 300_000, signal });
      for (let start = 0; start < durationSec; start += SIGNAL_WINDOW_SEC) {
        const end = Math.min(durationSec, start + SIGNAL_WINDOW_SEC);
        await extractSpan(start, end);
        const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', 'span.m4a', '-af',
          'silencedetect=n=-35dB:d=0.3,aresample=16000,asetnsamples=n=8000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level',
          '-f', 'null', '-'], { cwd: directory, timeout: 600_000, maxBuffer: 64 * 1024 * 1024, signal });
        const signals = readRecordingSignals(stderr, start, end);
        beats.push(...signals.beats);
        peaks.push(...signals.peaks);
        silences.push(...readSilences(stderr, end - start).map(s => ({ startSec: s.startSec + start, endSec: s.endSec + start })));
      }

      let cues: TimedSpeechCue[];
      if (captioned) {
        // Caption word times run together; the audio's own pauses mark where sentences end.
        snapWordsToPauses(words, silences);
        cues = punctuateByPauses(groupWordsIntoCues(words, 32, CAPTION_SENTENCE_PAUSE_SEC), CAPTION_SENTENCE_PAUSE_SEC);
      } else {
        // Whole-recording transcription, resumable window by window. Hosted APIs take long windows.
        cost.transcriptSource = 'WHISPER';
        cues = [];
        const windowSec = asr ? HOSTED_WINDOW_SEC : WHISPER_WINDOW_SEC;
        const progress = await getJson<{ durationSec: number; nextWindow: number; windowSec?: number }>('progress.json');
        const first = progress?.durationSec === durationSec && (progress.windowSec ?? WHISPER_WINDOW_SEC) === windowSec ? progress.nextWindow : 0;
        for (let index = 0; index * windowSec < durationSec; index++) {
          const start = index * windowSec;
          const length = Math.min(windowSec, durationSec - start);
          if (index < first) {
            const saved = await getJson<{ cues: TimedSpeechCue[] }>(`windows/${index}.json`);
            if (saved) { cues.push(...saved.cues); continue; }
          }
          await extract(start, length, 'window.m4a', audio);
          const windowCues = (await transcribe('window.m4a', length))
            .map(({ words: _words, ...cue }) => ({ ...cue, startSec: cue.startSec + start, endSec: cue.endSec + start }));
          cues.push(...windowCues);
          await put(`windows/${index}.json`, JSON.stringify({ cues: windowCues }));
          await put('progress.json', JSON.stringify({ durationSec, nextWindow: index + 1, windowSec }));
        }
      }

      // 3b. Speaker labels per window, on the final lines.
      const labelled: TimedSpeechCue[] = [];
      for (let start = 0; start < durationSec; start += SIGNAL_WINDOW_SEC) {
        const end = Math.min(durationSec, start + SIGNAL_WINDOW_SEC);
        const spanCues = cues.filter(cue => cue.startSec >= start && cue.startSec < end);
        if (!spanCues.length) continue;
        await extractSpan(start, end);
        const relative = spanCues.map(cue => ({ ...cue, startSec: cue.startSec - start, endSec: Math.min(end, cue.endSec) - start }));
        const diarized = await diarizeCues(directory, 'span.m4a', relative, `w${start / SIGNAL_WINDOW_SEC}`, signal);
        labelled.push(...diarized.map((cue, i) => ({ ...spanCues[i]!, ...(cue.speaker ? { speaker: cue.speaker } : {}) })));
      }

      // 4. Pick moments: the LLM when configured; the rules otherwise, or if the LLM fails or finds nothing.
      const manifest = { durationSec, cues: labelled, beats: beats.sort((a, b) => a - b), peaks, scenes: [] as number[] };
      const pool = Math.max(1, Math.min(5, request.candidatePool ?? 1));
      const poolLimit = Math.ceil(durationSec / 600) * pool;
      let candidates: SelectedHighlight[] = [];
      if (llm && labelled.length) {
        try {
          const ranking = await rankWithLlm(llm, {
            cues: labelled, durationSec, title: request.title, markers: { loud: peaks, replayed: replayPeaks },
            requiredTopics: request.requiredTopics, bannedKeywords: request.bannedKeywords, signal, pool,
          });
          cost.llmInputTokens = ranking.inputTokens;
          cost.llmOutputTokens = ranking.outputTokens;
          candidates = picksToHighlights(ranking.picks, labelled, durationSec, request.score, peaks, 50, poolLimit);
          if (candidates.length) cost.rankedBy = 'LLM';
        } catch (error) {
          if (signal.aborted) throw error;
          console.warn('LLM ranking unavailable; using rule-based ranking', error instanceof Error ? error.message : 'unknown');
        }
      }
      if (!candidates.length) candidates = selectHighlights(manifest, request.score, poolLimit);

      // 5. Exact sentence edges from a short, precise transcript around each moment.
      const highlights: SelectedHighlight[] = [];
      for (const [index, candidate] of candidates.entries()) {
        if (cost.transcriptSource === 'WHISPER') { highlights.push(candidate); continue; }
        const from = Math.max(0, candidate.startSec - REFINE_CONTEXT_SEC);
        const to = Math.min(durationSec, candidate.endSec + REFINE_CONTEXT_SEC);
        await extract(from, to - from, 'refine.m4a', audio);
        const precise = await transcribe('refine.m4a', to - from);
        cost.candidatesRefined++;
        const absolute = (await diarizeCues(directory, 'refine.m4a', precise.map(({ words: _w, ...cue }) => cue), `r${index}`, signal))
          .map(cue => ({ ...cue, startSec: cue.startSec + from, endSec: cue.endSec + from }));
        let refined: SelectedHighlight | null | undefined;
        if (cost.rankedBy === 'LLM') {
          // Keep the model's moment; move only its edges onto whole sentences.
          const range = snapToSentences(absolute, candidate.startSec, candidate.endSec);
          if (range) {
            const startSec = range[0]!.startSec;
            refined = padToPauses({
              ...candidate, startSec, endSec: range.at(-1)!.endSec, transcript: range.map(cue => cue.text.trim()).join(' '),
              cues: range.map(cue => ({ ...cue, startSec: cue.startSec - startSec, endSec: cue.endSec - startSec })),
            }, absolute, durationSec);
          }
        } else {
          const best = selectHighlight(absolute, request.score, manifest.beats, durationSec);
          refined = best && padToPauses({ ...best, contentType: candidate.contentType }, absolute, durationSec);
        }
        // Keep the coarse candidate if refinement found nothing, fails compliance, or drifted onto another clip.
        const collides = !!refined && [...highlights, ...candidates.slice(index + 1)]
          .some(other => refined!.startSec < other.endSec && other.startSec < refined!.endSec);
        highlights.push(refined && !collides && request.score(refined.transcript) ? refined : candidate);
      }

      cost.wallSec = Math.round((Date.now() - started) / 1000);
      await put('transcript.json', JSON.stringify({
        ...manifest, source: cost.transcriptSource, mediaUrl: request.videoUrl, highlights, cost,
      }));
      return { status: 'READY', cost };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}
