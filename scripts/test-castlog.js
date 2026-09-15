#!/usr/bin/env node
/* Cast logs: shaping the phone's lines, and who may read whose log.
 *
 * The handler runs for real against a stubbed auth and db, so the checks are
 * on the queries it actually builds — the user_id filter IS the isolation.
 *
 *   node scripts/test-castlog.js
 */

const path = require('path');
const { Readable } = require('stream');

let failures = 0;
function check(name, cond, detail) {
  if (cond) return console.log('  ok   ' + name);
  failures++;
  console.log('  FAIL ' + name + (detail ? '\n         ' + detail : ''));
}

const castlog = require('../lib/castlog.js');

console.log('castlog: problem lines');
const bad = ['The TV refused it', 'Player error', 'Still not playing after 15s', 'Link expired — reading the page again',
  'AirPlay: another app took the TV', 'Phone stalled, buffering for 10s', 'Session did not end on the first ask'];
const good = ['TV player state: PLAYING', 'Beat', 'Connected to Living Room', 'The TV accepted it. Waiting for it to start playing…',
  'Renewing the Bilibili link'];
bad.forEach((l) => check('problem: ' + l, castlog.isProblem({ line: l })));
good.forEach((l) => check('fine: ' + l, !castlog.isProblem({ line: l })));
check('IDLE with ERROR in the detail is a problem', castlog.isProblem({ line: 'TV player state: IDLE', detail: ' · idle reason: ERROR' }));

console.log('castlog: shape');
const now = Date.now();
const s = castlog.shape([
  { at: now - 1000, line: 'The TV refused it', detail: 'x'.repeat(5000) },
  { at: 'nonsense', line: 'Beat' },
  { at: now - 3 * 86400000, line: 'clock is wrong' },
  { line: '' },
  null,
  'string'
], now);
check('drops empty and junk lines', s.lines.length === 3, JSON.stringify(s.lines.map((l) => l.line)));
check('counts problems', s.problems === 1);
check('caps detail length', s.lines[0].detail.length === 1500);
check('unreadable time gets the server time', s.lines[1].at === now);
check('a clock days off gets the server time', s.lines[2].at === now);
check('caps a batch', castlog.shape(new Array(1000).fill({ line: 'x' })).lines.length === castlog.MAX_LINES_PER_BATCH);
check('session id shape', castlog.validSession('a1b2c3d4e5f6') && !castlog.validSession('short') && !castlog.validSession('../../x'));

/* ---------- handler, stubbed ---------- */
let who = { id: '11111111-1111-1111-1111-111111111111', role: 'user' };
const calls = [];
function stub(file, exp) {
  const p = require.resolve(file);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exp };
}
stub('../lib/auth.js', { guard: async () => who });
stub('../lib/db.js', {
  select: async (p) => { calls.push(['GET', p]); return p.indexOf('id=eq.') >= 0 ? [] : []; },
  request: async (m, p, o) => { calls.push([m, p, o.body]); return 'new-id'; },
  remove: async (p) => { calls.push(['DELETE', p]); return []; }
});
const handler = require(path.join('..', 'api', 'castlog.js'));

function call(method, url, body) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  req.method = method;
  req.url = url;
  req.headers = { 'user-agent': 'test-phone' };
  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = JSON.parse(b); } };
  return handler(req, res).then(() => res);
}

(async () => {
  console.log('castlog: handler');
  calls.length = 0;
  let r = await call('POST', '/api/castlog', { session: 'abcdef123456', user_id: 'someone-else', title: 'Film', lines: [{ at: Date.now(), line: 'The TV refused it' }] });
  const rpc = calls.find((c) => c[1] === 'rpc/cast_log_append');
  check('POST appends through the rpc', r.statusCode === 200 && !!rpc, JSON.stringify(r.body));
  check('POST user is the signed session, never the body', rpc && rpc[2].p_user === who.id);
  check('POST counts the problem', rpc && rpc[2].p_problems === 1);
  check('POST records the phone', rpc && rpc[2].p_agent === 'test-phone');

  r = await call('POST', '/api/castlog', { session: 'bad', lines: [{ line: 'x' }] });
  check('POST refuses a bad session id', r.statusCode === 400);

  calls.length = 0;
  r = await call('GET', '/api/castlog');
  check('GET mine is pinned to my id', calls[0] && calls[0][1].indexOf('user_id=eq.' + who.id) >= 0, calls[0] && calls[0][1]);

  r = await call('GET', '/api/castlog?scope=all');
  check('a normal user cannot read everyone', r.statusCode === 403);

  calls.length = 0;
  await call('GET', '/api/castlog?id=22222222-2222-2222-2222-222222222222');
  check('one log for a normal user is pinned to their id', calls[0] && calls[0][1].indexOf('user_id=eq.' + who.id) >= 0, calls[0] && calls[0][1]);

  who = { id: '99999999-9999-9999-9999-999999999999', role: 'admin' };
  calls.length = 0;
  r = await call('GET', '/api/castlog?scope=all&problems=1');
  check('owner reads everyone', r.statusCode === 200 && calls[0][1].indexOf('user_id=eq.') < 0, calls[0] && calls[0][1]);
  check('problems filter applied', calls[0][1].indexOf('problems=gt.0') >= 0);

  console.log(failures ? '\n' + failures + ' failure(s)' : '\nall castlog checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
