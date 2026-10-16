// The bottom sheets (gauge, webcam, warnings, gauge list) sit on the bottom edge
// with their background running under the home indicator / gesture bar; each
// pads its content by the bottom inset. These keep the rest of the sheet out of
// the other safe-area insets, on iOS and on Android (where the web view also
// runs edge to edge).

/** `left` / `right`: clear of a landscape notch, camera cutout or Android's side navigation bar. */
export const SHEET_LEFT = 'env(safe-area-inset-left, 0px)';
export const SHEET_RIGHT = 'env(safe-area-inset-right, 0px)';

/** `maxHeight` (or `height`): `dvh` of the screen, but never up into the status bar / notch. */
export function sheetHeight(dvh: number): string {
  return `min(${dvh}dvh, calc(100dvh - env(safe-area-inset-top, 0px) - 12px))`;
}
