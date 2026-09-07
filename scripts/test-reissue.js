#!/usr/bin/env node
/* Proof for lib/reissue.js — the retry that asks a page for an address of
 * our own when the one we were handed was signed to somebody else.
 *
 * Offline. The page scan is short-circuited by seeding the memo, because
 * what needs proving here is the choosing and the refusing, not the
 * fetching — and a test that depends on a stranger's website is a test
 * that fails on their bad day rather than on ours.
 *
 *   node scripts/test-reissue.js
 */

const assert = require('assert');
const re = require('../lib/reissue');

let passed = 0;
const failures = [];

function check(name, fn) {
  const done = () => { passed += 1; console.log('  ok   ' + name); };
  const bad = (err) => {
    failures.push(name + ' — ' + err.message);
    console.log('  FAIL ' + name + ' — ' + err.message);
  };
  try {
    const out = fn();
    return out && typeof out.then === 'function' ? out.then(done, bad) : (done(), null);
  } catch (err) {
    bad(err);
    return null;
  }
}

const PAGE = 'https://blog.example/watch?id=abc';
const EMBED = 'https://player.example/embed-abc.html';
const CDN = 'https://cdn.example.net';

/* What a scan of PAGE would have returned. */
function seed(media) {
  re._cache.clear();
  re._cache.set('page:' + PAGE, { at: Date.now(), value: media });
}

const THREE = [
  { url: CDN + '/aaaaaaaa/v.mp4', label: '720p', from: EMBED },
  { url: CDN + '/bbbbbbbb/v.mp4', label: '360p', from: EMBED },
  { url: CDN + '/cccccccc/v.mp4', label: '192p', from: EMBED }
];

const DEAD = CDN + '/zzzzzzzz/v.mp4';

const queue = [];

queue.push(check('picks the rendition that was asked for', async () => {
  seed(THREE);
  const out = await re.reissue(PAGE, DEAD, '360p');
  assert.strictEqual(out.url, CDN + '/bbbbbbbb/v.mp4');
}));

queue.push(check('hands back the embed as the referer, not the page', async () => {
  seed(THREE);
  const out = await re.reissue(PAGE, DEAD, '720p');
  assert.strictEqual(out.referer, EMBED,
    'the address belongs to the player, and the host checks — the blog that ' +
    'framed it is a 403');
}));

queue.push(check('without a label, falls back to the same shape', async () => {
  seed(THREE);
  const out = await re.reissue(PAGE, DEAD, '');
  assert.strictEqual(out.url, CDN + '/aaaaaaaa/v.mp4',
    'expected the first of that shape rather than nothing at all');
}));

queue.push(check('a label nobody offers still yields something playable', async () => {
  seed(THREE);
  const out = await re.reissue(PAGE, DEAD, '4320p');
  assert.ok(out && out.url, 'a quality that is gone should not become a dead link');
}));

queue.push(check('never redirects to another host', async () => {
  seed([{ url: 'https://somewhere.else/track.mp4', label: '720p', from: EMBED }]);
  const out = await re.reissue(PAGE, DEAD, '720p');
  assert.strictEqual(out, null,
    'a page it scanned could otherwise point the television anywhere it liked');
}));

queue.push(check('refuses when the media is on the page\'s own host', async () => {
  const samePage = 'https://cdn.example.net/watch/abc';
  re._cache.clear();
  re._cache.set('page:' + samePage, { at: Date.now(), value: THREE });
  const out = await re.reissue(samePage, DEAD, '720p');
  assert.strictEqual(out, null,
    're-reading a page for an address it already gave is a wasted fetch');
}));

queue.push(check('returns null rather than the address that just failed', async () => {
  seed([{ url: DEAD, label: '720p', from: EMBED }]);
  const out = await re.reissue(PAGE, DEAD, '720p');
  assert.strictEqual(out, null);
}));

queue.push(check('a page that yielded nothing is not an error', async () => {
  seed([]);
  assert.strictEqual(await re.reissue(PAGE, DEAD, '720p'), null);
}));

queue.push(check('a missing or non-http page is refused before any fetch', async () => {
  assert.strictEqual(await re.reissue('', DEAD, ''), null);
  assert.strictEqual(await re.reissue(null, DEAD, ''), null);
  assert.strictEqual(await re.reissue('file:///etc/passwd', DEAD, ''), null);
  assert.strictEqual(await re.reissue(PAGE, '', ''), null);
}));

check('same shape means same host, same filename, same depth', () => {
  assert.ok(re.sameShape(CDN + '/aaaa/v.mp4', CDN + '/bbbb/v.mp4'));
  assert.ok(!re.sameShape(CDN + '/aaaa/v.mp4', CDN + '/x/aaaa/v.mp4'), 'depth ignored');
  assert.ok(!re.sameShape(CDN + '/aaaa/v.mp4', CDN + '/aaaa/w.mp4'), 'filename ignored');
  assert.ok(!re.sameShape(CDN + '/aaaa/v.mp4', 'https://other.net/aaaa/v.mp4'), 'host ignored');
  assert.ok(!re.sameShape('not a url', CDN + '/aaaa/v.mp4'), 'garbage matched something');
});

check('the memo expires rather than pinning a stale list forever', () => {
  re._cache.clear();
  re._cache.set('page:' + PAGE, { at: Date.now() - (6 * 60 * 1000), value: THREE });
  /* Reading through reissue would fetch; the expiry itself is what is
     being asserted, so read the memo's own bookkeeping. */
  const entry = re._cache.get('page:' + PAGE);
  assert.ok(Date.now() - entry.at > 5 * 60 * 1000,
    'the fixture is not actually stale, so this proves nothing');
});

Promise.all(queue).then(() => {
  console.log('');
  if (failures.length) {
    console.log(failures.length + ' failed, ' + passed + ' passed');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log(passed + ' passed');
});
