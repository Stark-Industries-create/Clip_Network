'use client';

import * as React from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { cn } from '@/lib/utils';

const FIELD = 'input:not([type="hidden"]), select, textarea, button[role="switch"], button[role="combobox"]';

/**
 * Form label. With `htmlFor`, it labels that control. Without it, the label links itself to the first
 * control that follows it in the same field group, so screen readers announce the label instead of a
 * placeholder and clicking the label focuses the field.
 */
export const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, htmlFor, ...props }, forwardedRef) => {
  const innerRef = React.useRef<HTMLLabelElement | null>(null);
  const generatedId = React.useId();
  React.useLayoutEffect(() => {
    const label = innerRef.current;
    if (htmlFor || !label?.parentElement) return;
    // Look only after the label, inside its own field group.
    let control: Element | null = null;
    for (let node = label.nextElementSibling; node && !control; node = node.nextElementSibling) {
      control = node.matches(FIELD) ? node : node.querySelector(FIELD);
    }
    if (!control) return;
    if (!control.id) control.id = `field${generatedId.replace(/:/g, '')}`;
    label.setAttribute('for', control.id);
  });
  return (
    <LabelPrimitive.Root
      ref={(node) => {
        innerRef.current = node;
        if (typeof forwardedRef === 'function') forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      }}
      htmlFor={htmlFor}
      className={cn('text-xs font-medium leading-none text-muted-foreground', className)}
      {...props}
    />
  );
});
Label.displayName = LabelPrimitive.Root.displayName;
