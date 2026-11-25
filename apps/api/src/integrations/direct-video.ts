import { bearer, form, META_VERSION, providerRequest, type DirectCredential } from './direct-social.js';

const ig = `https://graph.instagram.com/${META_VERSION}`;
const fb = `https://graph.facebook.com/${META_VERSION}`;
const tt = 'https://open.tiktokapis.com/v2/post/publish';
const yt = 'https://www.googleapis.com/youtube/v3';
const xApi = 'https://api.x.com/2';
const X_CHUNK = 4 * 1024 * 1024;

/** Uploads the clip to X in chunks, waits for processing, then posts it. Returns the post ID. */
async function publishToX(accessToken: string, mediaUrl: string, caption: string): Promise<string> {
  const source = await fetch(mediaUrl, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
  if (!source.ok) throw new Error('Video storage response is invalid');
  const video = Buffer.from(await source.arrayBuffer());
  if (!video.length || video.length > 512 * 1024 * 1024) throw new Error('Video size is not supported by X');
  const init = await providerRequest<{ data: { id: string } }>(`${xApi}/media/upload/initialize`, json(accessToken, {
    media_type: 'video/mp4', total_bytes: video.length, media_category: 'amplify_video',
  }));
  const mediaId = requiredId(init.data?.id);
  for (let index = 0, offset = 0; offset < video.length; index++, offset += X_CHUNK) {
    const body = new FormData();
    body.set('segment_index', String(index));
    body.set('media', new Blob([video.subarray(offset, offset + X_CHUNK)], { type: 'application/octet-stream' }), 'clip.mp4');
    const appended = await fetch(`${xApi}/media/upload/${mediaId}/append`, {
      method: 'POST', headers: bearer(accessToken), body, redirect: 'error', signal: AbortSignal.timeout(120_000),
    });
    if (!appended.ok) throw new Error(`X media upload failed (HTTP ${appended.status})`);
  }
  type Processing = { data?: { processing_info?: { state?: string; check_after_secs?: number } } };
  let state = (await providerRequest<Processing>(`${xApi}/media/upload/${mediaId}/finalize`, { method: 'POST', headers: bearer(accessToken) })).data?.processing_info;
  for (let waited = 0; state && state.state !== 'succeeded'; ) {
    if (state.state === 'failed' || waited > 300) throw new Error('X could not process the video');
    const delay = Math.min(30, Math.max(1, state.check_after_secs ?? 5));
    await new Promise((resolve) => setTimeout(resolve, delay * 1000));
    waited += delay;
    state = (await providerRequest<Processing>(`${xApi}/media/upload?command=STATUS&media_id=${mediaId}`, { headers: bearer(accessToken) })).data?.processing_info;
  }
  const text = caption.length > 280 ? `${caption.slice(0, 279).trimEnd()}…` : caption;
  const post = await providerRequest<{ data: { id: string } }>(`${xApi}/tweets`, json(accessToken, { text, media: { media_ids: [mediaId] } }));
  return requiredId(post.data?.id);
}

function json(token: string, body: unknown) {
  return { method: 'POST', headers: { ...bearer(token), 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function safeUploadEndpoint(raw: string, host: string) {
  const url = new URL(raw);
  if (url.origin !== `https://${host}` || url.username || url.password) throw new Error('Unexpected provider upload endpoint');
  return url.href;
}

function requiredId(id: unknown): string {
  if (typeof id === 'string' && /^[\w.~:-]{1,200}$/.test(id)) return id;
  throw new Error('Provider returned no usable media identifier');
}

export async function submitDirectVideo(credential: DirectCredential, mediaUrl: string, caption: string): Promise<string> {
  const { provider, id, accessToken } = credential;
  switch (provider) {
    case 'instagram': {
      const media = await providerRequest<{ id: string }>(`${ig}/${id}/media`, form({
        media_type: 'REELS', video_url: mediaUrl, caption, share_to_feed: 'true',
      }, accessToken));
      return requiredId(media.id);
    }
    case 'facebook': {
      const started = await providerRequest<{ video_id: string; upload_url: string }>(`${fb}/${id}/video_reels`,
        form({ upload_phase: 'start' }, accessToken));
      const videoId = requiredId(started.video_id);
      const uploadUrl = safeUploadEndpoint(started.upload_url, 'rupload.facebook.com');
      const uploaded = await providerRequest<{ success?: boolean }>(uploadUrl, {
        method: 'POST', headers: { Authorization: `OAuth ${accessToken}`, file_url: mediaUrl },
      });
      if (!uploaded.success) throw new Error('Facebook rejected the upload');
      const finished = await providerRequest<{ success?: boolean }>(`${fb}/${id}/video_reels`, form({
        upload_phase: 'finish', video_id: videoId, video_state: 'PUBLISHED', description: caption,
      }, accessToken));
      if (!finished.success) throw new Error('Facebook did not accept the Reel');
      return videoId;
    }
    case 'youtube': {
      const source = await fetch(mediaUrl, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
      const length = Number(source.headers.get('content-length'));
      if (!source.ok || !source.body || !Number.isSafeInteger(length) || length <= 0 || length > 250 * 1024 * 1024) {
        await source.body?.cancel();
        throw new Error('Video storage response is invalid');
      }
      const started = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?part=snippet,status&uploadType=resumable', {
        ...json(accessToken, { snippet: { title: caption.slice(0, 100).trim() || 'Clip Network short', description: caption },
          status: { privacyStatus: 'unlisted', selfDeclaredMadeForKids: process.env['YOUTUBE_MADE_FOR_KIDS'] === 'yes' } }),
        headers: { ...bearer(accessToken), 'Content-Type': 'application/json', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(length) },
        redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
      const location = started.headers.get('location');
      if (!started.ok || !location) {
        await source.body.cancel();
        throw new Error('YouTube did not create an upload session');
      }
      const upload = await fetch(safeUploadEndpoint(location, 'www.googleapis.com'), {
        method: 'PUT', body: source.body, duplex: 'half',
        headers: { ...bearer(accessToken), 'Content-Type': 'video/mp4', 'Content-Length': String(length) },
        redirect: 'error', signal: AbortSignal.timeout(60_000),
      } as RequestInit);
      if (!upload.ok) throw new Error('YouTube upload failed');
      return requiredId((await upload.json() as { id: string }).id);
    }
    case 'tiktok': {
      const result = await providerRequest<{ data: { publish_id: string } }>(`${tt}/inbox/video/init/`, json(accessToken, {
        source_info: { source: 'PULL_FROM_URL', video_url: mediaUrl },
      }));
      return requiredId(result.data.publish_id);
    }
    case 'x':
      return publishToX(accessToken, mediaUrl, caption);
  }
}

type DirectStatus = 'pending' | 'finish-instagram' | 'published' | 'inbox' | 'failed';
export async function getDirectVideoStatus(credential: DirectCredential, remoteId: string): Promise<DirectStatus> {
  const id = requiredId(remoteId);
  const headers = bearer(credential.accessToken);
  switch (credential.provider) {
    case 'instagram': {
      const data = await providerRequest<{ status_code: string }>(`${ig}/${id}?fields=status_code`, { headers });
      if (data.status_code === 'FINISHED') return 'finish-instagram';
      if (data.status_code === 'PUBLISHED') return 'published';
      return ['ERROR', 'EXPIRED'].includes(data.status_code) ? 'failed' : 'pending';
    }
    case 'facebook': {
      const data = await providerRequest<{ status?: { video_status?: string; publishing_phase?: { status?: string; publish_status?: string } } }>(`${fb}/${id}?fields=status`, { headers });
      const publishing = data.status?.publishing_phase;
      if (publishing?.publish_status === 'published') return 'published';
      return data.status?.video_status === 'error' || publishing?.status === 'error' ? 'failed' : 'pending';
    }
    case 'youtube': {
      const data = await providerRequest<{ items?: { status?: { uploadStatus?: string } }[] }>(`${yt}/videos?part=status&id=${id}`, { headers });
      const status = data.items?.[0]?.status?.uploadStatus;
      if (status === 'processed') return 'published';
      return status && ['deleted', 'failed', 'rejected'].includes(status) ? 'failed' : 'pending';
    }
    case 'tiktok': {
      const data = await providerRequest<{ data: { status: string } }>(`${tt}/status/fetch/`, json(credential.accessToken, { publish_id: id }));
      if (data.data.status === 'PUBLISH_COMPLETE') return 'published';
      if (data.data.status === 'SEND_TO_USER_INBOX') return 'inbox';
      return data.data.status === 'FAILED' ? 'failed' : 'pending';
    }
    case 'x':
      // The post is created only after X finishes processing the video.
      return 'published';
  }
}

export async function finishInstagramVideo(credential: DirectCredential, containerId: string) {
  const data = await providerRequest<{ id: string }>(`${ig}/${credential.id}/media_publish`, form({
    creation_id: requiredId(containerId),
  }, credential.accessToken));
  return requiredId(data.id);
}
