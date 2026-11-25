import { describe, expect, it } from 'vitest';
import { captionLanguages, parseJson3Words, punctuateByPauses } from '../services/recording-analysis.js';
import { channelSlug, parseListingLine, recordingUrls } from '../services/recording-sources.js';

describe('Twitch and Kick recording discovery', () => {
  it('reads channel slugs only from real Twitch and Kick channel URLs', () => {
    expect(channelSlug('TWITCH', 'https://www.twitch.tv/NASA')).toBe('nasa');
    expect(channelSlug('TWITCH', 'https://twitch.tv/nasa/videos')).toBe('nasa');
    expect(channelSlug('KICK', 'https://kick.com/xqc')).toBe('xqc');
    expect(channelSlug('KICK', 'https://www.twitch.tv/xqc')).toBeNull();
    expect(channelSlug('TWITCH', 'https://www.twitch.tv/videos/2920156347')).toBeNull();
    expect(recordingUrls('TWITCH', 'nasa').list).toBe('https://www.twitch.tv/nasa/videos?filter=archives&sort=time');
    expect(recordingUrls('KICK', 'xqc').live).toBe('https://kick.com/xqc');
  });

  it('parses listing lines into recordings, rejecting foreign ids', () => {
    expect(parseListingLine('TWITCH', 'nasa', '["v2920156347","U.S. Spacewalk 101",null]')).toMatchObject({
      externalVideoId: 'v2920156347', videoUrl: 'https://www.twitch.tv/videos/2920156347', title: 'U.S. Spacewalk 101', streamStatus: 'REPLAY',
    });
    const kick = parseListingLine('KICK', 'xqc', '["01a204bb-f2e0-7379-bdd1-a56390f10160","GTA",1795375756]');
    expect(kick).toMatchObject({ videoUrl: 'https://kick.com/xqc/videos/01a204bb-f2e0-7379-bdd1-a56390f10160' });
    expect(kick!.publishedAt.getTime()).toBe(1795375756000);
    expect(parseListingLine('TWITCH', 'nasa', '["../../etc","x",null]')).toBeNull();
    expect(parseListingLine('KICK', 'xqc', '[download] something')).toBeNull();
  });
});

describe('Caption-first analysis', () => {
  it('reads per-word times from an automatic json3 track and line times from a manual one', () => {
    const auto = parseJson3Words({ events: [
      { tStartMs: 96240, dDurationMs: 4000, segs: [{ utf8: 'and' }, { utf8: ' so', tOffsetMs: 199 }, { utf8: ' tell', tOffsetMs: 559 }] },
      { tStartMs: 98000, segs: [{ utf8: '\n' }] },
    ] });
    expect(auto.map(w => [w.text, w.startSec])).toEqual([['and', 96.24], ['so', 96.439], ['tell', 96.799]]);
    expect(auto[0]!.endSec).toBeCloseTo(96.439);
    expect(auto[2]!.endSec).toBeCloseTo(100.24);
    const manual = parseJson3Words({ events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Hello there.' }] }] });
    expect(manual.map(w => w.text)).toEqual(['Hello', 'there.']);
    expect(manual[1]!.endSec).toBeCloseTo(2);
    expect(parseJson3Words(null)).toEqual([]);
  });

  it('marks sentence edges at pauses when automatic captions have no punctuation', () => {
    const cues = punctuateByPauses([
      { startSec: 0, endSec: 2, text: 'and so tell me' },
      { startSec: 2.1, endSec: 3, text: 'how it works' },
      { startSec: 4, endSec: 5, text: 'well it is simple' },
    ]);
    expect(cues.map(c => c.text)).toEqual(['And so tell me', 'how it works.', 'Well it is simple.']);
    const already = [{ startSec: 0, endSec: 1, text: 'Done.' }];
    expect(punctuateByPauses(already)).toBe(already);
  });

  it('requests the spoken-language transcript, never a machine translation', () => {
    expect(captionLanguages('auto')).toBe('.*-orig');
    expect(captionLanguages('ne')).toBe('ne,ne-orig');
  });
});

describe('FFmpeg whisper filter output', () => {
  it('reads lines whose spoken text contains unescaped quotes instead of failing the clip', async () => {
    const { parseWhisperFilterLine } = await import('../services/speech-timing.js');
    expect(parseWhisperFilterLine('{"start":120,"end":480,"text":" hello"}')).toEqual({ start: 120, end: 480, text: ' hello' });
    expect(parseWhisperFilterLine('{"start":500,"end":900,"text":" "Voyager""}')).toEqual({ start: 500, end: 900, text: ' "Voyager"' });
    expect(parseWhisperFilterLine('')).toBeNull();
    expect(parseWhisperFilterLine('garbage')).toBeNull();
  });
});
