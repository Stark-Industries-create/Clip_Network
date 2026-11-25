import { describe, expect, it } from 'vitest';
import { selectHighlights } from '../services/source-automation.js';

describe('recording-wide highlight selection', () => {
  it('selects distinct moments across a long recording and rejects a repeated passage', () => {
    const first = 'Our guest finally discovered why the clocks drift during long recording sessions.';
    const second = 'The team escaped the cave because their leader remembered the shortcut through narrow passages beside a hidden waterfall.';
    const cues = [first, first, second].map((text, i) => ({ startSec: 120 * i, endSec: 120 * i + 18, text }));
    const picks = selectHighlights({ durationSec: 1820, chunkSeconds: 120, cues }, () => 100);
    expect(picks.map(pick => pick.transcript)).toEqual(expect.arrayContaining([first, second]));
    expect(picks).toHaveLength(2);
    expect(selectHighlights({ durationSec: 310, cues }, () => 100)).toHaveLength(1);
    expect(selectHighlights({ durationSec: 1820, cues }, () => 0)).toEqual([]);
  });

  it('keeps the question with its answer and avoids ending on an unanswered question', () => {
    const cues = [
      { startSec: 3, endSec: 10, text: 'Why did the lights suddenly disappear?' },
      { startSec: 10, endSec: 27, text: 'Because the power cable came loose when the second camera moved across the floor.' },
    ];
    const [clip] = selectHighlights({ durationSec: 60, cues }, () => 100);
    expect(clip?.startSec).toBe(2.75); // keeps a short natural pause
    expect(clip?.endSec).toBeCloseTo(27.35);
  });
});

import { classifySegment, pickSfxBeat, selectActionMoments } from '../services/source-automation.js';
import { reviewCaptionTiming, sourceChunkKeys } from '../services/render-clip.js';
import { readRecordingSignals } from '../services/youtube-source.js';

const filler = (startSec: number, i: number) => ({
  startSec, endSec: startSec + 4, text: `Okay okay okay ${i}.`,
});

