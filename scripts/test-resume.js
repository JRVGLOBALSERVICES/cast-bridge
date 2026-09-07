#!/usr/bin/env node
/* Proof for the banner above the player: assets/js/resume.js.
 *
 * The fault it exists for, in Rj's words: "You were watching this / 720p ·
 * on 55\" Crystal UHD / Pick it back up — shows this but cast still
 * ongoing." Offering to restart a film that is playing in front of you is
 * worse than saying nothing, and the button under it invites a re-cast that
 * would jump the film back to a remembered position.
 *
 * The rule is a rule about a television in another room, so it lives in a
 * file with no DOM in it and is driven here from the real shipped source.
 * The app.js half — that the rule is asked on every render rather than once
 * at boot — is a wiring question, and is checked against the source below.
 * Those checks are structural, not behavioural, and are labelled as such.
 *
 *   node scripts/test-resume.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const failures = [];
const queue = [];

function check(name, fn) {
  queue.push(async () => {
    try {
      await fn();
      passed += 1;
      console.log('  ok   ' + name);
    } catch (err) {
      failures.push(name + ' — ' + err.message);
      console.log('  FAIL ' + name + ' — ' + err.message);
    }
  });
}
function group(name) { queue.push(async () => console.log('\n' + name)); }

const CBResume = require('../assets/js/resume.js');
const APP = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const SW = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

/* The row Rj was actually shown, reconstructed from the words on his
   screen: a title of "720p", a 55" Samsung, and a position it had reached.
   `maybe` is what the server says once the heartbeat has stopped — which is
   what happens the moment Android freezes the app. */
const RJ_ROW = {
  url: 'https://example.test/bigg-boss-20/720p.m3u8',
  title: '720p',
  device: '55" Crystal UHD',
  position: 930,
  duration: 3600,
  freshness: 'maybe',
  resume_at: 925
};

/* A stand-in for whatever the Cast SDK hands back. The module is only
   allowed to ask whether there is one — anything more and it would start
   duplicating the SDK's own bookkeeping. */
const LIVE_SESSION = { getCastDevice: () => ({ friendlyName: '55" Crystal UHD' }) };

const nameOf = (u) => String(u).split('/').pop();

/* ------------------------------------------------------------------ *
 * the precedence
 * ------------------------------------------------------------------ */

group('the precedence — a live television outranks a remembered row');

check('a live session while a row exists: the banner is not drawn', () => {
  const v = CBResume.view(RJ_ROW, LIVE_SESSION, nameOf);
  assert.strictEqual(v.show, false, 'the banner was drawn over a live cast');
});

check('a live session while a row exists: the row is adopted, not discarded', () => {
  /* Hiding it is only half. The row carries the title the SDK does not,
     so the on-air panel has something to name the film with. */
  const v = CBResume.view(RJ_ROW, LIVE_SESSION, nameOf);
  assert.strictEqual(v.adopt, true);
});

check('the exact card Rj was shown never appears while a session is live', () => {
  const v = CBResume.view(RJ_ROW, LIVE_SESSION, nameOf);
  assert.notStrictEqual(v.action, 'Pick it back up');
  assert.notStrictEqual(v.head, 'You were watching this');
});

check('a stale row does not outrank a live television', () => {
  /* freshness is the phone's opinion, formed while it was asleep. The
     session is the television speaking. */
  for (const fresh of ['live', 'maybe', 'ended', undefined]) {
    const v = CBResume.view(Object.assign({}, RJ_ROW, { freshness: fresh }), LIVE_SESSION, nameOf);
    assert.strictEqual(v.show, false, 'drawn with freshness=' + fresh);
  }
});

check('a live session with no row adopts nothing and draws nothing', () => {
  const v = CBResume.view(null, LIVE_SESSION, nameOf);
  assert.strictEqual(v.show, false);
  assert.strictEqual(v.adopt, false);
});

check('no row and no session: nothing to say', () => {
  const v = CBResume.view(null, null, nameOf);
  assert.strictEqual(v.show, false);
  assert.strictEqual(v.adopt, false);
});

/* ------------------------------------------------------------------ *
 * the two states that ARE a banner
 * ------------------------------------------------------------------ */

group('the copy — only one of the two states is a fact');

check('beating seconds ago: "still playing" is asserted, and offers the remote', () => {
  const v = CBResume.view(Object.assign({}, RJ_ROW, { freshness: 'live' }), null, nameOf);
  assert.strictEqual(v.show, true);
  assert.strictEqual(v.head, 'Still playing on 55" Crystal UHD');
  assert.strictEqual(v.action, 'Take the remote');
});

check('stopped talking: where you were, never a claim about now', () => {
  const v = CBResume.view(RJ_ROW, null, nameOf);
  assert.strictEqual(v.head, 'You were watching this');
  assert.strictEqual(v.sub, '720p · stopped 15:30 in · on 55" Crystal UHD');
  assert.strictEqual(v.action, 'Pick it back up');
});

