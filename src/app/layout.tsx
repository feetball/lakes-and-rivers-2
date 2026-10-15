import type { Metadata, Viewport } from 'next';
import './globals.css';
import 'leaflet/dist/leaflet.css';
import { VECTOR_TILE_URL } from '@/lib/api';

// Open the connection to the tile server while the HTML is still being parsed, so the
// first tile does not wait for DNS + TCP + TLS after the JavaScript has loaded.
// crossOrigin must match the anonymous CORS fetch the map makes, or the browser will
// not reuse the connection.
const TILE_ORIGIN = (() => {
  try {
    return VECTOR_TILE_URL ? new URL(VECTOR_TILE_URL).origin : null;
  } catch {
    return null;
  }
})();

export const metadata: Metadata = {
  title: 'Texas Flood Map',
  description: 'Live flood-stage status for Texas rivers, creeks, and lakes.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  themeColor: '#0b1220',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>{TILE_ORIGIN && <link rel="preconnect" href={TILE_ORIGIN} crossOrigin="anonymous" />}</head>
      <body>{children}</body>
    </html>
  );
}
