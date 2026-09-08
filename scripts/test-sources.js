#!/usr/bin/env node
/* Proof that a piece of a stream is never offered as a stream.
 *
 * The report: pasting https://tvarticles.org/vidd.php?id=2823149 into the
 * browse box came back with three things to play — "video", "480", and a
 * third row named after some juicycodes. Measured on this box against the
 * live page, that third row was an HLS SEGMENT: six seconds of the episode,
 * served as video/mp2t from
 *
 *   .../tsfiles/CEABEEAC/480K/2026/.../01852-000.juicycodes
 *
 * The player fetches several hundred of those to show one episode, and the
 * scanner was watching the network, so it captured them alongside the two
 * playlists. Nothing about the name gives it away — the site simply calls
 * its segments `.juicycodes` — so the rule cannot be about naming.
 *
 * The suite is in two halves. The first states the rule against fixtures.
 * The second runs the REAL exported scanner in a REAL browser against a
 * local page shaped exactly like the one that broke, because the rule being
 * right is not the same as it being wired into the thing that scans.
 *
 *   node scripts/test-sources.js
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const media = require('../lib/media');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const out = fn();
    if (out && typeof out.then === 'function') return out;
    passed += 1;
    console.log('  ok   ' + name);
  } catch (err) {
    failures.push(name + ' — ' + err.message);
    console.log('  FAIL ' + name + ' — ' + err.message);
  }
  return null;
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ok   ' + name);
  } catch (err) {
    failures.push(name + ' — ' + err.message);
    console.log('  FAIL ' + name + ' — ' + err.message);
  }
}

/* ---------- what a playlist says about its own contents ---------- */

const MEDIA_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:6',
  '#EXT-X-MAP:URI="init.mp4"',
  '#EXTINF:6.000,',
  '01852-000.juicycodes',
  '#EXTINF:6.000,',
  '01852-001.juicycodes',
  '#EXT-X-ENDLIST'
].join('\n');

const MASTER_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480',
  '480.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720',
  '720.m3u8'
].join('\n');

const BASE = 'https://einsteinium.tvlogy.to/a/b/480.m3u8';

console.log('\nplaylistLinks');

check('a media playlist is not a master', function () {
  assert.strictEqual(media.playlistLinks(MEDIA_PLAYLIST, BASE).master, false);
});

check('a playlist carrying EXT-X-STREAM-INF is a master', function () {
  assert.strictEqual(media.playlistLinks(MASTER_PLAYLIST, BASE).master, true);
});

check('segment lines are resolved against the playlist, not the site root', function () {
  const urls = media.playlistLinks(MEDIA_PLAYLIST, BASE).urls;
  assert.ok(urls.indexOf('https://einsteinium.tvlogy.to/a/b/01852-000.juicycodes') !== -1,
    'expected the segment beside its playlist, got ' + JSON.stringify(urls));
});

check('the initialisation segment named in EXT-X-MAP counts too', function () {
  const urls = media.playlistLinks(MEDIA_PLAYLIST, BASE).urls;
  assert.ok(urls.indexOf('https://einsteinium.tvlogy.to/a/b/init.mp4') !== -1,
    'EXT-X-MAP URI was missed: ' + JSON.stringify(urls));
});

check('a master names its renditions, and those are worth keeping', function () {
  const links = media.playlistLinks(MASTER_PLAYLIST, BASE);
  assert.strictEqual(links.urls.length, 2);
  assert.ok(links.urls[0].endsWith('/480.m3u8'));
});

check('comments and blank lines are not addresses', function () {
  const links = media.playlistLinks('#EXTM3U\n\n#EXT-X-ENDLIST\n', BASE);
  assert.deepStrictEqual(links.urls, []);
});

/* ---------- the gate itself ---------- */

console.log('\nofferable');

const SEG = 'https://einsteinium.tvlogy.to/tsfiles/CEABEEAC/480K/01852-000.juicycodes';