check('a row with no device says "the TV" rather than the word undefined', () => {
  const v = CBResume.view(Object.assign({}, RJ_ROW, { device: null }), null, nameOf);
  assert.ok(v.sub.endsWith('· on the TV'), v.sub);
  assert.ok(!/undefined|null/.test(v.head + v.sub));
});

check('a row with no title falls back to the name in the address', () => {
  const v = CBResume.view(Object.assign({}, RJ_ROW, { title: '' }), null, nameOf);
  assert.ok(v.sub.startsWith('720p.m3u8'), v.sub);
});

check('a row at the very start omits the position rather than saying 0:00', () => {
  const v = CBResume.view(Object.assign({}, RJ_ROW, { position: 0 }), null, nameOf);
  assert.ok(!/0:00/.test(v.sub), v.sub);
  assert.strictEqual(v.sub, '720p · on 55" Crystal UHD');
});

/* ------------------------------------------------------------------ *
 * the clock — the one the app renders with
 * ------------------------------------------------------------------ */

group('the clock — one implementation, exercised directly');

check('minutes pad their seconds and drop an empty hour', () => {
  assert.strictEqual(CBResume.clock(930), '15:30');
  assert.strictEqual(CBResume.clock(5), '0:05');
  assert.strictEqual(CBResume.clock(60), '1:00');
});

check('an hour in, both fields pad', () => {
  assert.strictEqual(CBResume.clock(3661), '1:01:01');
  assert.strictEqual(CBResume.clock(3600), '1:00:00');
});

check('nonsense floors to the start rather than rendering NaN', () => {
  assert.strictEqual(CBResume.clock(-5), '0:00');
  assert.strictEqual(CBResume.clock(undefined), '0:00');
  assert.strictEqual(CBResume.clock('x'), '0:00');
});

/* ------------------------------------------------------------------ *
 * the wiring — STRUCTURAL checks against the shipped source
 * ------------------------------------------------------------------ */

group('the wiring (structural — these read app.js, they do not run it)');

check('the banner asks the session on every render, not once at boot', () => {
  const fn = APP.slice(APP.indexOf('function renderResume()'));
  const body = fn.slice(0, fn.indexOf('\n  }\n'));
  assert.ok(/CBResume\.view\(restored, castSession\(\)/.test(body),
    'renderResume does not consult the live session');
});

check('CONNECTED re-decides the banner — the event every rejoin fires', () => {
  const at = APP.indexOf('CastContextEventType.CAST_STATE_CHANGED');
  const handler = APP.slice(at, APP.indexOf('});', at));
  assert.ok(/renderResume\(\)/.test(handler),
    'a rejoin seen only as a cast-state change leaves the banner up');
});

check('recognising a running film cannot re-send it', () => {
  /* Adoption sets `current`; the SESSION_STARTED branch casts `current`.
     Reading the target BEFORE adoption is the only thing stopping a rejoin
     from jumping the film back to its remembered position. */
  const at = APP.indexOf('SESSION_STATE_CHANGED');
  const handler = APP.slice(at, at + 4000);
  assert.ok(/var hadTarget = !!current;/.test(handler), 'no pre-adoption read of the target');
  assert.ok(/SESSION_STARTED && hadTarget/.test(handler),
    'the cast branch still tests `current`, which adoption has already changed');
});

check('a session this page asked for is never mistaken for a rejoin', () => {
  /* Otherwise tapping "Cast to TV" with nothing loaded would adopt the
     stored row and announce a film it had not sent. */
  assert.ok(/askedForSession = true;/.test(APP), 'no record of who asked');
  const at = APP.indexOf('SESSION_STATE_CHANGED');
  const handler = APP.slice(at, at + 4000);
  assert.ok(/!askedForSession/.test(handler), 'the handler does not ask who started it');
});

check('there is one clock in the app, not two', () => {
  assert.ok(!/Math\.floor\(sec \/ 3600\)/.test(APP),
    'app.js carries a second copy of the formatter');
  assert.ok(/window\.CBResume\.clock\(sec\)/.test(APP));
});

check('the shell loads resume.js before app.js', () => {
  const r = HTML.indexOf('assets/js/resume.js');
  const a = HTML.indexOf('assets/js/app.js');
  assert.ok(r > -1, 'resume.js is not in the shell');
  assert.ok(r < a, 'resume.js loads after the app that depends on it');
});

check('an installed copy is given the new file and a reason to fetch it', () => {
  assert.ok(SW.includes("'/assets/js/resume.js'"), 'not precached — offline opens would 404');
  assert.ok(/const BUILD = '2026-09-07\.8'/.test(SW), 'BUILD not bumped for this shipment');
});

(async () => {
  console.log('\nresume — what the banner is allowed to say');
  for (const step of queue) await step();
  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) { failures.forEach((f) => console.log('  · ' + f)); process.exit(1); }
})();
