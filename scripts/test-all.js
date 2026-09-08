#!/usr/bin/env node
/* Runs every suite, and runs ALL of them even when one is red.
 *
 * This replaced `a && b && c && d && e`. A fail-fast chain stops at the
 * first failure, so a run with three broken suites reports one and hides
 * the rest — and the next fix looks like it fixed everything, because the
 * chain now dies one step later instead. The number that matters is how
 * many suites are red, and a chain cannot report it.
 *
 *   node scripts/test-all.js
 */

const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
  ['unpack', 'test-unpack.js'],
  ['reissue', 'test-reissue.js'],
  ['deep-reissue', 'test-deepreissue.js'],
  ['poke', 'test-poke.js'],
  ['cookies', 'test-cookies.js'],
  ['subs', 'test-subs.js'],
  ['crawl', 'test-crawl.js'],
  ['nowplaying', 'test-nowplaying.js'],
  ['notify', 'test-notify.js'],
  ['notify-state', 'test-notifystate.js'],
  ['push', 'test-push.js'],
  ['resume', 'test-resume.js'],
  ['self-update', 'test-selfupdate.js'],
  ['watchdog', 'test-watchstream.js']
];

const results = [];

for (const [name, file] of SUITES) {
  console.log('\n── ' + name + ' ' + '─'.repeat(Math.max(0, 60 - name.length)));
  const run = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
  results.push({ name, ok: run.status === 0, code: run.status });
}

console.log('\n' + '='.repeat(64));
const red = results.filter((r) => !r.ok);
for (const r of results) console.log(' ' + (r.ok ? 'PASS' : 'FAIL') + '  ' + r.name);
console.log('='.repeat(64));

if (red.length) {
  console.log(red.length + ' of ' + results.length + ' suites failed: ' +
    red.map((r) => r.name).join(', '));
  process.exit(1);
}
console.log(results.length + ' suites passed');
