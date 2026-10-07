// The round controls stacked down the right edge of the map, top to bottom. Each takes a
// slot so they never overlap and the next feature only has to claim an unused number:
//
//   0  locate me (LocateButton)
//   1  gauge list: favorites, near me, search (GaugeListControl)
//   2  reserved for the alerts bell
//
// A control is 44 px (Apple's minimum touch target) with an 8 px gap, so slots are 52 px apart.
const SLOT_PITCH_PX = 52;

// Side margins for anything pinned to the left or right edge: 12 px, or more when an
// iPhone in landscape puts the notch / Dynamic Island (or the home indicator) on that side.
export const EDGE_LEFT = 'max(12px, env(safe-area-inset-left, 0px))';
export const EDGE_RIGHT = 'max(12px, env(safe-area-inset-right, 0px))';
/** `right` for a banner that must stay clear of the 44 px control column. */
export const CLEAR_OF_CONTROLS_RIGHT = `calc(${EDGE_RIGHT} + 56px)`;

/** CSS `top` of the control in `slot`, clear of the iPhone notch / status bar. */
export function controlTop(slot: number): string {
  return `calc(env(safe-area-inset-top, 0px) + 12px + ${slot * SLOT_PITCH_PX}px)`;
}