describe('autonomous clipping across content types', () => {
  it('finds a strong moment late in a long recording, beyond the old sample windows', () => {
    const cues = Array.from({ length: 200 }, (_, i) => filler(i * 10, i));
    const story = 'We finally discovered the missing satellite because a student noticed one strange flicker in the archive photos.';
    cues.splice(170, 2, { startSec: 1700, endSec: 1718, text: story });
    const picks = selectHighlights({ durationSec: 2400, cues }, (text) => (text.includes('satellite') ? 100 : 0));
    expect(picks).toHaveLength(1);
    expect(picks[0]!.startSec).toBeGreaterThan(1699);
    expect(picks[0]!.transcript).toContain('satellite');
  });

  it('keeps a long answer with the question it depends on', () => {
    const cues = [
      { startSec: 100, endSec: 104, text: 'So how did you survive that winter?' },
      { startSec: 104.5, endSec: 120, text: 'We rationed everything and burned the old furniture for heat every single night.' },
      { startSec: 120.2, endSec: 138, text: 'Then the river froze solid, so we finally walked across it to reach the next village.' },
    ];
    const [clip] = selectHighlights({ durationSec: 600, cues }, () => 100);
    expect(clip?.startSec).toBeLessThanOrEqual(100);
    expect(clip?.endSec).toBeGreaterThanOrEqual(138);
    expect(clip?.contentType).toBe('CONVERSATION');
  });

  it('crosses a chunk boundary instead of dropping the moment', () => {
    const text = 'The engineer finally solved the overheating problem because she rerouted the cooling line around the reactor.';
    const [clip] = selectHighlights({ durationSec: 600, chunkSeconds: 120, cues: [{ startSec: 110, endSec: 130, text }] }, () => 100);
    expect(clip?.startSec).toBeLessThan(120);
    expect(clip?.endSec).toBeGreaterThan(120);
  });

  it('builds a setup-action-reaction window around a gameplay peak without cutting speech', () => {
    const cues = [
      { startSec: 41, endSec: 43.5, text: 'Watch this jump.' },
      { startSec: 51, endSec: 54, text: 'No way, I made it!' },
    ];
    const moments = selectActionMoments({ durationSec: 300, cues, peaks: [50], scenes: [39] }, () => 50);
    expect(moments).toHaveLength(1);
    const [moment] = moments;
    expect(moment!.contentType).toBe('GAMEPLAY');
    expect(moment!.startSec).toBeLessThanOrEqual(41);
    expect(moment!.endSec).toBeGreaterThanOrEqual(54);
    for (const cue of cues) {
      expect(cue.startSec >= moment!.startSec && cue.endSec <= moment!.endSec).toBe(true);
    }
  });

  it('classifies segments so one stream can switch between talk, play and narration', () => {
    const talk = [{ startSec: 0, endSec: 10, text: 'What happened next?' }, { startSec: 10, endSec: 20, text: 'We left.' }];
    expect(classifySegment(talk, 0, 20)).toBe('CONVERSATION');
    expect(classifySegment([{ startSec: 0, endSec: 18, text: 'Here is the plan.' }], 0, 20)).toBe('COMMENTARY');
    expect(classifySegment([{ startSec: 0, endSec: 2, text: 'Go.' }], 0, 20, [8])).toBe('GAMEPLAY');
  });

  it('places sound effects only on a peak that falls in a pause', () => {
    const cues = [{ startSec: 0, endSec: 10, text: 'Talking.' }, { startSec: 12, endSec: 20, text: 'More talking.' }];
    expect(pickSfxBeat({ cues, peaks: [5, 11] }, { startSec: 0, endSec: 20 })).toBe(11);
    expect(pickSfxBeat({ cues, peaks: [5] }, { startSec: 0, endSec: 20 })).toBeUndefined();
  });

  it('sends clips with clipped phrases or mistimed captions to review', () => {
    expect(reviewCaptionTiming([{ startSec: 0.3, endSec: 5, text: 'Hello there.' }], 6)).toBeUndefined();
    expect(reviewCaptionTiming([{ startSec: 0, endSec: 5, text: 'and then we left.' }], 6)).toMatch(/opening/);
    expect(reviewCaptionTiming([{ startSec: 1, endSec: 6, text: 'and then we' }], 6)).toMatch(/closing/);
    expect(reviewCaptionTiming([{ startSec: 1, endSec: 3, text: 'A.' }, { startSec: 2, endSec: 4, text: 'B.' }], 6)).toMatch(/timing/);
  });

  it('resolves adjacent chunk keys for a clip that spans two chunks', () => {
    expect(sourceChunkKeys('ws/c/v/chunks/3.mp4', 2)).toEqual(['ws/c/v/chunks/3.mp4', 'ws/c/v/chunks/4.mp4']);
    expect(sourceChunkKeys('ws/c/v/source.mp4', 2)).toEqual(['ws/c/v/source.mp4']);
    expect(() => sourceChunkKeys('ws/c/v/chunks/3.mp4', 3)).toThrow();
  });

  it('reads scene changes, pauses and loud moments from one FFmpeg pass', () => {
    const levels = Array.from({ length: 40 }, (_, i) => i === 20 ? -8 : -35);
    const log = [
      '[Parsed_showinfo_2 @ 0x1] n:   0 pts:  100 pts_time:3.5 duration: 1',
      '[silencedetect @ 0x2] silence_end: 7.25 | silence_duration: 1.1',
      ...levels.flatMap((db, i) => [
        `[Parsed_ametadata_4 @ 0x3] frame:${i}    pts:${i * 8000}  pts_time:${i * 0.5}`,
        `[Parsed_ametadata_4 @ 0x3] lavfi.astats.Overall.RMS_level=${db}`,
      ]),
    ].join('\r\n');
    const signals = readRecordingSignals(log, 120, 240);
    expect(signals.scenes).toEqual([123.5]);
    expect(signals.beats).toEqual([123.5, 127.25]);
    expect(signals.peaks).toEqual([130]);
  });
});

import { speakerTurns } from '../services/source-automation.js';

