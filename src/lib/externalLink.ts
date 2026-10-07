// Links that leave the app (weather.gov, NOAA gauge pages, the privacy policy...).
//
// On the web they are ordinary target=_blank links. In the store apps a plain link would
// hand the user over to Safari / Chrome and out of the app, so there they open in the
// in-app browser sheet (SFSafariViewController on iOS, a Custom Tab on Android) through
// @capacitor/browser, and closing the sheet puts the user back on the map. The plugin is
// imported lazily so the web bundle never pays for it.

import type { MouseEvent } from 'react';
import { IS_MOBILE } from '@/lib/api';

// Public pages on the website. Absolute even in the apps: the app bundle has no copy of them.
export const SITE_ORIGIN = 'https://txfloods.kuecker.us';
export const PRIVACY_URL = `${SITE_ORIGIN}/privacy`;
export const SUPPORT_URL = `${SITE_ORIGIN}/support`;

export async function openExternal(url: string): Promise<void> {
  if (IS_MOBILE) {
    try {
      const { Browser } = await import('@capacitor/browser');
      await Browser.open({ url });
      return;
    } catch {
      // fall through: the system browser is still better than a dead link
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * onClick for an <a href target="_blank">: in the apps, opens the in-app browser instead.
 * The href stays on the element so long-press, accessibility and the web keep working.
 */
export function onExternalLinkClick(e: MouseEvent<HTMLAnchorElement>): void {
  if (!IS_MOBILE) return;
  e.preventDefault();
  void openExternal(e.currentTarget.href);
}
