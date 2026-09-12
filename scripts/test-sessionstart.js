#!/usr/bin/env node
/* Proof for "Cast to TV after the film is already playing does nothing".
 *
 * The rule lives in assets/js/castaction.js (onSession) and is driven here
 * from the shipped file. The case that was broken: the person taps Cast with
 * a film loaded and picks a TV that still holds this app's receiver — the SDK
 * calls that SESSION_RESUMED, and only SESSION_STARTED used to send.
 *
 *   node scripts/test-sessionstart.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { onSession } = require(path.join(__dirname, '..', 'assets/js/castaction.js'));
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'assets/js/app.js'), 'utf8');

let passed = 0;
const failures = [];
function t(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const S = 'SESSION_STARTED', R = 'SESSION_RESUMED';

t('tap Cast with a film loaded, TV joins as RESUMED → send it (the bug)', () => {
  assert.deepStrictEqual(onSession(R, { asked: true, hadTarget: true }), { send: true, adopt: false });
});
t('tap Cast with a film loaded, fresh STARTED → send it', () => {
  assert.deepStrictEqual(onSession(S, { asked: true, hadTarget: true }), { send: true, adopt: false });
});
t('app reopens over a film already on the TV (RESUMED, not asked, nothing loaded) → adopt, never send', () => {
  assert.deepStrictEqual(onSession(R, { asked: false, hadTarget: false }), { send: false, adopt: true });
});
t('RESUMED nobody asked for, with a film on the phone → do not overwrite the TV', () => {
  assert.strictEqual(onSession(R, { asked: false, hadTarget: true }).send, false);
});
t('tap Cast with nothing loaded → send nothing, do not adopt a stored row', () => {
  assert.deepStrictEqual(onSession(S, { asked: true, hadTarget: false }), { send: false, adopt: false });
  assert.deepStrictEqual(onSession(R, { asked: true, hadTarget: false }), { send: false, adopt: true });
});
t('auto-join STARTED with a film loaded → still sends (old behaviour kept)', () => {
  assert.strictEqual(onSession(S, { asked: false, hadTarget: true }).send, true);
});
t('other states do nothing', () => {
  for (const st of ['SESSION_STARTING', 'SESSION_ENDED', 'SESSION_START_FAILED', 'SESSION_ENDING']) {
    assert.deepStrictEqual(onSession(st, { asked: true, hadTarget: true }), { send: false, adopt: false });
  }
});
t('never both send and adopt (adopt replaces the loaded film with the stored row)', () => {
  for (const st of [S, R]) for (const asked of [true, false]) for (const hadTarget of [true, false]) {
    const p = onSession(st, { asked, hadTarget });
    assert.ok(!(p.send && p.adopt), JSON.stringify({ st, asked, hadTarget }));
  }
});

/* The wiring, read from app.js: the handler sends on the plan, not on the
   event name, and carries the proxy decision load() and the button use. */
t('app.js sends on plan.send, not on SESSION_STARTED alone', () => {
  assert.ok(/if \(plan\.send\) \{/.test(appSrc), 'plan.send branch missing');
  assert.ok(!/SESSION_STARTED && hadTarget/.test(appSrc), 'old STARTED-only gate still present');
});
t('app.js adopts on plan.adopt', () => {
  assert.ok(/if \(restored && plan\.adopt\) adoptIfRejoined\(\)/.test(appSrc));
});
t('the session-start cast keeps viaProxy', () => {
  const m = appSrc.match(/if \(plan\.send\) \{[\s\S]*?castLoad\(current,([^;]*)\);/);
  assert.ok(m && /viaProxy: forceProxy/.test(m[1]), 'viaProxy missing on the session-start castLoad');
});
t('the inline fallback agrees with castaction.js on every case', () => {
  const m = appSrc.match(/\|\| function \(st, c\) \{([\s\S]*?)\n      \};/);
  assert.ok(m, 'fallback not found');
  const SS = { SESSION_STARTED: S, SESSION_RESUMED: R };
  // eslint-disable-next-line no-new-func
  const fallback = new Function('SS', 'return function (st, c) {' + m[1] + '\n};')(SS);
  for (const st of [S, R, 'SESSION_ENDED']) for (const asked of [true, false]) for (const hadTarget of [true, false]) {
    const a = onSession(st, { asked, hadTarget });
    const b = fallback(st, { asked, hadTarget });
    assert.deepStrictEqual({ send: !!b.send, adopt: !!b.adopt }, a, JSON.stringify({ st, asked, hadTarget }));
  }
});

console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
process.exit(failures.length ? 1 : 0);
