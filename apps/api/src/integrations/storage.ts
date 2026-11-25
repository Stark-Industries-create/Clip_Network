import { createHash, createHmac } from 'node:crypto';

export interface S3StorageConfig {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function getS3StorageConfig(browser = false): S3StorageConfig | null {
  const endpoint = (browser ? process.env['S3_BROWSER_ENDPOINT']?.trim() : undefined) ||
    process.env['S3_ENDPOINT']?.trim();
  const bucket = process.env['S3_BUCKET']?.trim();
  const accessKeyId = process.env['S3_ACCESS_KEY_ID']?.trim();
  const secretAccessKey = process.env['S3_SECRET_ACCESS_KEY']?.trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint: endpoint.replace(/\/$/, ''),
    bucket,
    region: process.env['S3_REGION']?.trim() || 'us-east-1',
    accessKeyId,
    secretAccessKey,
  };
}

export function buildTenantClipObjectKey(workspaceId: string, clipId: string, ext = 'mp4'): string {
  const safeWs = workspaceId.replace(/[^a-zA-Z0-9_-]/g, '');
  const safeClip = clipId.replace(/[^a-zA-Z0-9_-]/g, '');
  return `workspaces/${safeWs}/clips/${safeClip}.${ext}`;
}

export function buildSourceBundlePrefix(workspaceId: string, creatorId: string, sourceId: string): string {
  return `workspaces/${workspaceId}/sources/${creatorId}/${sourceId}`;
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * Generates an S3-compatible AWS Signature V4 pre-signed GET or PUT URL without external SDK bloat.
 * Works with AWS S3, Cloudflare R2, and MinIO.
 */
export function createPresignedS3Url(params: {
  config: S3StorageConfig;
  method: 'GET' | 'PUT' | 'HEAD';
  objectKey: string;
  expiresSec?: number;
  now?: Date;
}): string {
  const expiresSec = Math.min(3600, Math.max(60, params.expiresSec ?? 900));
  const now = params.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${params.config.region}/s3/aws4_request`;

  const endpointUrl = new URL(params.config.endpoint);
  const canonicalUri = `/${params.config.bucket}/${params.objectKey.replace(/^\/+/, '')}`;
  const queryParams = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${params.config.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresSec),
    'X-Amz-SignedHeaders': 'host',
  });
  queryParams.sort();
  const canonicalQuery = queryParams.toString();
  const canonicalHeaders = `host:${endpointUrl.host}\n`;
  const canonicalRequest = [
    params.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n');

  const kDate = hmacSha256(`AWS4${params.config.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, params.config.region);
  const kService = hmacSha256(kRegion, 's3');
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = hmacSha256(kSigning, stringToSign).toString('hex');

  return `${params.config.endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
