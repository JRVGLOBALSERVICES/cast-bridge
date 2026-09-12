#!/usr/bin/env node
/* TV mode rules: what a phone may send, which commands the TV still owes,
 * and when a TV counts as present.
 *
 *   node scripts/test-tv.js
 */

const assert = require('assert');
const tv = require('../lib/tv');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    console.error('  FAIL ' + name + '\n       ' + e.message);
    process.exitCode = 1;
  }
}

test('codes are six digits, keys are long and url-safe', () => {
  for (let i = 0; i < 200; i++) assert.ok(tv.validCode(tv.makeCode()));
  const k = tv.makeKey();
  assert.ok(tv.validKey(k), k);
  assert.ok(!tv.validCode('12345'));
  assert.ok(!tv.validCode('12a456'));
  assert.ok(!tv.validKey('short'));
  assert.ok(!tv.validKey("x'; drop table--xxxxxxxxxxxx"));
});

test('hash is stable and not the key', () => {
  const k = tv.makeKey();
  assert.strictEqual(tv.hash(k), tv.hash(k));
  assert.notStrictEqual(tv.hash(k), k);
});

test('a load keeps only what the TV needs, and refuses non-web addresses', () => {
  const c = tv.shapeCommand({
    type: 'load', url: 'https://cdn.example/film.m3u8', mime: 'application/x-mpegURL',
    title: '  A film  ', at: '95.43', subs: 'https://cast.jrvsystems.app/api/subs?id=1',
    fallback: 'https://stream.jrvsystems.app/api/stream?u=x', evil: '<script>'
  });
  assert.strictEqual(c.title, 'A film');
  assert.strictEqual(c.at, 95.4);
  assert.strictEqual(c.mime, 'application/x-mpegURL');
  assert.ok(!('evil' in c));
  assert.throws(() => tv.shapeCommand({ type: 'load', url: 'javascript:alert(1)' }), tv.InvalidTv);
  assert.throws(() => tv.shapeCommand({ type: 'load', url: 'data:video/mp4;base64,AAAA' }), tv.InvalidTv);
  assert.throws(() => tv.shapeCommand({ type: 'load' }), tv.InvalidTv);
  assert.throws(() => tv.shapeCommand({ type: 'load', url: 'https://x/', subs: 'file:///etc/passwd' }), tv.InvalidTv);
});

test('an unknown mime falls back to mp4; unknown command types are refused', () => {
  assert.strictEqual(tv.shapeCommand({ type: 'load', url: 'https://x/a', mime: 'text/html' }).mime, 'video/mp4');
  assert.throws(() => tv.shapeCommand({ type: 'reboot' }), tv.InvalidTv);
});

test('seek and skip are clamped numbers', () => {
  assert.deepStrictEqual(tv.shapeCommand({ type: 'seek', to: -5 }), { type: 'seek', to: 0 });
  assert.deepStrictEqual(tv.shapeCommand({ type: 'seek', to: 'NaN' }), { type: 'seek', to: 0 });
  assert.deepStrictEqual(tv.shapeCommand({ type: 'skip', by: -10 }), { type: 'skip', by: -10 });
  assert.deepStrictEqual(tv.shapeCommand({ type: 'play', url: 'https://x' }), { type: 'play' });
});

test('append stamps seq and keeps the tail', () => {
  let q = { seq: 0, commands: [] };
  for (let i = 0; i < 30; i++) q = tv.append(q.commands, q.seq, { type: 'play' });
  assert.strictEqual(q.seq, 30);
  assert.strictEqual(q.commands.length, tv.QUEUE_MAX);
  assert.strictEqual(q.commands[q.commands.length - 1].seq, 30);
});

test('pending returns everything after since when there is no gap', () => {
  let q = { seq: 0, commands: [] };
  q = tv.append(q.commands, q.seq, { type: 'load', url: 'https://x/a' });
  q = tv.append(q.commands, q.seq, { type: 'seek', to: 10 });
  q = tv.append(q.commands, q.seq, { type: 'play' });
  assert.deepStrictEqual(tv.pending(q.commands, 1).map((c) => c.type), ['seek', 'play']);
  assert.deepStrictEqual(tv.pending(q.commands, 3), []);
  assert.deepStrictEqual(tv.pending(q.commands, 0).map((c) => c.type), ['load', 'seek', 'play']);
});

test('a TV that fell behind the queue jumps to the last load, not a stale pause', () => {
  let q = { seq: 0, commands: [] };
  for (let i = 0; i < 25; i++) q = tv.append(q.commands, q.seq, { type: i % 2 ? 'pause' : 'play' });
  q = tv.append(q.commands, q.seq, { type: 'load', url: 'https://x/b' });
  q = tv.append(q.commands, q.seq, { type: 'skip', by: 10 });
  const got = tv.pending(q.commands, 2);
  assert.deepStrictEqual(got.map((c) => c.type), ['load', 'skip']);

  let r = { seq: 0, commands: [] };
  for (let i = 0; i < 25; i++) r = tv.append(r.commands, r.seq, { type: 'pause' });
  assert.strictEqual(tv.pending(r.commands, 1).length, 1);
});

test('status is shaped; unknown states read as idle', () => {
  const s = tv.shapeStatus({ state: 'hacked', position: 12.34, duration: Infinity, title: 'x', seq: '4' });
  assert.strictEqual(s.state, 'idle');
  assert.strictEqual(s.position, 12.3);
  assert.strictEqual(s.duration, 0);
  assert.strictEqual(s.seq, 4);
  assert.strictEqual(tv.shapeStatus(null), null);
});

test('fresh means seen inside the window', () => {
  const now = Date.parse('2026-09-12T10:00:00Z');
  assert.ok(tv.fresh('2026-09-12T09:59:55Z', now));
  assert.ok(!tv.fresh('2026-09-12T09:59:00Z', now));
  assert.ok(!tv.fresh(null, now));
});

console.log(passed + ' passed');