check('the reported row: a mp2t body is a fragment whatever it is called', function () {
  assert.strictEqual(media.offerable(SEG, 'video/mp2t'), false);
  /* Isolated from the suffix rule on purpose. The address below has no name
     to judge it on and no playlist claiming it, so the ONLY thing that can
     refuse it is the type — and a CDN that signs its segments the way it
     signs its playlists produces exactly this. Without this line the check
     passed with the mp2t rule deleted. */
  assert.strictEqual(
    media.offerable('https://einsteinium.tvlogy.to/pWMk8Tn1JMJClxe', 'video/mp2t'), false);
});

check('and it is refused on its name alone, with no content type to help', function () {
  assert.strictEqual(media.offerable(SEG, ''), false);
});

check('a segment the playlist listed is refused even when it looks playable', function () {
  const seen = new Set(['https://h/a/init.mp4']);
  assert.strictEqual(media.offerable('https://h/a/init.mp4', 'video/mp4', seen), false);
  assert.strictEqual(media.offerable('https://h/a/init.mp4', 'video/mp4', new Set()), true,
    'the same address must be offerable when no playlist claimed it');
});

check('.ts and .m4s are fragments', function () {
  assert.strictEqual(media.offerable('https://h/a/seg-9.ts', ''), false);
  assert.strictEqual(media.offerable('https://h/a/seg-9.m4s', ''), false);
});

check('the two real streams from that page survive', function () {
  assert.strictEqual(media.offerable('https://einsteinium.tvlogy.to/x/video.m3u8', ''), true);
  assert.strictEqual(media.offerable('https://einsteinium.tvlogy.to/x/480.m3u8', ''), true);
});

check('a signed address with no extension at all is still offered', function () {
  /* The ones hardest to come by carry no name to judge them on. A rule that
     needed an extension would throw away exactly those. */
  assert.strictEqual(
    media.offerable('https://einsteinium.tvlogy.to/pWMk8Tn1JMJClxe-H_5brQo9rRLR', ''), true);
});

check('an m3u8 behind a token keeps its kind', function () {
  assert.strictEqual(media.offerable('https://h/x/video.m3u8?token=TW96aWxsYQ==', ''), true);
});

check('the player script that shares the segments\' name is not media', function () {
  assert.strictEqual(
    media.offerable('https://flow.tvlogy.to/templates/jwplayer/assets/juicycodes.js?v2',
      'application/javascript'), false);
});

check('a poster is not a stream', function () {
  assert.strictEqual(media.offerable('https://h/a/cover.jpg', 'image/jpeg'), false);
});

check('ordinary files still pass', function () {
  ['https://h/a/film.mp4', 'https://h/a/film.webm', 'https://h/a/film.mkv',
    'https://h/a/track.mp3', 'https://h/a/stream.mpd'].forEach(function (u) {
    assert.strictEqual(media.offerable(u, ''), true, u + ' should be offerable');
  });
});

check('a body that proved itself outranks the path it sits at', function () {
  /* These sites serve films from get_file.php all the time, and probeMedia
     settles those by reading the first kilobytes. A suffix rule that also
     got the last word would refuse a stream we had already proved. */
  assert.strictEqual(media.offerable('https://h/dl/get_file.php?id=9', 'video/mp4'), true);
  assert.strictEqual(media.offerable('https://h/dl/get_file.php?id=9', ''), false);
});

check('what probeMedia proved is said in the same language the gate reads', function () {
  assert.strictEqual(media.kindToType('HLS'), 'application/x-mpegurl');
  assert.strictEqual(media.kindToType('MP4'), 'video/mp4');
  assert.strictEqual(media.kindToType('JUICYCODES'), '');
  /* octet-stream must never be minted here — it proves nothing, and a gate
     that treated it as proof would wave through every mislabelled font. */
  Object.keys(media.kindToType('') === '' ? {} : {}).forEach(function () {});
  assert.ok(!/octet-stream/.test(media.kindToType('VIDEO')));
});

check('octet-stream alone does not make something playable', function () {
  assert.strictEqual(
    media.offerable('https://h/a/thing.juicycodes', 'application/octet-stream'), false);
});

check('a non-http address is never offered', function () {
  assert.strictEqual(media.offerable('blob:https://h/abc', ''), false);
  assert.strictEqual(media.offerable('data:video/mp4;base64,AAAA', ''), false);
});

