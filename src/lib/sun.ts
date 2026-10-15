// Where the sun is, for one question: was it dark when this camera took its photo?
// A river camera at night shows a black or grayscale frame, which reads as a broken
// camera unless the sheet says why. The capture time and the camera's position are all
// that is needed, and the answer does not depend on the camera's (unreliable) time zone
// field or on reading pixels, which a cross-origin image does not allow.
//
// Pure maths and no imports, so tests/sun.test.mjs runs it directly under Node.

const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;

/**
 * Height of the sun's centre above the horizon, in degrees (negative = below it), at a
 * UTC instant and a place. The low-precision formulas of NOAA's solar calculator
 * (Meeus, "Astronomical Algorithms"): within about 0.1 degree for the present era,
 * with no allowance for atmospheric refraction. Plenty for "is it dark".
 */
export function sunElevationDeg(atMs: number, latDeg: number, lonDeg: number): number {
  const jd = atMs / DAY_MS + 2440587.5; // Julian day
  const t = (jd - 2451545.0) / 36525; // Julian centuries since J2000.0

  const meanLong = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const meanAnomaly = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const m = meanAnomaly * RAD;
  const centre =
    Math.sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m) * 0.000289;
  const omega = (125.04 - 1934.136 * t) * RAD;
  const apparentLong = (meanLong + centre - 0.00569 - 0.00478 * Math.sin(omega)) * RAD;
  const meanObliquity = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliquity = (meanObliquity + 0.00256 * Math.cos(omega)) * RAD;
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(apparentLong));

  // Equation of time, in minutes: how far the true sun runs ahead of or behind the clock sun.
  const y = Math.tan(obliquity / 2) ** 2;
  const l0 = meanLong * RAD;
  const eqTime =
    (4 / RAD) *
    (y * Math.sin(2 * l0) -
      2 * eccentricity * Math.sin(m) +
      4 * eccentricity * y * Math.sin(m) * Math.cos(2 * l0) -
      0.5 * y * y * Math.sin(4 * l0) -
      1.25 * eccentricity * eccentricity * Math.sin(2 * m));

  const utcMinutes = ((atMs % DAY_MS) + DAY_MS) % DAY_MS / 60_000;
  const trueSolarMinutes = (((utcMinutes + eqTime + 4 * lonDeg) % 1440) + 1440) % 1440;
  const hourAngle = (trueSolarMinutes / 4 - 180) * RAD;

  const lat = latDeg * RAD;
  const sinElevation =
    Math.sin(lat) * Math.sin(declination) + Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle);
  return Math.asin(Math.max(-1, Math.min(1, sinElevation))) / RAD;
}

/**
 * Below this the sky is too dark for an ordinary camera to show the river. Sunset is 0.8
 * degrees; "civil twilight" ends at 6, but an unlit camera is already struggling at 4.
 */
export const DARK_BELOW_DEG = -4;

/** True when the sun was far enough below the horizon that a still photo is probably dark. */
export function isDarkAt(atMs: number, latDeg: number, lonDeg: number): boolean {
  return sunElevationDeg(atMs, latDeg, lonDeg) < DARK_BELOW_DEG;
}
