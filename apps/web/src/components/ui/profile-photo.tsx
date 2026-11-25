'use client';

import React, { useState } from 'react';
import { Facebook, Instagram, Music2, Twitch, Twitter, Youtube, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';

/** A platform's profile photo, or the name's initials when there is none or it fails to load. */
export function ProfilePhoto({ src, name, size = 36, className }: { src?: string | null; name: string; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const initials = name.replace(/^@/, '').split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || '?';
  const style = { width: size, height: size };
  if (src && !failed) {
    return (
      // Platform CDNs serve these images directly; they are not optimized through Next.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt="" width={size} height={size} style={style} loading="lazy" referrerPolicy="no-referrer"
        onError={() => setFailed(true)} className={cn('shrink-0 rounded-full bg-muted object-cover', className)} />
    );
  }
  return (
    <span aria-hidden="true" style={{ ...style, fontSize: Math.max(10, size * 0.38) }}
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full bg-primary/15 font-semibold text-primary', className)}>
      {initials}
    </span>
  );
}

const PLATFORM_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  YOUTUBE: Youtube, YOUTUBE_SHORTS: Youtube, TWITCH: Twitch, KICK: Zap,
  INSTAGRAM_REELS: Instagram, FACEBOOK_REELS: Facebook, TIKTOK: Music2, X: Twitter,
};

/** The platform's mark, for labelling channels and destinations. */
export function PlatformIcon({ platform, className }: { platform: string; className?: string }) {
  const Icon = PLATFORM_ICONS[platform] ?? Zap;
  return <Icon className={cn('h-3.5 w-3.5', className)} aria-hidden="true" />;
}

/** A recording or clip thumbnail with a neutral placeholder when the platform gave none. */
export function Thumbnail({ src, className }: { src?: string | null; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <span aria-hidden="true" className={cn('block shrink-0 rounded-md bg-muted', className)} />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)}
    className={cn('block shrink-0 rounded-md bg-muted object-cover', className)} />;
}