describe('diarized speaker turns', () => {
  const exchange = [
    { startSec: 10, endSec: 14, text: 'That changed everything for us.', speaker: 'c0:S0' },
    { startSec: 14.2, endSec: 18, text: 'It also cost you the whole budget.', speaker: 'c0:S1' },
    { startSec: 18.1, endSec: 20, text: 'Every last cent.', speaker: 'c0:S1' },
    { startSec: 20.3, endSec: 26, text: 'And we would absolutely do it again tomorrow.', speaker: 'c0:S0' },
  ];

  it('merges consecutive cues from one voice into clip-relative turns', () => {
    expect(speakerTurns(exchange, 10)).toEqual([
      { start: 0, end: 4, speaker: 'c0:S0' },
      { start: 4.2, end: 10, speaker: 'c0:S1' },
      { start: 10.3, end: 16, speaker: 'c0:S0' },
    ]);
    expect(speakerTurns([{ startSec: 0, endSec: 1, text: 'Hi.' }])).toEqual([]);
  });

  it('treats a two-voice stretch as conversation even without a question', () => {
    expect(classifySegment(exchange, 10, 26)).toBe('CONVERSATION');
    expect(classifySegment(exchange.map(({ speaker: _speaker, ...cue }) => cue), 10, 26)).toBe('COMMENTARY');
  });

  it('prefers a complete exchange between voices over a monologue of equal quality', () => {
    const monologue = [
      { startSec: 300, endSec: 304, text: 'That changed everything for our team.', speaker: 'c2:S0' },
      { startSec: 304.2, endSec: 310, text: 'It also cost the whole budget completely.', speaker: 'c2:S0' },
      { startSec: 310.3, endSec: 316, text: 'And we would gladly repeat it again tomorrow.', speaker: 'c2:S0' },
    ];
    // Shifted past the first 5% of the recording, where intros are penalized.
    const later = exchange.map(cue => ({ ...cue, startSec: cue.startSec + 100, endSec: cue.endSec + 100 }));
    const picks = selectHighlights({ durationSec: 600, cues: [...later, ...monologue] }, () => 50);
    expect(picks[0]!.startSec).toBeLessThan(111);
    expect(picks[0]!.contentType).toBe('CONVERSATION');
  });
});

import { placeCaptionsOutsideScene } from '../services/render-clip.js';

describe('dry-run regressions (NASA studio interview)', () => {
  it('keeps the full answer when the question is split across short transcriber lines', () => {
    const line = (startSec: number, endSec: number, text: string, speaker: string) => ({ startSec, endSec, text, speaker });
    const host = 'c0:S0';
    const guest = 'c0:S1';
    const cues = [
      line(86.43, 89.35, 'And so we have been talking a lot this week about fluid shifts.', host),
      line(89.35, 96.39, 'It is an experiment for the one year crew looking at changes in vision.', host),
      line(96.39, 99.68, 'And so tell me, how does nutritional biochemistry come', host),
      line(99.68, 100.63, 'into the mix?', host),
      line(100.63, 102.87, 'Well, that is a great question.', guest),
      line(102.87, 107.79, 'My daughter asked me that this past weekend.', guest),
      line(107.79, 119.39, 'First of all, nutrition is more than just carbohydrate, protein, vitamins and minerals.', guest),
      line(120, 133.2, 'It is how those things work in the body, how muscles make energy and how the brain utilizes glucose.', guest),
      line(133.2, 137.52, 'And that is how we got involved in this study.', guest),
    ];
    const [clip] = selectHighlights({ durationSec: 426, chunkSeconds: 120, cues }, () => 50);
    expect(clip!.startSec).toBeLessThanOrEqual(96.39);
    expect(clip!.endSec).toBeGreaterThanOrEqual(137.52);
  });

  it('lifts captions off the letterboxed scene only while the wide shot is on screen', () => {
    const ass = [
      '[Events]',
      'Dialogue: 0,0:00:01.00,0:00:02.00,ClipCaption,,0,0,0,,Wide',
      'Dialogue: 0,0:00:06.00,0:00:07.00,ClipCaption,,0,0,0,,Close-up',
    ].join('\n');
    const placed = placeCaptionsOutsideScene(ass, [{ start: 5, end: 10 }]).split('\n');
    expect(placed[1]).toBe('Dialogue: 0,0:00:01.00,0:00:02.00,ClipCaption,,0,0,420,,Wide');
    expect(placed[2]).toBe('Dialogue: 0,0:00:06.00,0:00:07.00,ClipCaption,,0,0,0,,Close-up');
  });
});

import { buildWordSyncedAss, containsDevanagari } from '@clip-network/clip-engine';
import { resolveWhisperLanguage } from '../services/speech-timing.js';

