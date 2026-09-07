#!/usr/bin/env node
/* Proof for lib/nowplaying.js — the live session that survives a close.
 *
 * Every rule in that module is a decision about what to CLAIM to somebody
 * about a television this app cannot see, which is exactly the kind of rule
 * that should be provable without a television.
 *
 *   node scripts/test-nowplaying.js
 */

const assert = require('assert');
const np = require('../lib/nowplaying');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok   ' + name);
  } catch (err) {
    failures.push(name + ' — ' + err.message);
    console.log('  FAIL ' + name + ' — ' + err.message);
  }
}

function throws(fn) {
  try { fn(); } catch (e) { return e; }
  return null;
}

const NOW = Date.parse('2026-09-07T12:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const OK = { url: 'https://example.test/a.mp4' };

console.log('\nshape — what the browser may put in the row');

check('keeps a plain https address', () => {
  assert.strictEqual(np.shape(OK).url, 'https://example.test/a.mp4');
});

check('refuses a session with no address', () => {
  assert.ok(throws(() => np.shape({})) instanceof np.InvalidSession);
});

check('refuses a non-http scheme', () => {
  /* file:// and data: are the two that would arrive by accident, from a
     local pick rather than a cast. Neither is a thing a TV can fetch. */
  assert.ok(throws(() => np.shape({ url: 'file:///tmp/a.mp4' })));
  assert.ok(throws(() => np.shape({ url: 'data:video/mp4;base64,AAAA' })));
});

check('refuses an address longer than the column is capped at', () => {
  const long = 'https://x.test/' + 'a'.repeat(np.MAX_URL);
  assert.ok(throws(() => np.shape({ url: long })) instanceof np.InvalidSession);
});

check('defaults state to sending, not to playing', () => {
  /* The important direction. Guessing "playing" would let a load that was
     accepted and never started be offered back as a film on screen. */
  assert.strictEqual(np.shape(OK).state, 'sending');
});

check('refuses a state no receiver reports', () => {
  assert.ok(throws(() => np.shape({ ...OK, state: 'buffering' })) instanceof np.InvalidSession);
  assert.strictEqual(np.shape({ ...OK, state: 'paused' }).state, 'paused');
});

check('refuses a subtitle reference that is not a uuid', () => {
  assert.ok(throws(() => np.shape({ ...OK, subs_id: 'sure' })) instanceof np.InvalidSession);
  const id = '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607';
  assert.strictEqual(np.shape({ ...OK, subs_id: id }).subs_id, id);
});

check('carries the subtitle track so a resume re-attaches it', () => {
  /* A text track cannot be bolted on after a load. Losing this on a reopen
     is a film that comes back with the subtitles silently gone. */
  const id = '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607';
  const s = np.shape({ ...OK, subs_id: id, subs_name: 'ep2.srt' });
  assert.strictEqual(s.subs_name, 'ep2.srt');
});

check('a missing position becomes 0, never the string NaN', () => {
  /* This one goes into a numeric column. "NaN" reaching Postgres is a 400
     from PostgREST at heartbeat time, i.e. the session silently stops
     being remembered while everything on screen looks fine. */
  for (const bad of [undefined, null, 'abc', NaN, Infinity, -5, {}]) {
    const v = np.shape({ ...OK, position: bad }).position;
    assert.strictEqual(typeof v, 'number', String(bad));
    assert.ok(Number.isFinite(v), String(bad));
    assert.strictEqual(v, 0, String(bad));
  }
});

check('a millisecond value pasted into a seconds field is capped', () => {
  assert.strictEqual(np.shape({ ...OK, position: 5400000 }).position, 86400);
});

check('a zero duration survives — that is what a live stream reports', () => {
  assert.strictEqual(np.shape({ ...OK, duration: 0 }).duration, 0);
});

check('trims title and device rather than storing whitespace', () => {
  const s = np.shape({ ...OK, title: '  Episode 2  ', device: '  Lounge TV ' });
  assert.strictEqual(s.title, 'Episode 2');
  assert.strictEqual(s.device, 'Lounge TV');
});

check('an empty title is null, not an empty string', () => {
  assert.strictEqual(np.shape({ ...OK, title: '   ' }).title, null);
});

check('never takes a user_id from the body', () => {
  const s = np.shape({ ...OK, user_id: '00000000-0000-4000-8000-000000000000' });
  assert.ok(!('user_id' in s), 'shape() must not carry a caller-supplied user_id');
});

console.log('\nfreshness — three answers, because the TV is not ours to poll');

check('a beat from five seconds ago is live', () => {
  assert.strictEqual(np.freshness({ updated_at: ago(5000) }, NOW), 'live');
});

check('a beat from two minutes ago is maybe, not live', () => {
  /* The app stopped talking. That is not proof the film stopped — the phone
     is in a pocket. So: offer to look, do not assert. */
  assert.strictEqual(np.freshness({ updated_at: ago(120000) }, NOW), 'maybe');
});

check('a beat from three days ago is ended', () => {
  assert.strictEqual(np.freshness({ updated_at: ago(3 * 24 * 3600 * 1000) }, NOW), 'ended');
});

check('the boundary is inclusive at exactly a minute', () => {
  assert.strictEqual(np.freshness({ updated_at: ago(np.FRESH_MS) }, NOW), 'live');
  assert.strictEqual(np.freshness({ updated_at: ago(np.FRESH_MS + 1) }, NOW), 'maybe');
});

check('a phone whose clock runs fast is live, not ended', () => {
  /* Clock skew between a phone and the server makes updated_at land in the
     future. Read naively that is a negative age; it must not read as stale. */
  assert.strictEqual(np.freshness({ updated_at: new Date(NOW + 30000).toISOString() }, NOW), 'live');
});

check('a row with no timestamp, or an unreadable one, is ended', () => {
  assert.strictEqual(np.freshness(null, NOW), 'ended');
  assert.strictEqual(np.freshness({}, NOW), 'ended');
  assert.strictEqual(np.freshness({ updated_at: 'tuesday' }, NOW), 'ended');
});

console.log('\nresumeAt — where a rejoin picks up');

check('backs off five seconds so nobody resumes mid-sentence', () => {
  /* The last beat landed up to 15s before the app closed. */
  assert.strictEqual(np.resumeAt({ position: 600, duration: 3600 }), 595);
});

check('never returns a negative for a film barely started', () => {
  assert.strictEqual(np.resumeAt({ position: 2, duration: 3600 }), 0);
  assert.strictEqual(np.resumeAt({ position: 0, duration: 3600 }), 0);
});

check('a position at the very end resumes short of it', () => {
  /* Resuming a film AT its duration is a black screen, which reads exactly
     like a cast that failed. */
  const at = np.resumeAt({ position: 3599, duration: 3600 });
  assert.ok(at <= 3590 && at >= 3580, 'expected a little before the end, got ' + at);
});

check('an unknown duration still resumes from the position', () => {
  assert.strictEqual(np.resumeAt({ position: 600, duration: 0 }), 595);
});

console.log('\npresent — what the browser is handed');

check('an ended row is handed back as nothing at all', () => {
  assert.strictEqual(np.present({ url: 'https://x.test/a.mp4', updated_at: ago(1e10) }, NOW), null);
});

check('state and freshness stay separate fields', () => {
  /* Merging them is how a film paused on Tuesday gets announced as paused
     right now. */
  const row = { url: 'https://x.test/a.mp4', state: 'paused', position: 60, duration: 600, updated_at: ago(120000) };
  const out = np.present(row, NOW);
  assert.strictEqual(out.state, 'paused');
  assert.strictEqual(out.freshness, 'maybe');
});

check('a corrupt state in the row reads as sending, not as playing', () => {
  const row = { url: 'https://x.test/a.mp4', state: 'nonsense', updated_at: ago(1000) };
  assert.strictEqual(np.present(row, NOW).state, 'sending');
});

check('present carries the resume point so the caller need not compute it', () => {
  const row = { url: 'https://x.test/a.mp4', position: 900, duration: 3600, updated_at: ago(1000) };
  assert.strictEqual(np.present(row, NOW).resume_at, 895);
});

check('present never leaks the user_id of the row it read', () => {
  const row = { user_id: 'abc', url: 'https://x.test/a.mp4', updated_at: ago(1000) };
  assert.ok(!('user_id' in np.present(row, NOW)));
});

/* ------------------------------------------------------------------------
 * The handler itself, with the database and the session stubbed.
 *
 * Everything above is a pure function. These three rules are not: they live
 * in api/now-playing.js, they are the ones that decide what actually gets
 * written, and two of them cannot be seen from the database at all.
 * ---------------------------------------------------------------------- */

console.log('\nhandler — what reaches the row');

const path = require('path');

let dbCalls = [];
let stored = null;

const fakeDb = {
  DbError: class DbError extends Error {},
  async select() { return stored ? [stored] : []; },
  async remove(p) { dbCalls.push(['remove', p]); stored = null; return []; },
  async request(method, p, opts) {
    dbCalls.push([method, p, opts.body]);
    stored = { ...opts.body };
    return [stored];
  }
};

const ME = { id: '11111111-2222-4333-8444-555555555555', role: 'user' };
const fakeAuth = { async guard() { return ME; } };

require.cache[require.resolve('../lib/db')] = { id: 'db', filename: 'db', loaded: true, exports: fakeDb };
require.cache[require.resolve('../lib/auth')] = { id: 'auth', filename: 'auth', loaded: true, exports: fakeAuth };
const handler = require('../api/now-playing.js');

function call(method, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method,
    url: '/api/now-playing',
    query: {},
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; }
  };
  let out = '';
  const res = {
    statusCode: 200,
    setHeader() {},
    end(s) { out = s || ''; }
  };
  return handler(req, res).then(() => ({ status: res.statusCode, body: out ? JSON.parse(out) : null }));
}