/* ---------- what happens after one of them does not play ----------
 *
 * Rj's second ask, verbatim: "when I select one, the other one should be
 * stored as well so if it doesn't work I can switch to second link and
 * try." The rules for that live in assets/js/sources.js precisely so they
 * can be proved here rather than described in a comment.
 */

const CBSources = require('../assets/js/sources.js');

function newSet(n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push({ url: 'https://h/s' + i + '.m3u8', label: i * 240 + 'p', kind: 'HLS' });
  }
  return out;
}

console.log('\nsources (the picker and the automatic hop)');

check('picking one keeps the rest', function () {
  const s = CBSources.create({});
  const list = newSet(3);
  s.set(list, list[0].url, 0);
  assert.strictEqual(s.count(), 3);
  assert.strictEqual(s.at(), 0);
});

check('the one that was loaded counts as tried', function () {
  const s = CBSources.create({});
  const list = newSet(3);
  s.set(list, list[1].url, 1);
  assert.strictEqual(s.tried(list[1].url), true);
  assert.strictEqual(s.tried(list[0].url), false);
});

check('a failure moves to one nobody has tried', function () {
  const s = CBSources.create({});
  const list = newSet(3);
  s.set(list, list[0].url, 0);
  const next = s.takeAuto();
  assert.strictEqual(next, 1);
});

check('the hop never returns to the stream that just failed', function () {
  const s = CBSources.create({});
  const list = newSet(3);
  s.set(list, list[0].url, 0);          // playing 1, failed
  s.set(list, list[s.takeAuto()].url);  // hopped to 2
  const third = s.takeAuto();
  assert.strictEqual(third, 2, 'expected the third, got index ' + third);
});

check('the automatic hop is capped, so a dead set does not walk itself', function () {
  const s = CBSources.create({});
  const list = newSet(6);
  s.set(list, list[0].url, 0);
  s.set(list, list[s.takeAuto()].url);
  s.set(list, list[s.takeAuto()].url);
  assert.strictEqual(s.takeAuto(), -1, 'a third automatic hop should be refused');
});

check('a source that actually played hands the budget back', function () {
  const s = CBSources.create({});
  const list = newSet(6);
  s.set(list, list[0].url, 0);
  s.set(list, list[s.takeAuto()].url);
  s.set(list, list[s.takeAuto()].url);
  s.resetAuto();
  assert.ok(s.takeAuto() >= 0, 'after something played, hops should be available again');
});

check('the deliberate step wraps rather than dead-ending on the last', function () {
  const s = CBSources.create({});
  const list = newSet(3);
  s.set(list, list[2].url, 2);
  assert.strictEqual(s.next(), 0);
});

check('the deliberate step ignores what has been tried', function () {
  const s = CBSources.create({});
  const list = newSet(2);
  s.set(list, list[0].url, 0);
  s.set(list, list[1].url, 1);          // both tried now
  assert.strictEqual(s.takeAuto(), -1, 'nothing untried is left');
  assert.strictEqual(s.next(), 0, 'but the picker can still go back to the first');
});

check('a single stream offers no switch at all', function () {
  const s = CBSources.create({});
  const list = newSet(1);
  s.set(list, list[0].url, 0);
  assert.strictEqual(s.next(), -1);
  assert.strictEqual(s.takeAuto(), -1);
});

check('re-installing the same set does not forget what failed', function () {
  /* This is what a hop within the set looks like from inside. A reset here
     would send the automatic hop straight back to the stream that just
     failed, forever. */
  const s = CBSources.create({});
  const list = newSet(3);
  s.set(list, list[0].url, 0);
  s.set(list, list[1].url, 1);
  assert.strictEqual(s.tried(list[0].url), true);
});

check('a different film starts over', function () {
  const s = CBSources.create({});
  const a = newSet(3);
  s.set(a, a[0].url, 0);
  s.set(a, a[1].url, 1);
  const b = [{ url: 'https://other/x.m3u8', label: 'x', kind: 'HLS' },
    { url: 'https://other/y.m3u8', label: 'y', kind: 'HLS' }];
  s.set(b, b[0].url, 0);
  assert.strictEqual(s.count(), 2);
  assert.strictEqual(s.tried(a[0].url), false, 'the last film\'s attempts leaked in');
});