describe('Devanagari (Nepali and Hindi) support', () => {
  it('captions Devanagari lines in Noto Sans Devanagari without touching Latin lines', () => {
    const ass = buildWordSyncedAss([
      { startSec: 0, endSec: 2, text: 'Hello there.' },
      { startSec: 2, endSec: 5, text: 'नमस्ते, आज हामी अन्तरिक्षको कुरा गर्छौं।' },
    ], 'HIGH_ENERGY');
    expect(ass).toContain('Style: ClipCaptionDeva,Noto Sans Devanagari,');
    expect(ass).toMatch(/,ClipCaption,,0,0,0,,.*HELLO/);
    expect(ass).toMatch(/,ClipCaptionDeva,,0,0,0,,.*नमस्ते/);
    expect(containsDevanagari('क्योंकि')).toBe(true);
    expect(containsDevanagari('because')).toBe(false);
  });

  it('refuses to run an English-only model on a Nepali creator', () => {
    expect(resolveWhisperLanguage('/opt/clip-models/base.en.bin', 'auto')).toBe('en');
    expect(() => resolveWhisperLanguage('/opt/clip-models/base.en.bin', 'ne')).toThrow(/English-only/);
    expect(resolveWhisperLanguage('/opt/clip-models/base.bin', 'ne')).toBe('ne');
    expect(resolveWhisperLanguage('/opt/clip-models/base.bin', 'bad value')).toBe('auto');
  });

  it('selects a complete Nepali thought, ending on a danda and counting words with vowel signs', () => {
    const cues = [
      { startSec: 10, endSec: 16, text: 'हामीले अन्तरिक्ष स्टेसनमा पानी पुनः प्रयोग गर्ने नयाँ तरिका खोज्यौं।' },
      { startSec: 16.2, endSec: 23, text: 'किनभने त्यहाँ हरेक थोपा अमूल्य हुन्छ र पृथ्वीबाट पठाउन महँगो पर्छ।' },
      { startSec: 23.2, endSec: 30, text: 'अन्ततः यो प्रणालीले नब्बे प्रतिशत पानी फेरि सफा गर्न सक्छ।' },
    ];
    const [clip] = selectHighlights({ durationSec: 120, cues }, () => 50);
    expect(clip?.startSec).toBeLessThanOrEqual(10);
    expect(clip?.endSec).toBeGreaterThanOrEqual(30);
    expect(reviewCaptionTiming([{ startSec: 1, endSec: 6, text: 'पानी फेरि सफा गर्न सक्छ।' }], 6)).toBeUndefined();
  });
});

import { groupWordsIntoCues, timedWords } from '@clip-network/clip-engine';

describe('word-level caption timing', () => {
  const w = (startSec: number, endSec: number, text: string) => ({ startSec, endSec, text });

  it('groups words into lines at 32 characters, sentence ends and pauses, and drops non-speech', () => {
    const cues = groupWordsIntoCues([
      w(0.18, 0.28, 'And'), w(0.28, 0.52, 'so'), w(0.52, 0.86, 'tell'), w(0.86, 1.24, 'me,'),
      w(1.24, 1.42, 'how'), w(1.42, 1.76, 'does'), w(1.76, 2.38, 'nutritional'), w(2.38, 3.22, 'biochemistry'),
      w(3.22, 3.42, 'come'), w(3.42, 3.59, 'into'), w(3.59, 3.78, 'the'), w(3.78, 4.16, 'mix?'),
      w(4.3, 4.6, '(audience'), w(4.6, 4.9, 'laughs)'), w(4.9, 5.1, '[MUSIC]'),
      w(5.2, 5.5, 'Well,'), w(6.5, 6.8, 'great'), w(6.8, 7.2, 'question.'),
    ]);
    expect(cues.map(cue => cue.text)).toEqual([
      'And so tell me, how does',
      'nutritional biochemistry come',
      'into the mix?',
      'Well,',
      'great question.',
    ]);
    expect(cues[1]).toMatchObject({ startSec: 1.76, endSec: 3.42 });
    expect(cues.every(cue => cue.text.length <= 32)).toBe(true);
  });

  it('shares a cue without word timings across its words by length, not evenly', () => {
    const [a, b] = timedWords({ startSec: 0, endSec: 3, text: 'I extraordinarily' });
    expect(a!.endSec).toBeCloseTo(3 / 16);
    expect(b!.startSec).toBeCloseTo(3 / 16);
  });

  it('times each caption page and karaoke syllable from the spoken words, holding through pauses', () => {
    const ass = buildWordSyncedAss([{
      startSec: 1, endSec: 4, text: 'Well, great question.',
      words: [w(1.2, 1.5, 'Well,'), w(2.5, 2.8, 'great'), w(2.8, 3.4, 'question.')],
    }], 'CLEAN_MINIMAL', true);
    const event = ass.split('\n').find(line => line.startsWith('Dialogue:'))!;
    expect(event).toContain('0:00:01.20,0:00:03.40');
    expect(event).toContain('{\\kf30}Well, {\\k100}{\\kf30}great {\\kf60}question.');
  });
});

