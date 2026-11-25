import {
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { SystemRole, WorkspaceRole } from '@clip-network/shared';

const ROLE_WEIGHT: Record<WorkspaceRole, number> = {
  VIEWER: 1,
  MEMBER: 2,
  ADMIN: 3,
  OWNER: 4,
};

export interface AuthContext {
  userId: string;
  email: string;
  name: string;
  systemRole: SystemRole;
  userStatus: string;
  emailVerified: boolean;
  onboardingCompleted: boolean;
  workspaceId: string;
  workspaceRole: WorkspaceRole;
  authMethod: 'SESSION' | 'API_KEY';
  sessionId?: string;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function generateOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expectedHex] = parts;
  if (!salt || !expectedHex) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function getBillingWebhookSecret(): string {
  return (
    process.env['BILLING_WEBHOOK_SECRET']?.trim() ||
    'dev-clip-network-billing-webhook-secret-change-me'
  );
}

export function computeWebhookSignature(rawPayload: string, secret = getBillingWebhookSecret()): string {
  return createHmac('sha256', secret).update(rawPayload, 'utf8').digest('hex');
}

export function verifyWebhookSignature(
  rawPayload: string,
  signatureHeader: string | undefined,
  secret = getBillingWebhookSecret(),
): boolean {
  if (!signatureHeader) return false;
  const normalized = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice('sha256='.length)
    : signatureHeader;
  const expected = computeWebhookSignature(rawPayload, secret);
  const a = Buffer.from(normalized, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export class SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, number[]>();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
  ) {}

  check(key: string): { allowed: boolean; remaining: number; retryAfterSec: number } {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const recent = (this.buckets.get(key) ?? []).filter((ts) => ts > cutoff);
    if (recent.length >= this.maxRequests) {
      const oldest = recent[0] ?? now;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
      this.buckets.set(key, recent);
      return { allowed: false, remaining: 0, retryAfterSec };
    }
    recent.push(now);
    this.buckets.set(key, recent);
    return { allowed: true, remaining: this.maxRequests - recent.length, retryAfterSec: 0 };
  }
}

export async function resolveAuthContext(
  prisma: PrismaClient,
  request: FastifyRequest,
): Promise<AuthContext | null> {
  const apiKeyHeader = request.headers['x-api-key'];
  const authHeader = request.headers['authorization'];
  const requestedWorkspaceId =
    typeof request.headers['x-workspace-id'] === 'string'
      ? request.headers['x-workspace-id'].trim()
      : undefined;

  // 1. API Key Authentication (X-Api-Key)
  if (typeof apiKeyHeader === 'string' && apiKeyHeader.trim().length > 0) {
    const keyHash = sha256Hex(apiKeyHeader.trim());
    const keyRecord = await prisma.apiKey.findUnique({
      where: { keyHash },
      include: {
        user: true,
        workspace: true,
      },
    });
    if (!keyRecord || keyRecord.revokedAt || keyRecord.user.status !== 'ACTIVE') {
      return null;
    }
    const membership = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: keyRecord.workspaceId,
          userId: keyRecord.userId,
        },
      },
    });
    if (!membership) return null;

    await prisma.apiKey.update({
      where: { id: keyRecord.id },
      data: { lastUsedAt: new Date() },
    });

    return {
      userId: keyRecord.user.id,
      email: keyRecord.user.email,
      name: keyRecord.user.name,
      systemRole: keyRecord.user.systemRole as SystemRole,
      userStatus: keyRecord.user.status,
      emailVerified: Boolean(keyRecord.user.emailVerifiedAt),
      onboardingCompleted: keyRecord.user.onboardingCompleted,
      workspaceId: keyRecord.workspaceId,
      workspaceRole: membership.role as WorkspaceRole,
      authMethod: 'API_KEY',
    };
  }

  // 2. Session Bearer Token Authentication
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const rawToken = authHeader.slice('Bearer '.length).trim();
    if (!rawToken) return null;
    const tokenHash = sha256Hex(rawToken);
    const session = await prisma.session.findUnique({
      where: { tokenHash },
      include: {
        user: {
          include: {
            memberships: {
              orderBy: { createdAt: 'asc' },
            },
          },
        },
      },
    });

    if (!session || session.expiresAt.getTime() < Date.now()) {
      return null;
    }
    if (session.user.status !== 'ACTIVE') {
      return null;
    }

    const membership = requestedWorkspaceId
      ? session.user.memberships.find((m) => m.workspaceId === requestedWorkspaceId)
      : session.user.memberships[0];

    if (!membership) return null;

    return {
      userId: session.user.id,
      email: session.user.email,
      name: session.user.name,
      systemRole: session.user.systemRole as SystemRole,
      userStatus: session.user.status,
      emailVerified: Boolean(session.user.emailVerifiedAt),
      onboardingCompleted: session.user.onboardingCompleted,
      workspaceId: membership.workspaceId,
      workspaceRole: membership.role as WorkspaceRole,
      authMethod: 'SESSION',
      sessionId: session.id,
    };
  }

  return null;
}

export async function requireAuth(
  prisma: PrismaClient,
  request: FastifyRequest,
  reply: FastifyReply,
  minRole: WorkspaceRole = 'VIEWER',
): Promise<AuthContext | null> {
  const ctx = await resolveAuthContext(prisma, request);
  if (!ctx) {
    void reply.status(401).send({
      success: false,
      errorCode: 'UNAUTHORIZED',
      error: 'Authentication required. Provide a valid Bearer session token or X-Api-Key.',
    });
    return null;
  }
  if (ROLE_WEIGHT[ctx.workspaceRole] < ROLE_WEIGHT[minRole]) {
    void reply.status(403).send({
      success: false,
      errorCode: 'FORBIDDEN',
      error: `Workspace role ${minRole} or higher is required for this action.`,
    });
    return null;
  }
  return ctx;
}

export async function requireSuperAdmin(
  prisma: PrismaClient,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthContext | null> {
  const ctx = await resolveAuthContext(prisma, request);
  if (!ctx) {
    void reply.status(401).send({
      success: false,
      errorCode: 'UNAUTHORIZED',
      error: 'Authentication required.',
    });
    return null;
  }
  if (ctx.systemRole !== 'SUPER_ADMIN' || !ctx.emailVerified || ctx.authMethod !== 'SESSION') {
    void reply.status(403).send({
      success: false,
      errorCode: 'FORBIDDEN_ADMIN_ONLY',
      error: 'Platform SUPER_ADMIN role is required.',
    });
    return null;
  }
  return ctx;
}

const BLOCKED_SSRF_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
  '169.254.169.254',
  'metadata.google.internal',
]);

/**
 * SSRF Guard: Ensures user-supplied creator channel or stream URLs use public HTTP(S) origins only.
 */
export function assertSafeExternalUrl(rawUrl: string): { safe: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { safe: false, reason: 'Invalid URL format.' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { safe: false, reason: 'Only http:// and https:// URLs are permitted.' };
  }
  const host = parsed.hostname.toLowerCase();
  if (
    BLOCKED_SSRF_HOSTS.has(host) ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^10\./.test(host) ||
    /^127\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    /^169\.254\./.test(host)
  ) {
    return { safe: false, reason: 'Private, loopback, or metadata network URLs are forbidden.' };
  }
  return { safe: true };
}