/* Chained, not collected. These cases share one stubbed row between them, so
   starting them all at once lets each one's awaits interleave with the next
   one's setup — which is exactly what happened the first time this ran: a
   case asserting a stale row survives a GET failed because a different case
   had already cleared it. The suite reported a handler defect that did not
   exist. */
let queue = Promise.resolve();
function checkAsync(name, fn) {
  queue = queue.then(() =>
    fn().then(
      () => { passed += 1; console.log('  ok   ' + name); },
      (err) => { failures.push(name + ' — ' + err.message); console.log('  FAIL ' + name + ' — ' + err.message); }
    )
  );
}

checkAsync('a heartbeat for the same film keeps the time it started', async () => {
  /* The rule that cannot be seen from the database. Without it every beat
     resets started_at, so a film that has been on for forty minutes reports
     that it started fifteen seconds ago, forever. */
  stored = null; dbCalls = [];
  await call('PUT', { url: 'https://x.test/a.mp4', title: 'A', position: 10 });
  const first = stored.started_at;
  await new Promise((r) => setTimeout(r, 12));
  await call('PUT', { url: 'https://x.test/a.mp4', title: 'A', position: 25 });
  assert.strictEqual(stored.started_at, first, 'started_at moved on a same-film beat');
  assert.notStrictEqual(stored.updated_at, first, 'updated_at should have moved');
  assert.strictEqual(Number(stored.position), 25);
});

