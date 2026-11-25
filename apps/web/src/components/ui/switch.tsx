'use client';

import * as React from 'react';
import * as SwitchPrimitives from '@radix-ui/react-switch';
import { cn } from '@/lib/utils';

/**
 * Toggle switch. Most switches sit in a row next to their description instead of in a <label>, which
 * leaves screen readers announcing just "switch". When nothing else names it, the switch takes its
 * name from the text of its row.
 */
export const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, forwardedRef) => {
  const innerRef = React.useRef<HTMLButtonElement | null>(null);
  React.useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el || props['aria-label'] || props['aria-labelledby'] || (el.labels && el.labels.length)) return;
    for (let row = el.parentElement, depth = 0; row && depth < 3; row = row.parentElement, depth++) {
      const text = row.innerText.replace(/\s+/g, ' ').trim();
      if (text) {
        el.setAttribute('aria-label', text.slice(0, 120));
        return;
      }
    }
  });
  return (
    <SwitchPrimitives.Root
      className={cn(
        'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent bg-input shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=checked]:bg-primary',
        className,
      )}
      {...props}
      ref={(node) => {
        innerRef.current = node;
        if (typeof forwardedRef === 'function') forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      }}
    >
      <SwitchPrimitives.Thumb className="pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0" />
    </SwitchPrimitives.Root>
  );
});
Switch.displayName = SwitchPrimitives.Root.displayName;
