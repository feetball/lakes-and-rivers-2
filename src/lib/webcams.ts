import type { Webcam, WebcamFrame } from '@/lib/types';

// Modern NIMS API — long-term correct endpoint, but currently unreachable
// from this sandbox (network egress blocked). Try it first anyway so
// production always prefers the endpoint USGS intends to keep.
const MODERN_BASE = process.env.NIMS_API_BASE || 'https://api.waterdata.usgs.gov/nims/v0';
// Legacy NIMS API — reachable today; USGS has said it will be sunset "after
// July 2026". Used as the fallback when the modern base fails for any reason.
const LEGACY_BASE =
  process.env.NIMS_LEGACY_API_BASE || 'https://jj5utwupk5.execute-api.us-east-1.amazonaws.com/prod';
const TIMEOUT_MS = Number(process.env.WEBCAMS_TIMEOUT_MS) || 15_000;

const s3Dir = (sub: string, camId: string) => `https://usgs-nims-images.s3.amazonaws.com/${sub}/${camId}/`;
const defaultSmallDir = (camId: string) => s3Dir('720', camId);
const defaultThumbDir = (camId: string) => s3Dir('thumbnail', camId);

// Join a directory prefix (which may or may not end in '/') to a filename,
// producing exactly one separating slash.
function joinUrl(dir: string, filename: string): string {
  return `${dir.replace(/\/+$/, '')}/${filename.replace(/^\/+/, '')}`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': 'texas-flood-map/0.1' },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`NIMS ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

// Try the modern NIMS base first; on ANY failure (non-ok, timeout, network,
// bad JSON) fall back to the legacy base. Matches the same idiom as
// gauges-fetch's multi-attempt fetch, just across two hosts instead of retries.
async function fetchFromEitherBase<T>(path: string): Promise<T> {
  try {
    return await fetchJson<T>(`${MODERN_BASE}${path}`);
  } catch {
    return await fetchJson<T>(`${LEGACY_BASE}${path}`);
  }
}

// Derive the NIMS still-image filename from a camera's newestImageDT, e.g.
// "2026-07-16T17:30:06.000Z" -> "TX_Foo___2026-07-16T17-30-06Z.jpg"
// (truncate milliseconds, then replace ':' with '-' in the time part).
function filenameFromTimestamp(camId: string, iso: string): string | null {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  const noMs = new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'); // 2026-07-16T17:30:06Z
  const dashed = noMs.replace(/:/g, '-'); // 2026-07-16T17-30-06Z
  return `${camId}___${dashed}.jpg`;
}

// Inverse-ish of filenameFromTimestamp: pull the timestamp back out of a
// listFiles filename ("..._camId___2026-07-16T17-30-06Z.jpg") and rebuild a
// real ISO string (time-part '-' -> ':'). Returns null takenAt when the
// filename doesn't match the expected NIMS naming convention.
const FRAME_FILENAME_RE = /___(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z\.[A-Za-z0-9]+$/;

export function frameFromFilename(camId: string, filename: string): WebcamFrame {
  const m = FRAME_FILENAME_RE.exec(filename);
  const takenAt = m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z` : null;
  return {
    filename,
    url: joinUrl(defaultSmallDir(camId), filename),
    takenAt,
  };
}

export async function fetchWebcamsUpstream(): Promise<Webcam[]> {
  const raw = await fetchFromEitherBase<unknown[]>('/cameras');
  if (!Array.isArray(raw)) return [];

  const out: Webcam[] = [];
  for (const entry of raw) {
    const c = entry as Record<string, unknown>;
    if (!c || typeof c !== 'object') continue;
    if (c.hideCam === true) continue;

    const camId = typeof c.camId === 'string' && c.camId ? c.camId : null;
    if (!camId) continue;

    const isTexas = c.stateAbrv === 'TX' || camId.startsWith('TX_');
    if (!isTexas) continue;

    const lat = Number(c.lat);
    const lon = Number(c.lng); // upstream field is `lng`; our type uses `lon`
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const name =
      typeof c.camName === 'string' && c.camName.trim() ? c.camName : camId.replace(/_/g, ' ');
    const smallDir = typeof c.smallDir === 'string' && c.smallDir ? c.smallDir : defaultSmallDir(camId);
    const thumbDir = typeof c.thumbDir === 'string' && c.thumbDir ? c.thumbDir : defaultThumbDir(camId);
    const newestImageAt = typeof c.newestImageDT === 'string' ? c.newestImageDT : null;
    const filename = newestImageAt ? filenameFromTimestamp(camId, newestImageAt) : null;

    out.push({
      id: camId,
      name,
      description: typeof c.camDesc === 'string' && c.camDesc ? c.camDesc : null,
      lat,
      lon,
      nwisId: typeof c.nwisId === 'string' && c.nwisId ? c.nwisId : null,
      imageUrl: filename ? joinUrl(smallDir, filename) : null,
      thumbUrl: filename ? joinUrl(thumbDir, filename) : null,
      hivisUrl: `https://apps.usgs.gov/hivis/camera/${camId}`,
      hasTimelapse: c.TL_enabled === true,
      newestImageAt,
    });
  }
  return out;
}

export async function fetchWebcamFrames(camId: string, limit: number): Promise<WebcamFrame[]> {
  const params = new URLSearchParams({ camId, limit: String(limit), recent: 'true' });
  const filenames = await fetchFromEitherBase<unknown[]>(`/listFiles?${params.toString()}`);
  if (!Array.isArray(filenames)) return [];
  return filenames.filter((f): f is string => typeof f === 'string').map(f => frameFromFilename(camId, f));
}
