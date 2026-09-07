/* Assembles the static output and stamps the service worker's BUILD.
 *
 * BUILD is what makes an installed copy notice a new version: a
 * byte-identical service worker is never re-installed, so an app whose
 * BUILD is edited by hand keeps serving the old shell every time someone
 * forgets. Deriving it from the commit removes the chance to forget.
 *
 * The copy step exists because setting a buildCommand makes Vercel look for
 * an output directory, and pointing that at the repo root would publish
 * node_modules as static files.
 */

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public');

/* Everything the browser is allowed to fetch directly. Anything not named
   here does not ship — which is the point of listing it rather than
   excluding node_modules and hoping. */
const STATIC = [
  'index.html',
  'sw.js',
  'manifest.json',
  'favicon.ico',
  'robots.txt',
  'llms.txt',
  'assets'
];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

for (const name of STATIC) {
  const from = join(ROOT, name);
  if (!existsSync(from)) {
    console.error('stamp-build: missing ' + name + ' — refusing to ship an incomplete shell.');
    process.exit(1);
  }
  cpSync(from, join(OUT, name), { recursive: true });
}

const sha = (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7);
const build = sha || new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

const swPath = join(OUT, 'sw.js');
const src = readFileSync(swPath, 'utf8');
const next = src.replace(/^const BUILD = '[^']*';$/m, "const BUILD = '" + build + "';");

if (next === src) {
  console.error('stamp-build: BUILD line not found in sw.js — refusing to ship an unstamped worker.');
  process.exit(1);
}

writeFileSync(swPath, next);
console.log('stamp-build: BUILD = ' + build + ', ' + STATIC.length + ' entries copied to public/');
