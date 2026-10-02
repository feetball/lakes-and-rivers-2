// Import this FIRST in a test file that loads app modules which import each other:
//
//   import './helpers/ts-imports.mjs';
//   const { categorizeByStage } = await import('../src/lib/floodStatus.ts');
//
// The app module has to come through a dynamic import() so it is resolved after
// the hook below is registered (static imports are all resolved up front).
// Modules that import only types (tests/vectorTiles.test.mjs) don't need it.
import { register } from 'node:module';

register('./ts-hook.mjs', import.meta.url);
