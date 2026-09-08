#!/usr/bin/env node
/* Proof for the repair that keeps a refused film on this box.
 *
 * The bug this exists for: some CDNs sign a media address to the network
 * that asked for it, so an address minted on the Vercel function is a 403
 * on the VPS. The first fix redirected those films back to Vercel, which
 * worked and quietly defeated the entire point of the VPS — every
 * redirected byte went back on the meter the box was bought to escape.
 *
 * So there are two things to prove, and the second one is the one that
 * matters in a year:
 *   - the address is now re-minted HERE, once per film rather than once
 *     per segment;
 *   - /api/stream never answers a redirect, whatever is in the
 *     environment. A cost fix whose failure mode is the cost has to be
 *     nailed down by something that runs.
 *
 * Offline. The browser is a stub — what needs proving is the wiring, the
 * single flight and the refusals, none of which are Chromium's business.
 *
 *   node scripts/test-deepreissue.js
 */

const assert = require('assert');
const http = require('http');
const path = require('path');

let passed = 0;
const failures = [];
const queue = [];

function check(name, fn) {
  const done = () => { passed += 1; console.log('  ok   ' + name); };
  const bad = (err) => {
    failures.push(name + ' — ' + err.message);
    console.log('  FAIL ' + name + ' — ' + err.message);
  };
  const run = (async () => {
    try { await fn(); done(); } catch (err) { bad(err); }
  })();
  queue.push(run);
  return run;
}

const SCAN = require.resolve('../api/scan.js');
const REISSUE = require.resolve('../lib/reissue.js');

const PAGE = 'https://blog.example/watch?id=abc';
const EMBED = 'https://player.example/embed-abc.html';
const CDN = 'https://cdn.example.net';
const FAILED = CDN + '/aaaa/v.mp4?asn=14618';
const OURS = CDN + '/bbbb/v.mp4?asn=141995';

/* A browser that is not a browser. Counts how many times it was asked to
   start, which is the only number the single-flight claim is about. */
function stubScan(media, opts) {
  const settings = opts || {};
  const state = { launches: 0, closed: 0 };

  require.cache[SCAN] = {
    id: SCAN,
    filename: SCAN,
    path: path.dirname(SCAN),
    loaded: true,
    exports: {
      launch: async () => {
        state.launches += 1;
        return {
          on() {},
          newPage: async () => ({ on() {}, setUserAgent: async () => {} }),
          close: async () => { state.closed += 1; }
        };
      },
      collect: async () => {
        if (settings.delayMs) {
          await new Promise((r) => setTimeout(r, settings.delayMs));
        }
        if (settings.throws) throw new Error('the browser stopped early');
        return { media: media, title: '', poster: '', evidence: {} };
      }
    }
  };

  delete require.cache[REISSUE];
  const re = require('../lib/reissue.js');
  re._cache.clear();
  re._inFlight.clear();
  return { re, state };
}

function withBrowser(on) {
  if (on) process.env.CHROME_EXECUTABLE_PATH = '/usr/bin/google-chrome';
  else delete process.env.CHROME_EXECUTABLE_PATH;
}

/* ---------- the repair ---------- */

check('a page whose player builds its source is re-minted here', async () => {
  withBrowser(true);
  const { re, state } = stubScan([{ url: OURS, label: '720p' }]);
  const got = await re.deepReissue(PAGE, FAILED, '720p');
  assert.ok(got, 'no replacement address was produced');
  assert.strictEqual(got.url, OURS);
  assert.strictEqual(state.launches, 1);
  assert.strictEqual(state.closed, 1, 'the browser was left running');
});

check('a film costs one browser, not one per segment', async () => {
  withBrowser(true);
  const { re, state } = stubScan([{ url: OURS, label: '720p' }], { delayMs: 40 });
  /* What a refused HLS playlist actually does: every segment enters the
     retry at once. Before the single flight this was twelve Chromiums. */
  const burst = await Promise.all(
    Array.from({ length: 12 }, () => re.deepReissue(PAGE, FAILED, '720p'))
  );
  burst.forEach((r) => assert.strictEqual(r && r.url, OURS));
  assert.strictEqual(state.launches, 1,
    'launched ' + state.launches + ' browsers for one page');
});

check('the answer is remembered, including when it is no', async () => {
  withBrowser(true);
  const { re, state } = stubScan([]);
  assert.strictEqual(await re.deepReissue(PAGE, FAILED, ''), null);
  assert.strictEqual(await re.deepReissue(PAGE, FAILED, ''), null);
  assert.strictEqual(state.launches, 1,
    're-proved an unresolvable page, at thirty seconds a go');
});

check('the referer is the document the address came from', async () => {
  withBrowser(true);
  const { re } = stubScan([{ url: OURS, label: '720p', from: EMBED }]);
  /* collect() reports no frame, so this is the page fallback... */
  const got = await re.deepReissue(PAGE, FAILED, '720p');
  assert.strictEqual(got.referer, PAGE);
  /* ...and choose() carries a known one through when there is one, which
     is what the frame-tree listener supplies in production. Handing the
     CDN the blog's address instead of the embed's is its own 403. */
  const direct = re.choose([{ url: OURS, label: '720p', from: EMBED }], FAILED, '720p');
  assert.strictEqual(direct.referer, EMBED);
});