checkAsync('putting a different film on does move the start time', async () => {
  stored = null; dbCalls = [];
  await call('PUT', { url: 'https://x.test/a.mp4', position: 10 });
  const first = stored.started_at;
  await new Promise((r) => setTimeout(r, 12));
  await call('PUT', { url: 'https://x.test/b.mp4', position: 0 });
  assert.notStrictEqual(stored.started_at, first, 'a new film must restart the clock');
});

checkAsync('the row is pinned to the signed session, not to the body', async () => {
  /* The isolation rule. A user_id in the body must be ignored entirely. */
  stored = null; dbCalls = [];
  await call('PUT', { url: 'https://x.test/a.mp4', user_id: '99999999-9999-4999-8999-999999999999' });
  assert.strictEqual(stored.user_id, ME.id);
});

checkAsync('it upserts on the primary key rather than inserting', async () => {
  stored = null; dbCalls = [];
  await call('PUT', { url: 'https://x.test/a.mp4' });
  const write = dbCalls.find((c) => c[0] === 'POST');
  assert.ok(write, 'no write happened');
  assert.ok(/on_conflict=user_id/.test(write[1]), 'expected an upsert, got ' + write[1]);
});

checkAsync('a bad body is a 400, not a 500', async () => {
  stored = null;
  const r = await call('PUT', { url: 'not-a-url' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.ok, false);
});

checkAsync('a GET with no row answers with a null session, not an error', async () => {
  stored = null;
  const r = await call('GET');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.session, null);
});

checkAsync('a GET of a stale row answers null and leaves the row alone', async () => {
  /* Deciding a row is stale is a read-time judgement. Destroying it on a
     page load would end the session of a phone that was in a lift. */
  stored = {
    user_id: ME.id, url: 'https://x.test/a.mp4', position: 5, duration: 10, state: 'playing',
    updated_at: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString()
  };
  const r = await call('GET');
  assert.strictEqual(r.body.session, null);
  assert.ok(stored, 'the row must survive being judged stale');
});

checkAsync('DELETE clears only the caller own row', async () => {
  stored = { user_id: ME.id, url: 'https://x.test/a.mp4' };
  dbCalls = [];
  await call('DELETE');
  const rm = dbCalls.find((c) => c[0] === 'remove');
  assert.ok(rm && rm[1].includes('user_id=eq.' + ME.id), 'delete was not scoped to the caller');
});

checkAsync('an unsupported method is refused', async () => {
  const r = await call('PATCH', {});
  assert.strictEqual(r.status, 405);
});

queue.then(() => {

  console.log('\n' + '─'.repeat(64));
  if (failures.length) {
    console.log(passed + ' passed, ' + failures.length + ' FAILED');
    for (const f of failures) console.log('  · ' + f);
    process.exit(1);
  }
  console.log(passed + ' assertions passed');
});