check('the same address twice is one source', function () {
  const s = CBSources.create({});
  s.set([
    { url: 'https://h/a.m3u8', label: 'video', kind: 'HLS' },
    { url: 'https://h/a.m3u8', label: 'video', kind: 'HLS' }
  ], 'https://h/a.m3u8', 0);
  assert.strictEqual(s.count(), 1);
});

check('a set is capped', function () {
  const s = CBSources.create({ cap: 4 });
  const list = newSet(20);
  s.set(list, list[0].url, 0);
  assert.strictEqual(s.count(), 4);
});

check('anything that is not an address is not a source', function () {
  const s = CBSources.create({});
  s.set([null, { url: '' }, { url: 'blob:https://h/x' },
    { url: 'https://h/real.m3u8', label: 'real', kind: 'HLS' }], 'https://h/real.m3u8');
  assert.strictEqual(s.count(), 1);
  assert.strictEqual(s.at(), 0);
});

check('the picker names the kind as well as the label', function () {
  const s = CBSources.create({ kindOf: () => 'HLS', nameOf: (u) => u });
  const list = newSet(2);
  s.set(list, list[0].url, 0);
  assert.strictEqual(s.name(0), '240p — HLS');
});

check('a label that already says its kind is not told twice', function () {
  const s = CBSources.create({});
  s.set([{ url: 'https://h/a.m3u8', label: 'HLS master', kind: 'HLS' }], 'https://h/a.m3u8');
  assert.strictEqual(s.name(0), 'HLS master');
});

check('what goes to history is address and name, nothing measured', function () {
  const s = CBSources.create({});
  s.set([{ url: 'https://h/a.m3u8', label: 'video', kind: 'HLS', detail: 'requested by the page' }],
    'https://h/a.m3u8');
  assert.deepStrictEqual(s.forStore(),
    [{ url: 'https://h/a.m3u8', label: 'video', kind: 'HLS' }]);
});

/* ---------- the scanner, in a browser, against a page shaped like the one
              that broke ---------- */

const CHROME = (function () {
  const named = String(process.env.CHROME_EXECUTABLE_PATH || '').trim();
  const tried = named ? [named] : ['/usr/bin/google-chrome', '/usr/bin/chromium'];
  for (const c of tried) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (e) { /* next */ }
  }
  return null;
})();

/* Serves the shape, not the site: a page whose player fetches a master, then
   a rendition, then the rendition's segments — which is what every HLS
   player on the web does, and what filled the list with fragments. */
function fixtureServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const path = req.url.split('?')[0];

      if (path === '/watch') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><body><video id="v"></video><script>' +
          'fetch("/hls/master.m3u8").then(function(r){return r.text()})' +
          '.then(function(){ return fetch("/hls/480.m3u8").then(function(r){return r.text()}); })' +
          '.then(function(){ return Promise.all([' +
          'fetch("/hls/01852-000.juicycodes"),' +
          'fetch("/hls/01852-001.juicycodes"),' +
          'fetch("/hls/init.mp4")]); })' +
          '.then(function(){ document.getElementById("v").src = "/hls/480.m3u8"; });' +
          '</script></body></html>');
        return;
      }

      if (path === '/hls/master.m3u8') {
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        res.end(MASTER_PLAYLIST);
        return;
      }

      if (path === '/hls/480.m3u8') {
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        res.end(MEDIA_PLAYLIST);
        return;
      }

      if (/^\/hls\/01852-\d+\.juicycodes$/.test(path)) {
        /* Exactly how the real host serves them. */
        res.writeHead(200, { 'content-type': 'video/mp2t' });
        res.end(Buffer.from([0x47, 0x40, 0x11, 0x10]));
        return;
      }

      if (path === '/hls/init.mp4') {
        /* The trap the naming rule alone would fall into: an initialisation
           segment is a fragment with a whole file's extension and a whole
           file's content type. Only the playlist knows. */
        res.writeHead(200, { 'content-type': 'video/mp4' });
        res.end(Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]));
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('no');
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function browserHalf() {
  console.log('\nscan.collect (real browser)');

  if (!CHROME) {
    console.log('  skip  no chrome on this box — set CHROME_EXECUTABLE_PATH');
    console.log('        (this half is the one that proves the wiring, so a run');
    console.log('         that skips it has NOT proved the fix)');
    return;
  }
  process.env.CHROME_EXECUTABLE_PATH = CHROME;

  const scan = require('../api/scan.js');
  const server = await fixtureServer();
  const base = 'http://127.0.0.1:' + server.address().port;

  let browser = null;
  let found = null;
  try {
    browser = await scan.launch();
    const page = await browser.newPage();
    found = await scan.collect(page, base + '/watch');
  } finally {
    if (browser) { try { await browser.close(); } catch (e) { /* gone */ } }
    server.close();
  }

  const urls = found.media.map((m) => m.url);

  await checkAsync('the segments are gone', async () => {
    const segs = urls.filter((u) => /juicycodes/.test(u));
    assert.deepStrictEqual(segs, [],
      'segments were offered as streams: ' + JSON.stringify(segs));
  });

  await checkAsync('the initialisation segment is gone too', async () => {
    assert.ok(urls.indexOf(base + '/hls/init.mp4') === -1,
      'init.mp4 survived — the playlist rule is not wired in');
  });

  await checkAsync('both playlists survive', async () => {
    assert.ok(urls.indexOf(base + '/hls/master.m3u8') !== -1,
      'the master was dropped: ' + JSON.stringify(urls));
    assert.ok(urls.indexOf(base + '/hls/480.m3u8') !== -1,
      'the rendition was dropped: ' + JSON.stringify(urls));
  });

  await checkAsync('nothing is left carrying the internal type field', async () => {
    /* It is used to decide and stripped before the answer leaves collect —
       an answer that still had it would be shipping a private field to the
       screen and to /api/scan's callers. */
    found.media.forEach((m) => {
      assert.ok(!('type' in m), 'a row still carries .type: ' + JSON.stringify(m));
    });
  });
}

/* ---------- and the same thing through the real app ----------
 *
 * The module above is where the rules live, but rules wired to nothing are
 * not a feature. This drives the shipped index.html and assets/js/app.js in
 * a real browser against a scan whose three streams are all dead, and reads
 * the result off the screen: the picker appears, the app hops on its own
 * when a stream fails, it stops hopping rather than walking the whole list,
 * and the button still goes anywhere the person points it.
 */

const APP_ROOT = require('path').join(__dirname, '..');
const APP_TYPES = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png'
};

