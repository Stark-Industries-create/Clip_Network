import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { requireSuperAdmin } from './auth.js';
import { getDirectConfig, isDirectProvider } from './integrations/direct-social.js';
import { getGoogleLoginConfig } from './integrations/google-auth.js';
import { checkStripeAccount, createStripeWebhookEndpoint, ensureStripePlanPrices, isStripeLiveConfigured } from './integrations/stripe.js';
import { SETTING_GROUPS, savePlatformSettings, settingPreview, settingSource, validateSettings } from './platform-settings.js';

type LogAudit = (action: string, entityType: string, entityId: string, details: unknown, workspaceId?: string, userId?: string) => Promise<void>;

/** The API's public origin, for the Stripe webhook: PUBLIC_API_URL, else the request's own host. */
function publicApiOrigin(request: { headers: Record<string, string | string[] | undefined>; protocol: string; hostname: string }) {
  const configured = process.env['PUBLIC_API_URL']?.trim();
  if (configured) return new URL(configured).origin;
  const forwarded = request.headers['x-forwarded-proto'];
  const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim() || request.protocol;
  // The Host header keeps the port, which `hostname` drops.
  const forwardedHost = request.headers['x-forwarded-host'];
  const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost)?.split(',')[0]?.trim()
    || (typeof request.headers['host'] === 'string' ? request.headers['host'] : '') || request.hostname;
  return `${proto}://${host}`;
}

function stripeError(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  return message.slice(0, 300) || 'Stripe rejected the request.';
}

/** Super admin screens for integration credentials: Stripe, social logins and email. */
export function registerAdminIntegrationRoutes(app: FastifyInstance, prisma: PrismaClient, logAudit: LogAudit) {
  app.get('/api/v1/admin/integrations', async (request, reply) => {
    const ctx = await requireSuperAdmin(prisma, request, reply);
    if (!ctx) return;
    const appUrl = process.env['PUBLIC_APP_URL']?.trim() || '';
    let redirectUri = '';
    let googleLoginRedirectUri = '';
    try {
      redirectUri = appUrl ? new URL('/social-accounts', appUrl).href : '';
      googleLoginRedirectUri = appUrl ? new URL('/auth/google', appUrl).href : '';
    } catch { /* reported below */ }
    const apiOrigin = publicApiOrigin(request);
    return {
      success: true,
      data: {
        redirectUri,
        googleLoginRedirectUri,
        webhookUrl: `${apiOrigin}/api/v1/billing/webhook/stripe`,
        encryptionReady: /^[a-f0-9]{64}$/i.test(process.env['ENCRYPTION_MASTER_KEY'] ?? ''),
        groups: SETTING_GROUPS.map((group) => ({
          id: group.id, title: group.title, description: group.description, docsUrl: group.docsUrl ?? null,
          ready: group.id === 'google-login' ? Boolean(getGoogleLoginConfig())
            : isDirectProvider(group.id) ? Boolean(getDirectConfig(group.id))
            : group.id === 'stripe' ? isStripeLiveConfigured() && Boolean(process.env['STRIPE_WEBHOOK_SECRET']?.trim())
            : group.fields.every((field) => settingSource(field.key) !== 'MISSING'),
          fields: group.fields.map((field) => ({
            key: field.key, label: field.label, secret: field.secret, hint: field.hint ?? null,
            source: settingSource(field.key), preview: settingPreview(field.key),
          })),
        })),
      },
    };
  });

  app.put('/api/v1/admin/integrations', async (request, reply) => {
    const ctx = await requireSuperAdmin(prisma, request, reply);
    if (!ctx) return;
    const values = (request.body as { values?: unknown } | null)?.values;
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      return reply.code(400).send({ success: false, error: 'Send the settings to save.' });
    }
    const invalid = validateSettings(values as Record<string, unknown>);
    if (invalid) return reply.code(400).send({ success: false, error: invalid });
    await savePlatformSettings(prisma, values as Record<string, string | null>, ctx.userId);
    // Never log values, only which settings changed.
    await logAudit('ADMIN_INTEGRATIONS_UPDATED', 'PlatformSetting', 'integrations', { keys: Object.keys(values) }, undefined, ctx.userId);
    return { success: true };
  });

  /** Checks the Stripe key and creates (or reuses) the monthly price of every paid plan. */
  app.post('/api/v1/admin/integrations/stripe/verify', async (request, reply) => {
    const ctx = await requireSuperAdmin(prisma, request, reply);
    if (!ctx) return;
    if (!isStripeLiveConfigured()) return reply.code(400).send({ success: false, error: 'Save a Stripe secret key first.' });
    try {
      const account = await checkStripeAccount();
      const prices = await ensureStripePlanPrices();
      await logAudit('ADMIN_STRIPE_VERIFIED', 'PlatformSetting', 'stripe', { livemode: account?.livemode }, undefined, ctx.userId);
      return { success: true, data: { account, prices } };
    } catch (error) {
      return reply.code(502).send({ success: false, error: stripeError(error) });
    }
  });

  /** Registers the webhook in Stripe and saves its signing secret. */
  app.post('/api/v1/admin/integrations/stripe/webhook', async (request, reply) => {
    const ctx = await requireSuperAdmin(prisma, request, reply);
    if (!ctx) return;
    const origin = publicApiOrigin(request);
    if (!origin.startsWith('https://')) {
      return reply.code(400).send({
        success: false,
        error: `Stripe can only send webhooks to a public HTTPS address; this API is at ${origin}. Set PUBLIC_API_URL or open the admin from the live site.`,
      });
    }
    try {
      const endpoint = await createStripeWebhookEndpoint(origin);
      await savePlatformSettings(prisma, { STRIPE_WEBHOOK_SECRET: endpoint.secret }, ctx.userId);
      await logAudit('ADMIN_STRIPE_WEBHOOK_CREATED', 'PlatformSetting', 'stripe', { url: endpoint.url, id: endpoint.id }, undefined, ctx.userId);
      return { success: true, data: { url: endpoint.url } };
    } catch (error) {
      return reply.code(502).send({ success: false, error: stripeError(error) });
    }
  });
}
