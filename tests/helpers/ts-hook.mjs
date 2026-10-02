// Module-resolution hook for the node:test files (see ts-imports.mjs): lets Node
// load the app's TypeScript the way the bundler does, i.e. relative imports
// without an extension ('./floodStatus') and the '@/' alias for src/. Node's own
// type stripping handles the types; it just does not guess extensions.
import { existsSync } from 'node:fs';
import { dirname, extname, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = resolvePath(dirname(fileURLToPath(import.meta.url)), '../../src');
const SUFFIXES = ['.ts', '.tsx', '/index.ts'];

function locate(base) {
  if (extname(base) && existsSync(base)) return base;
  return SUFFIXES.map((s) => base + s).find((p) => existsSync(p)) ?? null;
}

export async function resolve(specifier, context, nextResolve) {
  let file = null;
  if (specifier.startsWith('@/')) {
    file = locate(resolvePath(SRC, specifier.slice(2)));
  } else if (/^\.\.?\//.test(specifier) && context.parentURL?.startsWith('file:')) {
    file = locate(resolvePath(dirname(fileURLToPath(context.parentURL)), specifier));
  }
  return nextResolve(file ? pathToFileURL(file).href : specifier, context);
}
