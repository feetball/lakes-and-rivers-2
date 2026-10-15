#!/usr/bin/env node
// Renders resources/icon.svg into the PNG sources @capacitor/assets expects,
// so `pnpm mobile:assets` can generate every iOS/Android icon + splash size:
//
//   resources/icon.png              1024×1024  iOS/Android launcher icon
//   resources/icon-foreground.png   1024×1024  Android adaptive-icon foreground
//   resources/icon-background.png   1024×1024  Android adaptive-icon background
//   resources/splash.png            2732×2732  launch screen (icon centred)
//   resources/splash-dark.png       2732×2732  same (the app is dark either way)
//   resources/icon-512.png           512×512   Google Play listing icon (upload by hand)
//
// Re-run after editing icon.svg. Uses sharp (already a dependency via Next).

import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../resources');
const svg = readFileSync(resolve(DIR, 'icon.svg'));
const BG = '#0b1220';

async function png(name, image) {
  const out = resolve(DIR, name);
  await image.png().toFile(out);
  console.log(`wrote ${out}`);
}

// Full icon, plus the exact 512² Google Play Console wants for the listing.
await png('icon.png', sharp(svg).resize(1024, 1024));
await png('icon-512.png', sharp(svg).resize(512, 512));

// Adaptive icon: Android masks the outer ~1/3, so the foreground is the same
// art (its content already sits in the safe zone) and the background is the
// flat brand colour. Same 1024² size requirement for both.
await png('icon-foreground.png', sharp(svg).resize(1024, 1024));
await png(
  'icon-background.png',
  sharp({ create: { width: 1024, height: 1024, channels: 4, background: BG } }),
);

// Splash: brand background with the icon art at ~1/3 width in the centre.
const splashSize = 2732;
const art = await sharp(svg).resize(900, 900).png().toBuffer();
for (const name of ['splash.png', 'splash-dark.png']) {
  await png(
    name,
    sharp({ create: { width: splashSize, height: splashSize, channels: 4, background: BG } })
      .composite([{ input: art, gravity: 'centre' }]),
  );
}
