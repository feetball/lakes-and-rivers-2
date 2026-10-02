// The round controls stacked down the right edge of the map, top to bottom. Each takes a
// slot so they never overlap and the next feature only has to claim an unused number:
//
//   0  locate me (LocateButton)
//   1  gauge list: favorites, near me, search (GaugeListControl)
//   2  reserved for the alerts bell
//
// A control is 44 px (Apple's minimum touch target) with an 8 px gap, so slots are 52 px apart.
const SLOT_PITCH_PX = 52;

/** CSS `top` of the control in `slot`, clear of the iPhone notch / status bar. */
export function controlTop(slot: number): string {
  return `calc(env(safe-area-inset-top, 0px) + 12px + ${slot * SLOT_PITCH_PX}px)`;
}
