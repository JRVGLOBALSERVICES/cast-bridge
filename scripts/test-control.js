#!/usr/bin/env node
/* The restart / pull buttons on the stream host page (server/control.js).
 *
 * Driven against throwaway git clones, and the restart command is ALWAYS
 * injected. The literal `pm2 restart cast-stream` must never run from a test:
 * on 2026-09-15 a test that did cut off a film being watched.
 *
 *   node scripts/test-control.js
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
function check(name, cond, detail) {
  if (cond) return console.log('  ok   ' + name);
  failures++;
  console.log('  FAIL ' + name + (detail ? '\n         ' + detail : ''));
}

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'control-'));
const origin = path.join(root, 'origin');
fs.mkdirSync(origin);
git(origin, 'init', '-q', '-b', 'main');
git(origin, 'config', 'user.email', 't@example.com');
git(origin, 'config', 'user.name', 't');
fs.writeFileSync(path.join(origin, 'app.js'), 'one\n');
git(origin, 'add', '-A');
git(origin, 'commit', '-q', '-m', 'one');
const clone = path.join(root, 'clone');
git(root, 'clone', '-q', origin, clone);
git(clone, 'config', 'user.email', 't@example.com');
git(clone, 'config', 'user.name', 't');
fs.writeFileSync(path.join(origin, 'app.js'), 'two\n');
git(origin, 'commit', '-q', '-am', 'second change');

const marker = path.join(root, 'restarted');
process.env.CAST_REPO = clone;
process.env.CAST_RESTART_CMD = 'touch ' + marker;
process.env.CAST_IDLE_MIN_S = '1200';
const control = require('../server/control.js');

(async () => {
  console.log('control: the default restart command is never what a test runs');
  check('injected command wins', control.restartCmd() === 'touch ' + marker, control.restartCmd());

  console.log('control: busy');
  check('a stream in flight is busy', control.busy({ inFlight: 1, idleS: 5000 }).busy === true);
  check('a TV quiet between reads is busy', control.busy({ inFlight: 0, idleS: 420 }).busy === true);
  check('never streamed is not busy', control.busy({ inFlight: 0, idleS: null }).busy === false);
  check('20+ min quiet is not busy', control.busy({ inFlight: 0, idleS: 1300 }).busy === false);

  console.log('control: status');
  const s = await control.status({ fetch: true });
  check('sees 1 behind', s.behind === 1, JSON.stringify(s));
  check('not ahead, not dirty', s.ahead === 0 && s.dirty === false);
  check('lists the commit it would pull', s.commits.length === 1 && s.commits[0].subject === 'second change');

  console.log('control: update refuses a dirty tree');
  fs.writeFileSync(path.join(clone, 'app.js'), 'local edit\n');
  const blocked = await control.update();
  check('409 blocked', blocked.status === 409 && blocked.body.blocked === true, JSON.stringify(blocked));
  check('did not pull over the edit', fs.readFileSync(path.join(clone, 'app.js'), 'utf8') === 'local edit\n');
  git(clone, 'checkout', '--', 'app.js');

  console.log('control: untracked runtime files do not block');
  fs.mkdirSync(path.join(clone, 'data'), { recursive: true });
  fs.writeFileSync(path.join(clone, 'data', 'runtime.json'), '{}');

  console.log('control: update fast-forwards');
  const up = await control.update();
  check('200 ok', up.status === 200 && up.body.ok === true, JSON.stringify(up));
  check('pulled one commit', up.body.pulled === 1);
  check('file is the new version', fs.readFileSync(path.join(clone, 'app.js'), 'utf8') === 'two\n');
  check('logged the button', /BUTTON updated/.test(fs.readFileSync(path.join(clone, 'data', 'self-update.log'), 'utf8')));

  const again = await control.update();
  check('second press is up to date', again.body.up_to_date === true, JSON.stringify(again));

  console.log('control: restart runs detached');
  control.scheduleRestart(0);
  let seen = false;
  for (let i = 0; i < 30 && !seen; i++) {
    await new Promise((r) => setTimeout(r, 100));
    seen = fs.existsSync(marker);
  }
  check('injected restart command ran', seen);

  fs.rmSync(root, { recursive: true, force: true });
  console.log(failures ? '\n' + failures + ' failure(s)' : '\nall control checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