import { readSilences, snapWordsToPauses } from '../services/speech-timing.js';

describe('snapping whisper word times to real pauses', () => {
  it('reads silence intervals, closing one still open at the end', () => {
    const log = '[silencedetect @ 0x1] silence_start: 4.06\n[silencedetect @ 0x1] silence_end: 4.48 | silence_duration: 0.42\n' +
      '[silencedetect @ 0x1] silence_start: 13.5\n';
    expect(readSilences(log, 14)).toEqual([{ startSec: 4.06, endSec: 4.48 }, { startSec: 13.5, endSec: 14 }]);
  });

  it('ends a word at a pause, starts the next after it, and moves a word spanning a pause to its larger side', () => {
    const words = [
      { startSec: 3.78, endSec: 4.16, text: 'mix?' },
      { startSec: 4.16, endSec: 4.71, text: 'Well,' },
      { startSec: 12.02, endSec: 12.84, text: 'hope.' },
    ];
    snapWordsToPauses(words, [{ startSec: 4.06, endSec: 4.48 }, { startSec: 12.13, endSec: 12.36 }]);
    expect(words.map(w => [w.startSec, w.endSec])).toEqual([[3.78, 4.06], [4.48, 4.71], [12.36, 12.84]]);
  });

  it('never squashes a quiet word that the detector mistook for silence', () => {
    const words = [{ startSec: 4.48, endSec: 4.71, text: 'Well,' }];
    snapWordsToPauses(words, [{ startSec: 4.53, endSec: 4.9 }]);
    expect(words[0]).toMatchObject({ startSec: 4.48, endSec: 4.71 });
  });
});

import { assToWebVtt } from '@clip-network/clip-engine';

describe('WebVTT caption track', () => {
  it('turns the burned-in ASS into a WebVTT track with the same text and times', () => {
    const ass = buildWordSyncedAss([
      { startSec: 0.18, endSec: 1.76, text: 'And so tell me, how does',
        words: [
          { startSec: 0.18, endSec: 0.28, text: 'And' }, { startSec: 0.28, endSec: 0.52, text: 'so' },
          { startSec: 0.52, endSec: 0.86, text: 'tell' }, { startSec: 0.86, endSec: 1.24, text: 'me,' },
          { startSec: 1.24, endSec: 1.42, text: 'how' }, { startSec: 1.6, endSec: 1.76, text: 'does' },
        ] },
      { startSec: 2, endSec: 4, text: 'R&D <costs> rose; पानी अमूल्य हुन्छ।' },
    ], 'CLEAN_MINIMAL', true);
    const vtt = assToWebVtt(ass);
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true);
    expect(vtt).toContain('00:00:00.180 --> 00:00:01.760\nAnd so tell me, how\ndoes');
    // Same five-word line wrap as the burned-in captions.
    expect(vtt).toContain('00:00:02.000 --> 00:00:04.000\nR&amp;D &lt;costs&gt; rose; पानी अमूल्य\nहुन्छ।');
    expect(vtt).not.toMatch(/\{|\k|\N/);
    expect(assToWebVtt('[Events]\n')).toBe('WEBVTT\n\n');
  });
});

describe('intro and sign-off suppression', () => {
  it('prefers substance over a polished sign-off near the end of the recording', () => {
    const cues = [
      { startSec: 200, endSec: 206, text: 'The study found that two genetic markers predicted which astronauts lost vision.', speaker: 'w0:S1' },
      { startSec: 206.3, endSec: 214, text: 'That means we could screen crews before a Mars mission, because folate pathways differ.', speaker: 'w0:S1' },
      { startSec: 398, endSec: 404, text: 'Thanks so much for joining me today, it was a fascinating study.', speaker: 'w0:S0' },
      { startSec: 404.3, endSec: 412, text: 'It is a pleasure to be here and to share this work with everyone.', speaker: 'w0:S1' },
    ];
    const [pick] = selectHighlights({ durationSec: 426, cues }, () => 50);
    expect(pick!.startSec).toBeLessThan(201);
  });
});
