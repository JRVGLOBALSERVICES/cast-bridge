#!/usr/bin/env node
/* Proof for two things api/stream.js now does when a host refuses:
 *
 *   1. A host that refuses ANY referer (vkcdn: 403 to the page's own
 *      address, the file to a request naming none) is tried once more
 *      without one, and plays.
 *   2. A refusal is answered with the host's own words in X-Cast-Error, so
 *      the phone's log says "locked to the network that found it" instead
 *      of "media error 4 · Format error".
 *
 * Offline: lib/media's safeFetch is replaced before the handler loads, and
 * the handler runs behind a real local http server so headers and bodies
 * go over a real socket.
 *
 *   node scripts/test-stream-referer.js
 */

const assert = require('assert');
const http = require('http');
const media = require('../lib/media');

const calls = [];
let behave = null;
media.safeFetch = async (url, accept, opts) => {
  const h = (opts && opts.headers) || {};
  calls.push({ url, referer: h.referer || null });
  return { res: behave(url, h), url };
};
const handler = require('../api/stream.js');

const server = http.createServer((req, res) => {
  req.query = Object.fromEntries(new URL(req.url, 'http://x').searchParams.entries());
  handler(req, res);
});

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failures.push(name); console.log('  FAIL ' + name + ' — ' + e.message); }
}

const FILM = 'https://vksovhv00.vkcdn5.com/abc/v.mp4';
const PAGE = 'https://tvarticles.org/vidd.php?id=1';

server.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const ask = () => fetch(base + '/api/stream?u=' + encodeURIComponent(FILM) + '&r=' + encodeURIComponent(PAGE),
    { headers: { Range: 'bytes=0-9' } });

  await check('a host that refuses any referer plays on the bare retry', async () => {
    calls.length = 0;
    behave = (url, h) => h.referer
      ? new Response('<html><h1>403 Forbidden</h1></html>', { status: 403, headers: { 'content-type': 'text/html' } })
      : new Response('0123456789', { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-9/100' } });
    const r = await ask();
    const body = await r.text();
    assert.strictEqual(r.status, 206, 'status ' + r.status + ' ' + body);
    assert.strictEqual(body, '0123456789');
    assert.ok(calls.some((c) => c.referer === null), 'never tried without a referer');
  });

  await check('a link locked to another network says so, in a readable header', async () => {
    behave = (url, h) => h.referer
      ? new Response('<html><h1>403 Forbidden</h1></html>', { status: 403, headers: { 'content-type': 'text/html' } })
      : new Response('Error_wrong_ip', { status: 200, headers: { 'content-type': 'text/html; charset=UTF-8' } });
    const r = await ask();
    await r.text();
    assert.ok(r.status >= 400, 'status ' + r.status);
    const why = decodeURIComponent(r.headers.get('x-cast-error') || '');
    assert.match(why, /locked to the network/);
    assert.match(why, /Error_wrong_ip/);
    assert.match(r.headers.get('access-control-expose-headers') || '', /X-Cast-Error/);
  });

  await check('a plain refusal carries the host\'s words', async () => {
    behave = () => new Response('Hotlinking not allowed', { status: 403, headers: { 'content-type': 'text/plain' } });
    const r = await ask();
    await r.text();
    assert.strictEqual(r.status, 502);
    assert.match(decodeURIComponent(r.headers.get('x-cast-error') || ''), /Hotlinking not allowed/);
  });

  await check('a link opened on its own is renewed from the page an earlier play named', async () => {
    const FILM2 = 'https://vksovhv00.vkcdn5.com/locked/v.mp4';
    const FRESH = 'https://vksovhv00.vkcdn5.com/fresh/v.mp4';
    const PAGE2 = 'https://tvarticles.org/vidd.php?id=2';
    const ok = () => new Response('0123456789', { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-9/100' } });
    /* First play: named its page, and played. */
    behave = () => ok();
    let r = await fetch(base + '/api/stream?u=' + encodeURIComponent(FILM2) + '&r=' + encodeURIComponent(PAGE2), { headers: { Range: 'bytes=0-9' } });
    await r.text();
    assert.strictEqual(r.status, 206);
    /* Later: the link is locked elsewhere, and it arrives naming itself. */
    calls.length = 0;
    behave = (url) => {
      if (url === PAGE2) return new Response('<video src="' + FRESH + '"></video>', { status: 200, headers: { 'content-type': 'text/html' } });
      if (url === FRESH) return ok();
      return new Response('Error_wrong_ip', { status: 200, headers: { 'content-type': 'text/html' } });
    };
    r = await fetch(base + '/api/stream?u=' + encodeURIComponent(FILM2) + '&r=' + encodeURIComponent(FILM2), { headers: { Range: 'bytes=0-9' } });
    const body = await r.text();
    assert.ok(calls.some((c) => c.url === PAGE2), 'never asked the remembered page: ' + JSON.stringify(calls));
    assert.strictEqual(r.status, 206, 'status ' + r.status + ' ' + decodeURIComponent(r.headers.get('x-cast-error') || body));
  });

  await check('a link with no page at all says to open its page', async () => {
    behave = () => new Response('Error_wrong_ip', { status: 200, headers: { 'content-type': 'text/html' } });
    const LONE = 'https://vksovhv00.vkcdn5.com/lone/v.mp4';
    const r = await fetch(base + '/api/stream?u=' + encodeURIComponent(LONE) + '&r=' + encodeURIComponent(LONE));
    await r.text();
    assert.ok(r.status >= 400);
    assert.match(decodeURIComponent(r.headers.get('x-cast-error') || ''), /No page is known/);
  });

  server.close();
  if (failures.length) { console.log(failures.length + ' failed'); process.exit(1); }
  console.log(passed + ' passed, 0 failed');
});