function appServer(payload) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = req.url.split('?')[0];

      /* The scan answers with three streams; every other endpoint answers
         the way an unreachable one would, which is also how the app behaves
         for someone who is not signed in. Neither matters here — the source
         strip is below the sign-in dialog and still works. */
      if (p === '/api/extract' || p === '/api/scan') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload(server.address().port)));
        return;
      }
      if (p.indexOf('/api/') === 0) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":false,"error":"not in this test"}');
        return;
      }
      /* Every stream in the set is dead, on purpose. */
      if (p.indexOf('/dead/') === 0) { res.writeHead(404); res.end('gone'); return; }

      const f = require('path').join(APP_ROOT, p === '/' ? 'index.html' : p);
      fs.readFile(f, (e, b) => {
        if (e) { res.writeHead(404); res.end('no'); return; }
        res.writeHead(200, {
          'content-type': APP_TYPES[require('path').extname(f)] || 'application/octet-stream'
        });
        res.end(b);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/* `forceHlsJs` decides WHICH of the app's two players handles the dead
   stream, and both have to hop.
 *
 * Headless Chrome answers "maybe" to canPlayType for HLS, so load() hands
 * the playlist to the <video> element and hls.js never sees it — which is
 * Safari's and iOS's path, and was the only one this suite covered until
 * deleting the hop out of the hls.js handler failed to turn it red. With
 * canPlayType silenced the app takes the other branch, which is what a
 * browser with no native HLS does, Chrome on Android among them. */
async function appHalf(forceHlsJs) {
  console.log('\nthe app itself (real browser, real index.html' +
    (forceHlsJs ? ', hls.js path' : ', native player path') + ')');

  if (!CHROME) {
    console.log('  skip  no chrome on this box');
    return;
  }

  const puppeteer = require('puppeteer-core');
  const server = await appServer((port) => {
    const base = 'http://127.0.0.1:' + port;
    return {
      ok: true, deep: true, direct: false, poster: null,
      finalUrl: 'https://tvarticles.org/vidd.php?id=2823149',
      title: 'Desi Serials',
      media: [
        { url: base + '/dead/video.m3u8', kind: 'HLS', label: 'video', detail: 'requested by the page' },
        { url: base + '/dead/480.m3u8', kind: 'HLS', label: '480', detail: 'requested by the page' },
        { url: base + '/dead/720.m3u8', kind: 'HLS', label: '720', detail: 'requested by the page' }
      ]
    };
  });
  const base = 'http://127.0.0.1:' + server.address().port;

  let browser = null;
  let seen = null;
  const crashes = [];
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage',
        '--autoplay-policy=no-user-gesture-required']
    });
    const page = await browser.newPage();
    page.on('pageerror', (e) => crashes.push(e.message));

    if (forceHlsJs) {
      await page.evaluateOnNewDocument(() => {
        const real = HTMLMediaElement.prototype.canPlayType;
        HTMLMediaElement.prototype.canPlayType = function (t) {
          return /mpegurl/i.test(String(t)) ? '' : real.call(this, t);
        };
      });
    }

    /* The shipped page pulls hls.js from cdnjs and the Cast sender from
       gstatic. Waiting for the network to go quiet therefore made this
       suite depend on two CDNs and a DNS lookup — which is how it came to
       fail once inside `npm test` and pass every time it was run on its
       own. The Cast sender is refused outright (there is no television
       here and it is the slower of the two); hls.js is allowed but never
       waited for, and which player ends up handling the dead stream is
       reported rather than assumed, because both paths hop and both are
       worth knowing about. */
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      if (/gstatic\.com/.test(r.url())) { r.abort().catch(() => {}); return; }
      r.continue().catch(() => {});
    });

    await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded', timeout: 30000 });

    /* Ready is a fact about the page, not a number of milliseconds. */
    await page.waitForFunction(
      () => window.CBSources && document.getElementById('sourcePick'),
      { timeout: 20000 });
    await pause(400);
    const player = await page.evaluate(() => {
      const v = document.createElement('video');
      const native = Boolean(v.canPlayType &&
        (v.canPlayType('application/vnd.apple.mpegurl') || v.canPlayType('application/x-mpegURL')));
      if (native) return 'the browser\'s own player';
      return window.Hls && window.Hls.isSupported() ? 'hls.js' : 'neither — no player at all';
    });
    console.log('  note  the dead streams are handled by ' + player);
    assert.strictEqual(player,
      forceHlsJs ? 'hls.js' : 'the browser\'s own player',
      'this pass did not exercise the branch it is named after');

    await page.evaluate((u) => {
      const nav = document.getElementById('nav-browse');
      if (nav) nav.click();
      const input = document.getElementById('pageUrl');
      input.value = u;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const form = input.closest('form');
      if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }, 'https://tvarticles.org/vidd.php?id=2823149');
    await pause(2500);

    const rows = await page.evaluate(() => document.querySelectorAll('.cb-t-row').length);

    /* Play the first stream. Clicked from script rather than with the mouse
       because the sign-in dialog is over the page — an artefact of stubbing
       the API, and not what is being measured. */
    await page.evaluate(() => {
      const b = document.querySelectorAll('.cb-t-row .cb-t-act button');
      if (b[0]) b[0].click();
    });
    /* Read the strip at once. A dead local address fails in single-digit
       milliseconds, so waiting here would be racing the very hops this is
       about to measure — which is what made an earlier version of this
       check fail against working code. */
    await pause(150);

    const onPick = await page.evaluate(() => ({
      hidden: document.getElementById('sources').hidden,
      options: Array.from(document.getElementById('sourcePick').options)
        .map((o) => o.textContent),
      at: document.getElementById('sourcePick').value,
      url: document.getElementById('url').value
    }));

    /* Wait for the app to have SETTLED, not for a number of seconds. Each
       dead stream costs a failure, a retry through the bridge and a second
       failure, and how long hls.js takes to give up on that varies enough
       that a fixed seven seconds caught the app mid-retry roughly one run
       in three — a suite that is red one time in three is worse than none.

       Settled means either it reached the last source or it has said
       something final. Both endings let the assertions below report what
       actually happened; a timeout does too, which is why it is swallowed
       rather than thrown. */
    await page.waitForFunction(() => {
      /* The two players word their surrender differently — "this link
         won't play here" from the element, "this stream won't open in a
         browser tab" from hls.js — and both are the end of the road. The
         address is deliberately NOT part of the condition: reaching the
         last source is not the same as having finished with it, and
         reading at that moment caught the app mid-retry. */
      const t = document.getElementById('statusText').textContent;
      return /won't (play|open)/.test(t);
    }, { timeout: 60000 }).catch(() => { /* the state below is the report */ });
    await pause(600);
    const afterFail = await page.evaluate(() => ({
      at: document.getElementById('sourcePick').value,
      url: document.getElementById('url').value,
      status: document.getElementById('statusText').textContent
    }));

    /* Twice, in the same tick. A phone reports a double tap on a small
       control more often than anyone expects, and two switches for one
       intent skips a source silently — the person is then looking at the
       third stream believing it is the second. */
    await page.evaluate(() => {
      const b = document.getElementById('btnNextSource');
      b.click();
      b.click();
    });
    await page.waitForFunction(
      () => /\/dead\/video\.m3u8$/.test(document.getElementById('url').value),
      { timeout: 15000 }).catch(() => { /* the state below is the report */ });
    const afterButton = await page.evaluate(() => ({
      at: document.getElementById('sourcePick').value,
      url: document.getElementById('url').value
    }));

    seen = { rows, onPick, afterFail, afterButton };
  } finally {
    if (browser) { try { await browser.close(); } catch (e) { /* gone */ } }
    server.close();
  }

  const suffix = forceHlsJs ? ' (hls.js)' : ' (native)';

  await checkAsync('the app boots with no script error' + suffix, async () => {
    assert.deepStrictEqual(crashes, []);
  });

  await checkAsync('a scan of three streams draws three rows' + suffix, async () => {
    assert.strictEqual(seen.rows, 3);
  });

  await checkAsync('picking one reveals the other two rather than discarding them' + suffix, async () => {
    assert.strictEqual(seen.onPick.hidden, false, 'the source strip stayed hidden');
    assert.strictEqual(seen.onPick.options.length, 3);
    assert.strictEqual(seen.onPick.options[0], '1 of 3 · video — HLS');
    assert.strictEqual(seen.onPick.options[2], '3 of 3 · 720 — HLS');
  });

  await checkAsync('a stream that will not play moves the app on by itself' + suffix, async () => {
    /* Landing on the third proves both hops: the set is walked in order,
       and nothing but an automatic hop touched it. */
    assert.ok(/\/dead\/720\.m3u8$/.test(seen.afterFail.url),
      'expected two automatic hops, landed on ' + seen.afterFail.url +
      ' — status was: ' + seen.afterFail.status);
  });

  await checkAsync('it stops hopping and says so, rather than walking the whole list' + suffix, async () => {
    assert.strictEqual(seen.afterFail.at, '2');
    /* Either surrender is honest; which one you get depends on which
       player was holding the stream. What matters is that it stops. */
    assert.ok(/won't (play here|open in a browser tab)/.test(seen.afterFail.status),
      'expected an honest ending, got: ' + seen.afterFail.status);
  });

  await checkAsync('the button still goes anywhere, and one tap is one switch' + suffix, async () => {
    /* '0' not '1': the wrap happened once, and the double tap that produced
       it did not quietly skip a source. */
    assert.strictEqual(seen.afterButton.at, '0',
      'a double tap moved ' + (Number(seen.afterButton.at) + 1) + ' places');
    assert.ok(/\/dead\/video\.m3u8$/.test(seen.afterButton.url),
      'the picker wrapped to ' + seen.afterButton.url);
  });
}

browserHalf()
  .then(() => appHalf(false))
  .then(() => appHalf(true))
  .then(() => {
  console.log('');
  if (failures.length) {
    console.log(failures.length + ' failed, ' + passed + ' passed');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log(passed + ' checks passed');
}).catch((err) => {
  console.log('\nthe suite itself broke: ' + (err && err.stack));
  process.exit(1);
});
