'use client';

import { useEffect, useRef } from 'react';

/**
 * Re-run `callback` every `intervalMs` while `enabled`, but never while the tab is hidden. When the
 * tab becomes visible again it runs once at once, so a returning user sees fresh data without waiting.
 * Pages enable it only while something is actually in progress, so idle pages make no requests.
 */
export function usePolling(callback: () => unknown, intervalMs: number, enabled: boolean) {
  const latest = useRef(callback);
  latest.current = callback;

  useEffect(() => {
    if (!enabled) return;
    const run = () => {
      if (document.visibilityState === 'visible') void Promise.resolve(latest.current()).catch(() => undefined);
    };
    const timer = setInterval(run, intervalMs);
    const onVisible = () => { if (document.visibilityState === 'visible') run(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, intervalMs]);
}
