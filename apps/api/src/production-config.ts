type Service = 'api' | 'worker';

/** Reject invalid production settings before opening sockets or claiming jobs. */
export function assertProductionConfig(service: Service, env = process.env) {
  if (env.NODE_ENV !== 'production') return;
  const invalid: string[] = [];
  const value = (name: string) => env[name]?.trim() ?? '';
  const requireValue = (name: string) => {
    if (!value(name) || /^(replace|change|example|your)[_-]/i.test(value(name))) invalid.push(name);
  };
  const checkUrl = (name: string, protocols: string[], originOnly = false) => {
    try {
      const url = new URL(value(name));
      if (!protocols.includes(url.protocol) || !url.hostname ||
        (originOnly && (url.username || url.password || url.pathname !== '/' || url.search || url.hash))) invalid.push(name);
    } catch { invalid.push(name); }
  };

  checkUrl('DATABASE_URL', ['postgres:', 'postgresql:']);
  if (!/^[a-f0-9]{64}$/i.test(value('ENCRYPTION_MASTER_KEY'))) invalid.push('ENCRYPTION_MASTER_KEY');
  checkUrl('PUBLIC_APP_URL', ['https:'], true);
  checkUrl('S3_ENDPOINT', ['https:'], true);
  for (const name of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) requireValue(name);
  // Stripe, social logins and email can instead be entered by a super admin (stored encrypted in the
  // database), so they are optional here; values present in the environment must still be well formed.
  const socialProviders = ['FACEBOOK', 'INSTAGRAM', 'YOUTUBE', 'TIKTOK', 'X'];
  for (const provider of socialProviders) {
    const id = `${provider}_CLIENT_ID`;
    const secret = `${provider}_CLIENT_SECRET`;
    if (value(id) || value(secret)) {
      requireValue(id);
      requireValue(secret);
    }
  }
  if (value('POSTIZ_API_KEY')) {
    requireValue('POSTIZ_API_KEY');
    if (value('POSTIZ_API_BASE_URL')) checkUrl('POSTIZ_API_BASE_URL', ['https:']);
  }
  if (value('YOUTUBE_CLIENT_ID') && !['yes', 'no'].includes(value('YOUTUBE_MADE_FOR_KIDS'))) {
    invalid.push('YOUTUBE_MADE_FOR_KIDS');
  }
  if (service === 'api') {
    if (value('RESEND_API_KEY') || value('EMAIL_FROM')) {
      requireValue('RESEND_API_KEY');
      requireValue('EMAIL_FROM');
    }
    if (value('STRIPE_SECRET_KEY') && !/^(sk|rk)_(live|test)_[a-z0-9]+$/i.test(value('STRIPE_SECRET_KEY'))) invalid.push('STRIPE_SECRET_KEY');
    if (value('STRIPE_WEBHOOK_SECRET') && !/^whsec_[a-z0-9]+$/i.test(value('STRIPE_WEBHOOK_SECRET'))) invalid.push('STRIPE_WEBHOOK_SECRET');
    for (const name of ['STRIPE_PRICE_STARTER', 'STRIPE_PRICE_PRO', 'STRIPE_PRICE_ENTERPRISE']) {
      if (value(name) && !/^price_[a-z0-9]+$/i.test(value(name))) invalid.push(name);
    }
    if (value('SOURCE_CONNECTOR_WORKSPACE_ID') || value('SOURCE_CONNECTOR_INGRESS_TOKEN')) {
      requireValue('SOURCE_CONNECTOR_WORKSPACE_ID');
      if (value('SOURCE_CONNECTOR_INGRESS_TOKEN').length < 32) invalid.push('SOURCE_CONNECTOR_INGRESS_TOKEN');
    }
  } else {
    const intervalMs = Number(env.CHANNEL_MONITOR_INTERVAL_MS ?? 300_000);
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 30_000) invalid.push('CHANNEL_MONITOR_INTERVAL_MS');
    if (value('SOURCE_CONNECTOR_SUBSCRIPTIONS_URL') || value('SOURCE_CONNECTOR_ADMIN_TOKEN')) {
      requireValue('SOURCE_CONNECTOR_WORKSPACE_ID');
      requireValue('SOURCE_CONNECTOR_ADMIN_TOKEN');
      checkUrl('SOURCE_CONNECTOR_SUBSCRIPTIONS_URL', ['https:']);
      if (value('SOURCE_AUTOMATION_ENABLED') !== 'true') invalid.push('SOURCE_AUTOMATION_ENABLED');
    }
    const concurrency = Number(env.WORKER_CONCURRENCY ?? 2);
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) invalid.push('WORKER_CONCURRENCY');
    // Optional providers: all-or-nothing, and only over HTTPS (transcripts and audio leave the worker).
    if (value('TRANSCRIPTION_API_URL') || value('TRANSCRIPTION_API_KEY')) {
      requireValue('TRANSCRIPTION_API_KEY');
      checkUrl('TRANSCRIPTION_API_URL', ['https:']);
    }
    if (value('HIGHLIGHT_LLM_URL') || value('HIGHLIGHT_LLM_API_KEY') || value('HIGHLIGHT_LLM_MODEL')) {
      requireValue('HIGHLIGHT_LLM_API_KEY');
      requireValue('HIGHLIGHT_LLM_MODEL');
      checkUrl('HIGHLIGHT_LLM_URL', ['https:']);
    }
    // Auto-publish is now a per-workspace setting; the old single-workspace switches must not linger silently.
    for (const removed of ['SOURCE_AUTOMATION_PUBLISH_WORKSPACE_ID', 'YOUTUBE_AUTO_CLIP_WORKSPACE_ID']) {
      if (value(removed)) invalid.push(`${removed} (replaced by workspace settings; remove it)`);
    }
  }

  if (invalid.length) throw new Error(`Invalid production ${service} settings: ${[...new Set(invalid)].join(', ')}`);
}
