import type { CaptionStyleId } from '@clip-network/shared';

export interface TimedSpeechCue {
  startSec: number;
  endSec: number;
  text: string;
  /** Diarized voice label. Only comparable with labels from the same analysis span. */
  speaker?: string;
  /** Recognizer word timings on the same clock as the cue, when available. */
  words?: TimedWord[];
}

export interface TimedWord {
  startSec: number;
  endSec: number;
  text: string;
}

/**
 * Words with times. Recognizer timings are used as given; without them, the cue's duration is shared
 * across its words in proportion to their length (a long word takes longer to say than a short one).
 */
export function timedWords(cue: TimedSpeechCue): TimedWord[] {
  const usable = cue.words?.filter(word => word.text.trim() && word.endSec > word.startSec);
  if (usable?.length) return usable.map(word => ({ ...word, text: word.text.trim() }));
  const parts = cue.text.trim().split(/\s+/).filter(Boolean);
  const weights = parts.map(part => Math.max(1, [...part].length));
  const total = weights.reduce((a, b) => a + b, 0);
  let at = cue.startSec;
  return parts.map((text, index) => {
    const startSec = at;
    at += (cue.endSec - cue.startSec) * weights[index]! / total;
    return { startSec, endSec: at, text };
  });
}

function fmtVttTime(sec: number): string {
  const total = Math.round(Math.max(0, sec) * 1000);
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(total % 1000).padStart(3, '0')}`;
}

/**
 * Convert the burned-in ASS captions to WebVTT, so a player can offer the same text as a selectable,
 * screen-reader-friendly track. Override tags ({\kf30}, {\pos}) are removed and \N becomes a line break.
 */
export function assToWebVtt(ass: string): string {
  const blocks: string[] = [];
  for (const line of ass.split(/\r?\n/)) {
    const match = /^Dialogue:\s*[^,]*,(\d+):(\d{2}):(\d{2})\.(\d{2}),(\d+):(\d{2}):(\d{2})\.(\d{2}),(?:[^,]*,){6}(.*)$/.exec(line);
    if (!match) continue;
    const seconds = (h: string, m: string, s: string, cs: string) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(cs) / 100;
    const start = seconds(match[1]!, match[2]!, match[3]!, match[4]!);
    const end = seconds(match[5]!, match[6]!, match[7]!, match[8]!);
    const text = match[9]!.replace(/\{[^}]*\}/g, '').replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' ')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .split('\n').map(part => part.trim()).filter(Boolean).join('\n');
    if (!text || end <= start) continue;
    blocks.push(`${fmtVttTime(start)} --> ${fmtVttTime(end)}\n${text}`);
  }
  return `WEBVTT\n\n${blocks.join('\n\n')}${blocks.length ? '\n' : ''}`;
}

/** Markers whisper emits for non-speech, such as [MUSIC], (laughs) or ♪. */
const NON_SPEECH = /^[\[(].*[\])]$|^[♪♫]+$/;

/**
 * Group recognizer words into caption lines of at most `maxChars`, breaking at sentence ends and at
 * pauses. Bracketed non-speech annotations, even when split across several words, are dropped.
 */
export function groupWordsIntoCues(words: readonly TimedWord[], maxChars = 32, maxPauseSec = 0.6): TimedSpeechCue[] {
  const cues: TimedSpeechCue[] = [];
  let depth = 0;
  let current: TimedWord[] = [];
  const flush = () => {
    if (!current.length) return;
    cues.push({ startSec: current[0]!.startSec, endSec: current.at(-1)!.endSec, text: current.map(w => w.text).join(' '), words: current });
    current = [];
  };
  for (const raw of words) {
    const text = raw.text.trim();
    if (!text) continue;
    const opens = /^[\[(]/.test(text);
    const closes = /[\])]$/.test(text);
    if (depth > 0 || opens || NON_SPEECH.test(text)) {
      if (opens && !closes) depth++;
      else if (closes && depth > 0) depth--;
      continue;
    }
    const previous = current.at(-1);
    const startSec = Math.max(raw.startSec, previous?.endSec ?? cues.at(-1)?.endSec ?? 0);
    const endSec = Math.max(startSec + 0.01, raw.endSec);
    const length = current.reduce((sum, w) => sum + w.text.length + 1, 0) + text.length;
    if (previous && (length > maxChars || startSec - previous.endSec > maxPauseSec || SENTENCE_END.test(previous.text))) flush();
    current.push({ startSec, endSec, text });
  }
  flush();
  return cues;
}

/** Devanagari and Devanagari Extended blocks (Nepali, Hindi, Marathi, Sanskrit). */
const DEVANAGARI_PATTERN = /[ऀ-ॿ꣠-ꣿ]/;

/**
 * DejaVu Sans has no Devanagari glyphs. Noto Sans Devanagari (Debian `fonts-noto-core`) has them, and
 * libass shapes conjuncts and matras through HarfBuzz when this font is selected.
 */
export const DEVANAGARI_CAPTION_FONT = 'Noto Sans Devanagari';

export function containsDevanagari(text: string): boolean {
  return DEVANAGARI_PATTERN.test(text);
}

/** Sentence-final punctuation, including the danda (।) and double danda (॥). */
export const SENTENCE_END = /[.!?।॥]["')\]]?$/;

interface AssStyleConfig {
  fontName: string;
  fontSize: number;
  primaryColour: string;
  secondaryColour: string;
  outlinePx: number;
  marginV: number;
  uppercase: boolean;
  maxWordsPerLine: number;
}

const CAPTION_STYLES: Readonly<Record<CaptionStyleId, AssStyleConfig>> = {
  HIGH_ENERGY: {
    fontName: 'DejaVu Sans',
    fontSize: 60,
    primaryColour: '&H0000E6FF',
    secondaryColour: '&H00FFFFFF',
    outlinePx: 7,
    marginV: 740,
    uppercase: true,
    maxWordsPerLine: 4,
  },
  BOLD_CREATOR: {
    fontName: 'DejaVu Sans',
    fontSize: 58,
    primaryColour: '&H0000E6FF',
    secondaryColour: '&H00FFFFFF',
    outlinePx: 6,
    marginV: 310,
    uppercase: true,
    maxWordsPerLine: 4,
  },
  CLEAN_MINIMAL: {
    fontName: 'DejaVu Sans',
    fontSize: 48,
    primaryColour: '&H00FFFFFF',
    secondaryColour: '&H00E4E4E7',
    outlinePx: 3,
    marginV: 250,
    uppercase: false,
    maxWordsPerLine: 5,
  },
  PODCAST_PREMIUM: {
    fontName: 'DejaVu Sans',
    fontSize: 52,
    primaryColour: '&H000B9EF5',
    secondaryColour: '&H00FAF9F6',
    outlinePx: 4,
    marginV: 270,
    uppercase: false,
    maxWordsPerLine: 5,
  },
};

function fmtAssTime(sec: number): string {
  // Round to whole centiseconds first: flooring 1.2 s gives 1.19 because of binary floating point.
  const total = Math.round(Math.max(0, sec) * 100);
  const h = Math.floor(total / 360000);
  const m = Math.floor((total % 360000) / 6000);
  const s = Math.floor((total % 6000) / 100);
  const cs = total % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

export function buildWordSyncedAss(
  cues: readonly TimedSpeechCue[],
  styleId: CaptionStyleId = 'HIGH_ENERGY',
  highlightWords = true,
): string {
  const cfg = CAPTION_STYLES[styleId];
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: ClipCaption,${cfg.fontName},${cfg.fontSize},${cfg.primaryColour},${cfg.secondaryColour},&H00000000,&HB0000000,-1,0,0,0,100,100,0,0,1,${cfg.outlinePx},3,2,64,64,${cfg.marginV},1`,
    `Style: ClipCaptionDeva,${DEVANAGARI_CAPTION_FONT},${cfg.fontSize},${cfg.primaryColour},${cfg.secondaryColour},&H00000000,&HB0000000,-1,0,0,0,100,100,0,0,1,${cfg.outlinePx},3,2,64,64,${cfg.marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  for (const cue of cues) {
    if (cue.endSec <= cue.startSec || !cue.text.trim()) continue;
    const devanagari = containsDevanagari(cue.text);
    const style = devanagari ? 'ClipCaptionDeva' : 'ClipCaption';
    // Devanagari has no case; uppercasing would only change embedded Latin words.
    const words = timedWords(cue).map(word => ({
      ...word, text: cfg.uppercase && !devanagari ? word.text.toUpperCase() : word.text,
    }));
    const pageSize = cfg.maxWordsPerLine * 2;
    for (let offset = 0; offset < words.length; offset += pageSize) {
      const pageWords = words.slice(offset, offset + pageSize);
      // A page appears when its first word is spoken and stays until its last word ends.
      const pageStart = pageWords[0]!.startSec;
      const pageEnd = Math.max(pageStart + 0.1, pageWords.at(-1)!.endSec);
      // Karaoke durations are relative to the event start as written (whole centiseconds).
      let cursorCs = Math.round(pageStart * 100);
      const body = pageWords.map((word, index) => {
        const startCs = Math.max(cursorCs, Math.round(word.startSec * 100));
        const endCs = Math.max(startCs + 4, Math.round(word.endSec * 100));
        // An empty syllable holds the highlight through a pause instead of running ahead.
        const pause = highlightWords && startCs > cursorCs ? `{\\k${startCs - cursorCs}}` : '';
        cursorCs = endCs;
        const separator = index === 0 ? '' : index % cfg.maxWordsPerLine === 0 ? '\\N' : ' ';
        return separator + pause + (highlightWords ? `{\\kf${endCs - startCs}}` : '') + word.text.replace(/[{}]/g, '');
      }).join('');
      lines.push(
        `Dialogue: 0,${fmtAssTime(pageStart)},${fmtAssTime(pageEnd)},${style},,0,0,0,,${body}`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Splits a plain transcript across detected speech intervals so captions track actual voice onset.
 */
export function alignTranscriptToSpeechWindows(
  transcript: string,
  speechWindows: ReadonlyArray<{ startSec: number; endSec: number }>,
): TimedSpeechCue[] {
  const sentences = transcript
    .split(/(?<=[.!?।॥])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length === 0 || speechWindows.length === 0) return [];

  const cues: TimedSpeechCue[] = [];
  for (let i = 0; i < speechWindows.length; i += 1) {
    const win = speechWindows[i]!;
    const text = sentences[Math.min(i, sentences.length - 1)]!;
    if (win.endSec > win.startSec + 0.1) {
      cues.push({ startSec: win.startSec, endSec: win.endSec, text });
    }
  }
  return cues;
}
