import { execFile } from 'node:child_process';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { groupWordsIntoCues, type TimedSpeechCue, type TimedWord } from '@clip-network/clip-engine';

const run = promisify(execFile);
interface SpeechTiming { start: number; end: number; text: string }

/**
 * One line of FFmpeg's whisper filter output. FFmpeg does not escape quotes or backslashes inside the
 * spoken text, so a word like `"hello"` makes the line invalid JSON; the text is then read between its
 * `"text":"` marker and the closing `"}`. Lines that still cannot be read are skipped, not fatal.
 */
export function parseWhisperFilterLine(line: string): SpeechTiming | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as Partial<SpeechTiming>;
    if (typeof parsed.start === 'number' && typeof parsed.end === 'number' && typeof parsed.text === 'string') {
      return { start: parsed.start, end: parsed.end, text: parsed.text };
    }
  } catch { /* fall through to the lenient read */ }
  const start = /"start"\s*:\s*(-?\d+(?:\.\d+)?)/.exec(trimmed);
  const end = /"end"\s*:\s*(-?\d+(?:\.\d+)?)/.exec(trimmed);
  const textAt = trimmed.indexOf('"text":"');
  const textEnd = trimmed.lastIndexOf('"}');
  if (!start || !end || textAt < 0 || textEnd <= textAt) return null;
  return { start: Number(start[1]), end: Number(end[1]), text: trimmed.slice(textAt + 8, textEnd).replace(/\\"/g, '"') };
}
interface VadPhrase {
  offsets: { from: number; to: number };
  text: string;
}

export function readSpeechIntervals(log: string) {
  // This report comes from the whisper.cpp version pinned in Dockerfile.api.
  const total = /Final speech segments after filtering: (\d+)/.exec(log);
  const intervals = Array.from(log.matchAll(/VAD segment \d+: start = ([\d.]+), end = ([\d.]+)/g),
    ([, start, end]) => ({ start: Number(start), end: Number(end) }));
  if ((!total || Number(total[1]) !== intervals.length) && !(intervals.length === 0 && /no speech detected/i.test(log))) {
    throw new Error('Voice detector returned an incomplete interval list');
  }
  return intervals;
}

/** Silent stretches from an FFmpeg silencedetect log, in seconds. */
export function readSilences(log: string, durationSec: number) {
  const silences: { startSec: number; endSec: number }[] = [];
  let open: number | undefined;
  for (const match of log.matchAll(/silence_(start|end): (-?[0-9.]+)/g)) {
    const t = Math.max(0, Number(match[2]));
    if (match[1] === 'start') open = t;
    else if (open !== undefined) {
      silences.push({ startSec: open, endSec: Math.min(durationSec, t) });
      open = undefined;
    }
  }
  if (open !== undefined && open < durationSec) silences.push({ startSec: open, endSec: durationSec });
  return silences;
}

/**
 * Whisper word times are contiguous: each word starts where the last ended, even across a pause.
 * A word that runs into a detected silence ends where the silence starts, and a word that begins in
 * one starts where it ends. A word that spans a whole silence moves to the side holding most of it.
 * A quiet word can read as silence, so an edit that would leave a word shorter than MIN_WORD_SEC or
 * under 40% of its recognized length is skipped. Edits are in place.
 */
export function snapWordsToPauses(words: { startSec: number; endSec: number }[],
  silences: readonly { startSec: number; endSec: number }[]) {
  const MIN_WORD_SEC = 0.12;
  const apply = (word: { startSec: number; endSec: number }, startSec: number, endSec: number) => {
    const length = endSec - startSec;
    if (length >= MIN_WORD_SEC && length >= 0.4 * (word.endSec - word.startSec)) {
      word.startSec = startSec;
      word.endSec = endSec;
    }
  };
  for (const silence of silences) {
    for (const word of words) {
      const { startSec: a, endSec: b } = silence;
      if (word.startSec < a && word.endSec > b) {
        if (a - word.startSec >= word.endSec - b) apply(word, word.startSec, a);
        else apply(word, b, word.endSec);
      } else if (word.startSec < a && word.endSec > a) {
        apply(word, word.startSec, a);
      } else if (word.startSec >= a && word.startSec < b && word.endSec > b) {
        apply(word, b, word.endSec);
      }
    }
  }
  return words;
}

export function placeSpeechPhrase(phrase: VadPhrase, interval: { start: number; end: number }): SpeechTiming {
  const origin = Math.round(interval.start * 1000);
  return {
    start: origin + Math.max(0, phrase.offsets.from),
    end: Math.min(Math.round(interval.end * 1000), origin + phrase.offsets.to),
    text: phrase.text,
  };
}

/**
 * Label each cue with a voice using scripts/diarize.py. Labels are prefixed with `scope` so labels from
 * different analysis spans never look like the same person. If diarization is unavailable, cues are
 * returned unlabelled and framing falls back to face and mouth-motion evidence alone.
 */
export async function diarizeCues(directory: string, filename: string, cues: TimedSpeechCue[], scope: string,
  signal?: AbortSignal): Promise<TimedSpeechCue[]> {
  if (!cues.length || process.env['SPEAKER_DIARIZATION'] === 'off') return cues;
  try {
    await writeFile(join(directory, 'diarize-cues.json'), JSON.stringify(cues));
    const script = fileURLToPath(new URL('../../scripts/diarize.py', import.meta.url));
    const { stdout } = await run(process.env['YOUTUBE_SOURCE_PYTHON'] || 'python3', [script, filename, 'diarize-cues.json'],
      { cwd: directory, timeout: 120_000, maxBuffer: 1024 * 1024, signal });
    const labels = JSON.parse(stdout) as unknown;
    if (!Array.isArray(labels) || labels.length !== cues.length) throw new Error('Diarizer returned the wrong number of labels');
    return cues.map((cue, index) => {
      const label = labels[index];
      return typeof label === 'string' && /^S\d{1,2}$/.test(label) ? { ...cue, speaker: `${scope}:${label}` } : cue;
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    console.warn('Speaker diarization unavailable', error instanceof Error ? error.message : 'unknown error');
    return cues;
  }
}

/**
 * Resolve the whisper language. English-only models (`*.en.bin`) can only decode English, so a request
 * for another language is reported instead of silently producing English-sounding text.
 */
export function resolveWhisperLanguage(model: string, requested = 'auto') {
  const language = /^(auto|[a-z]{2,3})$/.test(requested) ? requested : 'auto';
  if (/\.en(\.bin)?$/i.test(model)) {
    if (language !== 'auto' && language !== 'en') {
      throw new Error(`The English-only whisper model cannot transcribe "${language}". Configure a multilingual model.`);
    }
    return 'en';
  }
  return language;
}

export async function transcribeSpeech(directory: string, filename: string, model: string, duration: number,
  signal?: AbortSignal, spokenLanguage = 'auto') {
  const options = { cwd: directory, timeout: 150_000, maxBuffer: 256 * 1024, signal };
  const language = resolveWhisperLanguage(model, spokenLanguage);
  const cli = process.env['YOUTUBE_WHISPER_CLI']?.trim();
  let timings: SpeechTiming[];
  if (cli) {
    const vad = process.env['YOUTUBE_WHISPER_VAD_MODEL']?.trim();
    if (!vad) throw new Error('A voice activity model is required for whisper-cli');
    await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file',
      '-i', filename, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', 'speech.wav'], options);
    const args = ['-m', resolve(model), '-t', '4', '-ng', '-l', language];
    const { stderr } = await run(cli, [...args, '-f', 'speech.wav', '--vad', '-vm', resolve(vad)], options);
    const intervals = readSpeechIntervals(stderr);
    const inputs: string[] = [];
    for (const [index, interval] of intervals.entries()) {
      const input = `speech-${index}.wav`;
      await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(interval.start), '-i', 'speech.wav',
        '-af', `atrim=duration=${interval.end - interval.start},apad=pad_dur=1`, '-c:a', 'pcm_s16le', input], options);
      inputs.push(input);
    }
    timings = [];
    if (inputs.length) {
      // Decode each original audio interval independently. A phrase can never borrow words across a pause.
      // One word per segment (`-ml 1 -sow`) gives a time for every word; lines are rebuilt below.
      await run(cli, [...args, '-ml', '1', '-sow', '-oj', '-np', ...inputs], options);
      for (const [index, input] of inputs.entries()) {
        const result = JSON.parse(await readFile(join(directory, input + '.json'), 'utf8')) as {
          transcription: VadPhrase[];
        };
        timings.push(...result.transcription.map((phrase) => placeSpeechPhrase(phrase, intervals[index]!)));
      }
    }
  } else {
    await copyFile(resolve(model), join(directory, 'model.bin'));
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file', '-i', filename, '-vn',
      '-af', `whisper=model=model.bin:language=${language}:queue=65:max_len=1:use_gpu=false:destination=timings.jsonl:format=json`,
      '-f', 'null', '-'], options);
    timings = (await readFile(join(directory, 'timings.jsonl'), 'utf8')).split(/\r?\n/)
      .flatMap((line) => {
        const timing = parseWhisperFilterLine(line);
        return timing ? [timing] : [];
      });
  }

  const words: TimedWord[] = [];
  for (const timing of timings) {
    const startSec = timing.start / 1000;
    const endSec = Math.min(duration, timing.end / 1000);
    const text = timing.text.trim();
    if (Number.isFinite(startSec) && Number.isFinite(endSec) && endSec > startSec && text) words.push({ startSec, endSec, text });
  }
  // Whisper word times run together across pauses. Trim them to the pauses the audio actually has.
  const { stderr: silenceLog } = await run('ffmpeg', ['-hide_banner', '-protocol_whitelist', 'file', '-i', filename, '-vn',
    '-af', 'silencedetect=n=-35dB:d=0.2', '-f', 'null', '-'], { ...options, maxBuffer: 4 * 1024 * 1024 });
  snapWordsToPauses(words, readSilences(silenceLog, duration));
  // Caption lines carry their words, so captions can follow the speaker word by word.
  return groupWordsIntoCues(words);
}

