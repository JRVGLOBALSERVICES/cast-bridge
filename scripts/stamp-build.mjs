/* Writes the deployed commit into sw.js at build time.
 *
 * BUILD is what makes an installed copy notice a new version: a
 * byte-identical service worker is never re-installed, so an app whose
 * BUILD is edited by hand keeps serving the old shell every time someone
 * forgets. Deriving it from the commit removes the chance to forget.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const sha = (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7);
const build = sha || new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

const path = new URL('../sw.js', import.meta.url);
const src = readFileSync(path, 'utf8');

const next = src.replace(
  /^const BUILD = '[^']*';$/m,
  "const BUILD = '" + build + "';"
);

if (next === src) {
  console.error('stamp-build: BUILD line not found in sw.js — refusing to ship an unstamped worker.');
  process.exit(1);
}

writeFileSync(path, next);
console.log('stamp-build: BUILD = ' + build);
