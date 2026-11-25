import { afterEach, describe, expect, it, vi } from 'vitest';
import { directAuthUrl, type DirectProvider } from '../integrations/direct-social.js';
import { finishInstagramVideo, getDirectVideoStatus, submitDirectVideo } from '../integrations/direct-video.js';

describe('Direct social providers', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['facebook', 'www.facebook.com'], ['instagram', 'www.instagram.com'],
    ['youtube', 'accounts.google.com'], ['tiktok', 'www.tiktok.com'], ['x', 'x.com'],
  ] as const)('starts %s authorization at the provider', (provider: DirectProvider, host) => {
    const url = new URL(directAuthUrl(provider, {
      clientId: 'client', secret: 'private', redirectUri: 'https://app.example/social-accounts',
    }, 'state', 'verifier'));
    expect(url.hostname).toBe(host);
    expect(url.searchParams.get('state')).toBe('state');
    expect(url.searchParams.has('client_secret')).toBe(false);
    if (provider === 'youtube' || provider === 'x') expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('waits for Instagram processing before finalizing its container', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ id: 'container' }))
      .mockResolvedValueOnce(Response.json({ status_code: 'FINISHED' }))
      .mockResolvedValueOnce(Response.json({ id: 'reel' }));
    const account = { provider: 'instagram' as const, id: '123', accessToken: 'token' };
    expect(await submitDirectVideo(account, 'https://media.example/clip.mp4', 'Caption')).toBe('container');
    expect(await getDirectVideoStatus(account, 'container')).toBe('finish-instagram');
    expect(await finishInstagramVideo(account, 'container')).toBe('reel');
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual(Array(3).fill('graph.instagram.com'));
  });

  it('uploads and finishes Facebook Page Reels', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ video_id: 'video', upload_url: 'https://rupload.facebook.com/video-upload/video' }))
      .mockResolvedValueOnce(Response.json({ success: true }))
      .mockResolvedValueOnce(Response.json({ success: true }))
      .mockResolvedValueOnce(Response.json({ status: { publishing_phase: { publish_status: 'published' } } }));
    const account = { provider: 'facebook' as const, id: '123', accessToken: 'token' };
    expect(await submitDirectVideo(account, 'https://media.example/clip.mp4', 'Caption')).toBe('video');
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({ file_url: 'https://media.example/clip.mp4' });
    expect(await getDirectVideoStatus(account, 'video')).toBe('published');
  });

  it('uses resumable YouTube uploads and checks processing status', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('asset', { headers: { 'content-length': '5' } }))
      .mockResolvedValueOnce(new Response(null, { headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=fixture' } }))
      .mockResolvedValueOnce(Response.json({ id: 'video' }))
      .mockResolvedValueOnce(Response.json({ items: [{ status: { uploadStatus: 'processed' } }] }));
    const account = { provider: 'youtube' as const, id: '123', accessToken: 'token' };
    expect(await submitDirectVideo(account, 'https://media.example/clip.mp4', 'Caption')).toBe('video');
    expect(fetcher.mock.calls[2]?.[1]?.method).toBe('PUT');
    expect(await getDirectVideoStatus(account, 'video')).toBe('published');
  });

  it('distinguishes a TikTok inbox draft from a published video', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ data: { publish_id: 'v_inbox~v2.fixture' }, error: { code: 'ok' } }))
      .mockResolvedValueOnce(Response.json({ data: { status: 'SEND_TO_USER_INBOX' } }));
    const account = { provider: 'tiktok' as const, id: '123', accessToken: 'token' };
    const id = await submitDirectVideo(account, 'https://media.example/clip.mp4', 'Caption');
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('/inbox/video/init/');
    expect(await getDirectVideoStatus(account, id)).toBe('inbox');
  });
  it('uploads a clip to X in chunks, waits for processing, then posts it', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('video-bytes'))
      .mockResolvedValueOnce(Response.json({ data: { id: '1880' } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ data: { id: '1880', processing_info: { state: 'succeeded' } } }))
      .mockResolvedValueOnce(Response.json({ data: { id: '1990', text: 'Caption' } }));
    const account = { provider: 'x' as const, id: '42', accessToken: 'token' };
    expect(await submitDirectVideo(account, 'https://media.example/clip.mp4', 'Caption')).toBe('1990');
    const urls = fetcher.mock.calls.map(([url]) => String(url));
    expect(urls.slice(1)).toEqual([
      'https://api.x.com/2/media/upload/initialize', 'https://api.x.com/2/media/upload/1880/append',
      'https://api.x.com/2/media/upload/1880/finalize', 'https://api.x.com/2/tweets',
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[4]?.[1]?.body))).toEqual({ text: 'Caption', media: { media_ids: ['1880'] } });
    expect(await getDirectVideoStatus(account, '1990')).toBe('published');
  });
});
