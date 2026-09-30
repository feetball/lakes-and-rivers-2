import type { CapacitorConfig } from '@capacitor/cli';
import pkg from './package.json';

// Capacitor wraps the static export in out/ (built by scripts/build-mobile.mjs)
// in a native iOS / Android shell. See docs/mobile-app.md for the full build
// and store-submission walkthrough.
const config: CapacitorConfig = {
  // Reverse-DNS bundle id. Becomes the iOS Bundle Identifier and the Android
  // applicationId, and is PERMANENT once an app has been uploaded to either
  // store — change it before the first upload if you want something else.
  appId: 'com.texasfloodmap.app',
  appName: 'Texas Flood Map',
  webDir: 'out',
  // Shown behind the web view before the first paint; matches globals.css.
  backgroundColor: '#0b1220',
  // Identify the app in every request the web view makes. Tile providers
  // (OpenStreetMap's usage policy in particular) require a distinct, stable
  // User-Agent naming the app rather than the stock WebView string.
  appendUserAgent: `TexasFloodMap/${pkg.version}`,
  ios: {
    // Default, stated explicitly: the web view runs edge-to-edge and the CSS
    // positions overlays with env(safe-area-inset-*) itself.
    contentInset: 'never',
    // Never let iPadOS request the desktop site.
    preferredContentMode: 'mobile',
  },
  plugins: {
    SystemBars: {
      // The layout already uses viewport-fit=cover (src/app/layout.tsx), so
      // tell Android's inset handling up front and avoid a layout jump.
      initialViewportFitValueHint: 'cover',
    },
  },
};

export default config;
