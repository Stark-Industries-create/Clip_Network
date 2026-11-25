const SPECIAL: Record<string, string> = {
  CENTER_CROP_9_16: 'Center crop 9:16',
  SPLIT_FACECAM_BOTTOM: 'Split, facecam bottom',
  PUBLISHED_LIVE: 'Published',
  PUBLISHED_SANDBOX: 'Published (sandbox)',
  SANDBOX_SIMULATED: 'Sandbox',
  LIVE_OAUTH: 'Live',
};

/** Turn an internal enum value such as AWAITING_APPROVAL into reader text ("Awaiting approval"). */
export function humanize(value: string | null | undefined): string {
  if (!value) return '';
  if (SPECIAL[value]) return SPECIAL[value];
  if (!/^[A-Z0-9_]+$/.test(value)) return value;
  const text = value.toLowerCase().replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