/* ---------- the refusals ---------- */

check('no browser configured means no browser started', async () => {
  withBrowser(false);
  const { re, state } = stubScan([{ url: OURS, label: '720p' }]);
  assert.strictEqual(re.deepAvailable(), false);
  assert.strictEqual(await re.deepReissue(PAGE, FAILED, '720p'), null);
  assert.strictEqual(state.launches, 0,
    'the serverless deploy would pay for a cold Chromium it cannot use');
});

check('a page may not point the television somewhere else', async () => {
  withBrowser(true);
  const { re } = stubScan([{ url: 'https://somewhere.else/v.mp4', label: '720p' }]);
  assert.strictEqual(await re.deepReissue(PAGE, FAILED, '720p'), null,
    'a stranger’s page redirected the fetch off the refusing host');
});

check('the same address back again is not a repair', async () => {
  withBrowser(true);
  const { re } = stubScan([{ url: FAILED, label: '720p' }]);
  assert.strictEqual(await re.deepReissue(PAGE, FAILED, '720p'), null);
});

check('a browser that dies is a no, not a throw', async () => {
  withBrowser(true);
  const { re, state } = stubScan([], { throws: true });
  assert.strictEqual(await re.deepReissue(PAGE, FAILED, '720p'), null);
  assert.strictEqual(state.closed, 1, 'a crashed scan leaked its browser');
});

check('media on the page’s own host is not re-read from the page', async () => {
  withBrowser(true);
  const { re, state } = stubScan([{ url: OURS, label: '720p' }]);
  assert.strictEqual(
    await re.deepReissue(PAGE, 'https://blog.example/v.mp4', '720p'), null);
  assert.strictEqual(state.launches, 0, 'scanned a page for its own address');
});

check('a rotating CDN edge is the same site, a stranger is not', async () => {
  withBrowser(true);
  const { re } = stubScan([]);
  /* The measured pair. A same-HOST rule threw this replacement away and
     made the repair unable to succeed even once. */
  assert.ok(re.sameSite('https://prx-1559-ant.vmpx.online/x',
                        'https://prx-1317-ant.vmpx.online/x'));
  assert.ok(re.sameSite('https://a.example.com/x', 'https://b.example.com/x'));
  assert.ok(!re.sameSite('https://evil.com/x', 'https://good.com/x'),
    'two unrelated hosts read as one site');
  assert.ok(!re.sameSite('https://a.co.uk/x', 'https://b.co.uk/x'),
    'a registry suffix read as somebody’s site');
  assert.ok(!re.sameSite('https://a.b.example.com/x', 'https://b.example.com/x'),
    'different depths matched');
  assert.ok(!re.sameSite('not a url', 'https://b.example.com/x'));
});

check('a replacement on the rotated edge is accepted', async () => {
  withBrowser(true);
  const ROTATED = 'https://prx-1559-ant.vmpx.online/hls2/master.m3u8?t=ours';
  const REFUSED = 'https://prx-1317-ant.vmpx.online/hls2/master.m3u8?t=theirs';
  const { re } = stubScan([{ url: ROTATED, label: 'master' }]);
  const got = await re.deepReissue(PAGE, REFUSED, 'master');
  assert.ok(got, 'the edge rotated and the repair refused its own answer');
  assert.strictEqual(got.url, ROTATED);
});

/* ---------- the cost rule ---------- */

check('a refused stream fails here rather than redirecting to a meter', async () => {
  /* The regression this suite is named for. With a fallback origin set,
     the old code answered 302 to Vercel and put the film back on the
     bill; there must no longer be any value of any variable that makes
     this endpoint hand a television to another host. */
  process.env.CAST_FALLBACK_ORIGIN = 'https://cast.jrvsystems.app';
  withBrowser(false);

  const origin = http.createServer((req, res) => {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'text/plain');
    res.end('not your network');
  });
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  const port = origin.address().port;

  delete require.cache[require.resolve('../api/stream.js')];
  const stream = require('../api/stream.js');

  const answer = await new Promise((resolve, reject) => {
    const proxy = http.createServer((req, res) => stream(req, res));
    proxy.listen(0, '127.0.0.1', () => {
      const u = '/api/stream?u=' +
        encodeURIComponent('http://127.0.0.1:' + port + '/aaaa/v.mp4') +
        '&r=' + encodeURIComponent(PAGE);
      http.get({ host: '127.0.0.1', port: proxy.address().port, path: u }, (res) => {
        res.resume();
        res.on('end', () => {
          proxy.close();
          resolve({ status: res.statusCode, location: res.headers.location || null });
        });
      }).on('error', reject);
    });
  });
  origin.close();
  delete process.env.CAST_FALLBACK_ORIGIN;

  assert.ok(answer.status < 300 || answer.status >= 400,
    'answered ' + answer.status + ' — a television was pointed at another host');
  assert.strictEqual(answer.location, null,
    'sent a Location header: ' + answer.location);
  assert.strictEqual(answer.status, 502,
    'expected an honest 502, got ' + answer.status);
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
