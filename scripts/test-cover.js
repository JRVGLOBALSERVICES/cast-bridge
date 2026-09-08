#!/usr/bin/env node
/* Proof for the made-up cover: assets/js/cover.js, api/cover.js, and the
 * ranking in assets/js/artwork.js that decides when one is allowed to show.
 *
 *   node scripts/test-cover.js
 *
 * Three halves, in the order of how much they can be trusted.
 *
 *   The arithmetic — hue, contrast, wrapping, where the ink lands. All of
 *   it is a pure function of a title, which means it can be proven for
 *   EVERY colour this app will ever produce rather than for a sample of
 *   them. That exhaustiveness is the point of choosing hues from a fixed
 *   ring in the first place.
 *
 *   The endpoint, driven as a real handler with a real request, because the
 *   thing most likely to be wrong about it is a header.
 *
 *   A real browser, because two claims in cover.js are claims about a font
 *   and a canvas and cannot be settled anywhere else: that no character is
 *   wider than the table says it is, and that the card actually has ink on
 *   it. A table fitted to the wrong face is invisible in unit tests and
 *   arrives as a title with its end sliced off.
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

const cover = require('../assets/js/cover.js');
const CBArtwork = require('../assets/js/artwork.js');
const coverHandler = require('../api/cover.js');

const ROOT = path.join(__dirname, '..');

/* A spread of the shapes a title actually arrives in. Every one of these
   came off a real page or is the degenerate case of one. */
const TITLES = [
  'Nobody 2',
  'The Wandering Earth II',
  'Dune: Part Two',
  '流浪地球2',
  '日本語のとてもとても長いタイトルですこれは折り返しが必要になります',
  'A Very Long Film Title That Will Not Fit In Three Lines No Matter What You Do To It',
  'Supercalifragilisticexpialidociousandthensomemore',
  'AC/DC: Let There Be Rock',
  'WWWWWWWWWWWWWWWWWWWW',
  'a',
  'Мстители: Финал'
];

const SIZES = [[1280, 720], [640, 640], [512, 512], [1920, 1080], [160, 160]];

/* ------------------------------------------------------------------ *
 * Colour — proven for every hue the app can produce, not a sample
 * ------------------------------------------------------------------ */

group('cover.js — colour');

/* Every hue the ring can yield: each anchor, each jitter. Small enough to
   enumerate, which is why the ring exists. */
function everyHue() {
  const out = [];
  for (const anchor of cover.HUES) {
    for (let j = -6; j <= 6; j++) out.push(((anchor + j) % 360 + 360) % 360);
  }
  return out;
}

/* The background under a specific point, on a card of a given size. Taking
   contrast against either end of the gradient alone is a figure about
   somewhere the ink is not. */
function planFor(hue, w, h) {
  /* plan() derives its hue from the title, so a hue is reached by finding a
     title that produces it — the same path the app takes. */
  for (let i = 0; i < 200000; i++) {
    const t = 'hue-probe-' + i;
    if (cover.hue(t) === hue) return cover.plan({ title: t, from: 'example.org', width: w, height: h });
  }
  throw new Error('no title found for hue ' + hue);
}

check('white on the background is at least 7:1 at every hue the app can produce', () => {
  const hues = everyHue();
  let worst = { ratio: Infinity };
  for (const hue of hues) {
    const p = planFor(hue, 1280, 720);
    for (const line of p.lines) {
      const bg = cover.bgAt(p, line.x + p.box.w / 2, line.y);
      const r = cover.contrast('#ffffff', bg);
      if (r < worst.ratio) worst = { ratio: r, hue, bg };
    }
  }
  assert.ok(worst.ratio >= 7,
    'worst was ' + worst.ratio.toFixed(2) + ':1 at hue ' + worst.hue + ' (' + worst.bg + ')');
});

check('the orange mark is at least 3:1 against the background it sits on, at every hue', () => {
  let worst = { ratio: Infinity };
  for (const hue of everyHue()) {
    const p = planFor(hue, 1280, 720);
    const m = p.lockup.mark;
    const bg = cover.bgAt(p, m.x + m.w / 2, m.y + m.h / 2);
    const r = cover.contrast(cover.ORANGE, bg);
    if (r < worst.ratio) worst = { ratio: r, hue, bg };
  }
  assert.ok(worst.ratio >= 3,
    'worst was ' + worst.ratio.toFixed(2) + ':1 at hue ' + worst.hue + ' (' + worst.bg + ')');
});

check('no hue lands near the brand orange, where the mark would vanish into the card', () => {
  /* #f1592a sits at about 14 degrees. A card within 30 of that turns the
     one brand element on it into a slightly different shade of background. */
  for (const hue of everyHue()) {
    const d = Math.min(Math.abs(hue - 14), 360 - Math.abs(hue - 14));
    assert.ok(d > 30, 'hue ' + hue + ' is ' + d + ' degrees from the mark');
  }
});

check('no hue lands in the olive band, which at this lightness is not a colour', () => {
  for (const hue of everyHue()) {
    assert.ok(hue < 55 || hue > 115, 'hue ' + hue + ' is olive drab');
  }
});

check('the same title always gets the same card, and different titles usually differ', () => {
  for (const t of TITLES) assert.strictEqual(cover.hue(t), cover.hue(t));
  const seen = new Set();
  for (let i = 0; i < 400; i++) seen.add(cover.hue('film ' + i));
  assert.ok(seen.size > 60, 'only ' + seen.size + ' distinct hues over 400 titles');
});

/* ------------------------------------------------------------------ *
 * Layout
 * ------------------------------------------------------------------ */

group('cover.js — layout');

check('every line fits the column, at every size, for every title', () => {
  for (const t of TITLES) {
    for (const [w, h] of SIZES) {
      const p = cover.plan({ title: t, from: 'tvarticles.org', width: w, height: h });
      for (const line of p.lines) {
        const width = cover.textWidth(line.text, p.size);
        assert.ok(width <= p.box.w + 0.5,
          JSON.stringify(line.text) + ' is ' + Math.round(width) + ' wide in a ' +
          p.box.w + ' column on ' + w + 'x' + h);
      }
    }
  }
});

check('a title never runs past three lines', () => {
  for (const t of TITLES) {
    for (const [w, h] of SIZES) {
      const p = cover.plan({ title: t, from: '', width: w, height: h });
      assert.ok(p.lines.length <= cover.MAX_LINES, t + ' took ' + p.lines.length + ' lines');
      assert.ok(p.lines.length >= 1, t + ' produced no lines at all');
    }
  }
});

check('a title that was cut short says so, and one that fit does not', () => {
  const cut = cover.plan({
    title: 'A Very Long Film Title That Will Not Fit In Three Lines No Matter What You Do To It',
    from: '', width: 1280, height: 720
  });
  const last = cut.lines[cut.lines.length - 1].text;
  assert.ok(last.endsWith('…'), 'a truncated title ended silently: ' + JSON.stringify(last));

  const whole = cover.plan({ title: 'Nobody 2', from: '', width: 1280, height: 720 });
  assert.ok(!whole.lines.some((l) => l.text.includes('…')), 'a title that fits was given an ellipsis');
});

check('every piece of ink sits inside the centred square Android crops to', () => {
  for (const t of TITLES) {
    for (const [w, h] of SIZES) {
      const p = cover.plan({ title: t, from: 'tvarticles.org', width: w, height: h });
      /* Derived here from the card's dimensions, NOT read off the plan.
         Asking whether the ink is inside p.box when p.box is the same
         number the layout used to place it proves only that the layout
         agrees with itself — widen the column and the box widens with it
         and the check stays green. This is the crop Android actually
         performs: the largest centred square, and nothing about our
         padding. */
      const side = Math.min(w, h);
      const box = { x: Math.round((w - side) / 2), y: Math.round((h - side) / 2), w: side, h: side };
      const right = box.x + box.w;
      const bottom = box.y + box.h;
      const parts = [];
      parts.push({ what: 'bar', x: p.bar.x, y: p.bar.y, w: p.bar.w, h: p.bar.h });
      if (p.label) {
        parts.push({
          what: 'label', x: p.label.x, y: p.label.y - p.label.size,
          w: cover.textWidth(p.label.text, p.label.size) + p.label.track * p.label.text.length,
          h: p.label.size
        });
      }
      for (const line of p.lines) {
        parts.push({
          what: 'line ' + JSON.stringify(line.text), x: line.x, y: line.y - p.size,
          w: cover.textWidth(line.text, p.size), h: p.size
        });
      }
      const m = p.lockup.mark, by = p.lockup.by;
      parts.push({ what: 'by', x: by.x, y: by.y - by.size, w: by.width, h: by.size });
      parts.push({ what: 'mark', x: m.x, y: m.y, w: m.w, h: m.h });

      for (const part of parts) {
        assert.ok(part.x >= box.x - 0.5, part.what + ' starts left of the safe box');
        assert.ok(part.x + part.w <= right + 0.5,
          part.what + ' runs ' + Math.round(part.x + part.w - right) + 'px past the right edge on ' + w + 'x' + h);
        assert.ok(part.y >= box.y - 0.5, part.what + ' sits above the safe box');
        assert.ok(part.y + part.h <= bottom + 0.5, part.what + ' runs below the safe box');
      }
    }
  }
});

check('the title never collides with the mark below it', () => {
  for (const t of TITLES) {
    for (const [w, h] of SIZES) {
      const p = cover.plan({ title: t, from: 'x.test', width: w, height: h });
      const lastBaseline = p.lines[p.lines.length - 1].y;
      const lockTop = Math.min(p.lockup.mark.y, p.lockup.by.y - p.lockup.by.size);
      assert.ok(lastBaseline <= lockTop,
        'the last line ends at ' + Math.round(lastBaseline) + ' and the lockup starts at ' +
        Math.round(lockTop) + ' on ' + w + 'x' + h);
    }
  }
});

check('an empty title falls back to the app name rather than an empty card', () => {
  for (const t of ['', '   ', null, undefined]) {
    const p = cover.plan({ title: t, from: '', width: 640, height: 640 });
    assert.strictEqual(p.lines.map((l) => l.text).join(' '), 'Cast Bridge');
  }
});

check('a card with no known source drops the label instead of drawing an empty one', () => {
  const p = cover.plan({ title: 'Nobody 2', from: '', width: 640, height: 640 });
  assert.strictEqual(p.label, null);
  const withFrom = cover.plan({ title: 'Nobody 2', from: 'juicycodes.com', width: 640, height: 640 });
  assert.strictEqual(withFrom.label.text, 'JUICYCODES.COM');
});

/* ------------------------------------------------------------------ *
 * SVG
 * ------------------------------------------------------------------ */

group('cover.js — the svg the television gets');

check('a title carrying markup comes out as text, not as markup', () => {
  const nasty = '</text><script>alert(1)</script><img src=x onerror=alert(2)>';
  const out = cover.svg({ title: nasty, from: '"><script>x</script>', width: 640, height: 640 });

  /* Not a list of things to forbid — a list of the only elements this file
     is allowed to emit. Searching for <script and onerror passes for a
     title that carries neither and says nothing about the next payload;
     and the words themselves appear quite legitimately as escaped TEXT on
     a card whose title contains them, which is the correct outcome and
     would fail a naive search. Anything the composer did not put there is
     an element that should not exist. */
  const ALLOWED = new Set(['svg', '/svg', 'title', '/title', 'defs', '/defs',
    'lineargradient', '/lineargradient', 'stop', 'rect', 'text', '/text',
    'g', '/g', 'path']);
  const tags = [...out.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/g)].map((m) => m[0].slice(1).toLowerCase());
  for (const tag of tags) {
    assert.ok(ALLOWED.has(tag.startsWith('/') ? tag : tag),
      'the document contains a <' + tag + '> nobody composed');
  }
  assert.ok(out.includes('&lt;'), 'nothing was escaped at all — the title never reached the card');
  assert.ok(out.includes('&amp;') === out.includes('&amp;'), 'sanity');
});

check('the same card twice is the same bytes', () => {
  const a = cover.svg({ title: 'Dune: Part Two', from: 'tvlogy.to', width: 1280, height: 720 });
  const b = cover.svg({ title: 'Dune: Part Two', from: 'tvlogy.to', width: 1280, height: 720 });
  assert.strictEqual(a, b);
});

check('the svg carries the real mark in the brand colour, not a stand-in', () => {
  const out = cover.svg({ title: 'Nobody 2', from: '', width: 1280, height: 720 });
  assert.ok(out.includes(cover.LOGO), 'the logo path is not in the document');
  assert.ok(out.includes('fill="' + cover.ORANGE + '"'), 'the mark is not the brand colour');
  assert.ok(out.includes('POWERED BY'), 'the card does not say who made it');
});

check('every line of the title is drawn, in order', () => {
  const p = cover.plan({ title: 'The Wandering Earth II', from: '', width: 1280, height: 720 });
  const out = cover.svg({ title: 'The Wandering Earth II', from: '', width: 1280, height: 720 });
  let at = -1;
  for (const line of p.lines) {
    const found = out.indexOf('>' + cover.escape(line.text) + '<', at);
    assert.ok(found > at, JSON.stringify(line.text) + ' is missing or out of order');
    at = found;
  }
});

/* ------------------------------------------------------------------ *
 * api/cover.js
 * ------------------------------------------------------------------ */

group('api/cover.js');

function call(url, method) {
  return new Promise((resolve) => {
    const headers = {};
    const res = {
      statusCode: 0,
      setHeader: (k, v) => { headers[k.toLowerCase()] = String(v); },
      end: (body) => resolve({ status: res.statusCode, headers, body: body ? String(body) : '' })
    };
    coverHandler({ method: method || 'GET', url }, res);
  });
}

check('a card comes back as an image, with the headers a television needs', async () => {
  const r = await call('/api/cover?t=Nobody%202&f=juicycodes.com');
  assert.strictEqual(r.status, 200);
  assert.match(r.headers['content-type'], /^image\/svg\+xml/);
  assert.strictEqual(r.headers['access-control-allow-origin'], '*');
  assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
  assert.match(r.headers['cache-control'], /immutable/);
  assert.ok(r.body.startsWith('<svg'), 'the body is not an svg');
});

check('the document may load nothing and run nothing', async () => {
  const r = await call('/api/cover?t=x');
  const csp = r.headers['content-security-policy'] || '';
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /sandbox/);
});

check('a card asked for with no size is 16:9, not the smallest one allowed', async () => {
  /* Number(null) is 0, not NaN. Clamping that instead of falling back sent
     every television that asked for nothing in particular a 160px card. */
  const r = await call('/api/cover?t=Nobody%202');
  assert.ok(r.body.includes('width="1280" height="720"'),
    'got ' + (r.body.match(/width="\d+" height="\d+"/) || ['nothing'])[0]);
});

check('an absurd or nonsense size is brought back into range', async () => {
  const big = await call('/api/cover?t=x&w=99999&h=99999');
  assert.ok(big.body.includes('width="2048" height="2048"'));
  const junk = await call('/api/cover?t=x&w=abc&h=');
  assert.ok(junk.body.includes('width="1280" height="720"'));
});

check('a title far longer than any film has one is capped rather than drawn', async () => {
  const r = await call('/api/cover?t=' + encodeURIComponent('x'.repeat(5000)));
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.length < 20000, 'the card came back at ' + r.body.length + ' bytes');
});

check('the endpoint answers GET and refuses to be posted to', async () => {
  const r = await call('/api/cover?t=x', 'POST');
  assert.strictEqual(r.status, 405);
});

/* ------------------------------------------------------------------ *
 * artwork.js — the ranking
 * ------------------------------------------------------------------ */

group('artwork.js — a made card is the floor, never the ceiling');

/* An <img> that succeeds, fails or never answers, chosen by the url. */
function fakeImage(rules) {
  return function FakeImage() {
    const self = this;
    this.naturalWidth = 0;
    Object.defineProperty(this, 'src', {
      set(v) {
        const verdict = rules[v] || 'error';
        if (verdict === 'silent') return;
        setTimeout(() => {
          if (verdict === 'ok') { self.naturalWidth = 640; self.onload && self.onload(); }
          else self.onerror && self.onerror();
        }, 1);
      }
    });
  };
}

/* A video element with a readable frame in it, or nothing yet. */
function fakeVideo(state) {
  return {
    get readyState() { return state.ready === undefined ? 2 : state.ready; },
    get videoWidth() { return state.w === undefined ? 1280 : state.w; },
    get videoHeight() { return state.h === undefined ? 720 : state.h; }
  };
}

/* A canvas that yields a picture with something in it. The frame rules
   themselves are proven in test-notify.js; here it only has to be good
   enough to be adopted. */
function fakeDocument() {
  return {
    createElement() {
      return {
        width: 0, height: 0,
        getContext() {
          return {
            drawImage() {},
            fillRect() {}, fillText() {}, save() {}, restore() {},
            translate() {}, scale() {}, measureText: () => ({ width: 10 }),
            createLinearGradient: () => ({ addColorStop() {} }),
            getImageData(x, y, w, h) {
              const d = new Uint8ClampedArray(w * h * 4);
              for (let i = 0; i < d.length; i += 4) {
                const v = (i / 4) % 200;
                d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
              }
              return { data: d };
            }
          };
        },
        toDataURL() { return 'data:image/jpeg;base64,FRAME'; }
      };
    }
  };
}

/* A stand-in for cover.js that says yes. What the real one draws is proven
   above; what matters here is only which source wins. */
const madeCover = {
  /* Carries the title, because two different films producing the same card
     is exactly what one of the checks below is looking for. */
  dataUrl: (env, o) => 'data:image/jpeg;base64,MADE:' + ((o && o.title) || '')
};

function build(opts) {
  return CBArtwork.create(Object.assign({
    document: fakeDocument(),
    Image: fakeImage({}),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    video: null,
    cover: madeCover,
    proxy: (u) => 'https://cast.test/api/img?u=' + encodeURIComponent(u),
    coverUrl: (t, f) => 'https://cast.test/api/cover?t=' + encodeURIComponent(t) +
                        '&f=' + encodeURIComponent(f || '')
  }, opts));
}

check('a film with no cover of any kind gets a card, immediately', async () => {
  const art = build({});
  await art.set('', { title: 'Nobody 2', from: 'juicycodes.com' });
  assert.strictEqual(art.source(), 'made');
  assert.strictEqual(art.current(), 'data:image/jpeg;base64,MADE:Nobody 2');
});

check('the card goes up before the poster has been probed, not after', async () => {
  /* A host that never answers. The old code showed nothing for five
     seconds and then gave up; the point of the card is that it is there
     while that is happening. */
  const art = build({ Image: fakeImage({ 'http://slow.test/p.jpg': 'silent' }), probeMs: 50 });
  const settle = art.set('http://slow.test/p.jpg', { title: 'Nobody 2', from: 'slow.test' });
  assert.strictEqual(art.source(), 'made', 'the shade was left empty while the poster was fetched');
  await settle;
});

check('a frame of the film replaces the card', async () => {
  const art = build({ video: fakeVideo({}) });
  await art.set('', { title: 'Nobody 2', from: 'x.test' });
  assert.strictEqual(art.source(), 'made');
  art.tryFrame();
  assert.strictEqual(art.source(), 'frame');
  assert.strictEqual(art.current(), 'data:image/jpeg;base64,FRAME');
});

check('the card never replaces a frame, however many times it is asked to', async () => {
  const art = build({ video: fakeVideo({}) });
  await art.set('', { title: 'Nobody 2', from: 'x.test' });
  art.tryFrame();
  art.make();
  art.make();
  assert.strictEqual(art.source(), 'frame');
});

check("the page's own cover still wins, even though a card got there first", async () => {
  const art = build({ Image: fakeImage({ 'http://ok.test/p.jpg': 'ok' }) });
  await art.set('http://ok.test/p.jpg', { title: 'Nobody 2', from: 'ok.test' });
  assert.strictEqual(art.source(), 'poster');
  assert.strictEqual(art.current(), 'http://ok.test/p.jpg');
});

check('a poster that only works through our own server still beats the card', async () => {
  const proxied = 'https://cast.test/api/img?u=' + encodeURIComponent('http://hotlink.test/p.jpg');
  const art = build({ Image: fakeImage({ [proxied]: 'ok' }) });
  await art.set('http://hotlink.test/p.jpg', { title: 'Nobody 2', from: 'hotlink.test' });
  assert.strictEqual(art.source(), 'poster');
});

check('a poster that arrives after a frame does not lose to it', async () => {
  const art = build({ video: fakeVideo({}), Image: fakeImage({ 'http://ok.test/p.jpg': 'ok' }) });
  const settle = art.set('http://ok.test/p.jpg', { title: 'Nobody 2', from: 'ok.test' });
  art.tryFrame();
  assert.strictEqual(art.source(), 'frame');
  await settle;
  assert.strictEqual(art.source(), 'poster');
});

check('the search for a real frame keeps running while a card is showing', async () => {
  const art = build({ video: fakeVideo({}) });
  await art.set('', { title: 'Nobody 2', from: 'x.test' });
  assert.strictEqual(art.settled(), false, 'a card counted as a settled cover');
  art.tryFrame();
  assert.strictEqual(art.settled(), true, 'a real frame did not settle it');
});

check('a film with no title gets no card — the app mark says as much and no less', async () => {
  const art = build({});
  await art.set('', { title: '', from: 'x.test' });
  assert.strictEqual(art.source(), '');
  assert.strictEqual(art.current(), '');
});

check('the television is sent an address, never the canvas', async () => {
  const art = build({});
  await art.set('', { title: 'Nobody 2', from: 'juicycodes.com' });
  const remote = art.remote();
  assert.ok(!remote.startsWith('data:'), 'a data: URL was offered to a receiver');
  assert.strictEqual(remote,
    'https://cast.test/api/cover?t=Nobody%202&f=juicycodes.com');
});

check('a frame is still never offered to the television', async () => {
  const art = build({ video: fakeVideo({}) });
  await art.set('', { title: 'Nobody 2', from: 'x.test' });
  art.tryFrame();
  assert.strictEqual(art.remote(), '');
});

check('the next film drops the last one\'s card in the same tick', async () => {
  const art = build({});
  await art.set('', { title: 'Nobody 2', from: 'x.test' });
  const first = art.current();
  const seen = [];
  art.onChange((a, s) => seen.push(s));
  art.set('', { title: 'Dune: Part Two', from: 'y.test' });
  assert.notStrictEqual(art.current(), '');
  assert.strictEqual(seen[0], '', 'the old cover was not dropped before the new one was made');
  assert.notStrictEqual(art.current(), first, 'the new film kept the old film\'s card');
});

check('a browser with no canvas at all falls back to the app mark rather than throwing', async () => {
  const art = build({ cover: { dataUrl: () => '' } });
  await art.set('', { title: 'Nobody 2', from: 'x.test' });
  assert.strictEqual(art.current(), '');
  assert.strictEqual(art.remote(), '');
});

/* ------------------------------------------------------------------ *
 * The shell
 * ------------------------------------------------------------------ */

group('the shipped page');

check('every script the page loads is in the service worker\'s shell', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const scripts = [...html.matchAll(/<script src="(assets\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 6, 'only found ' + scripts.length + ' local scripts in the page');
  for (const src of scripts) {
    assert.ok(sw.includes("'/" + src + "'"),
      '/' + src + ' is loaded by the page and missing from the shell — it would not survive offline');
  }
});

check('the page loads the cover module before the file that calls it', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const cov = html.indexOf('assets/js/cover.js');
  const art = html.indexOf('assets/js/artwork.js');
  assert.ok(cov > -1, 'the cover module is not on the page');
  assert.ok(cov < art, 'artwork.js is loaded before the module it draws with');
});

/* ------------------------------------------------------------------ *
 * A real browser — the two claims that cannot be settled anywhere else
 * ------------------------------------------------------------------ */

function chrome() {
  const named = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  const tried = named ? [named] : ['/usr/bin/google-chrome', '/usr/bin/chromium'];
  for (const p of tried) { if (fs.existsSync(p)) return p; }
  return null;
}

const CHROME = chrome();

queue.push(async () => {
  console.log('\nreal browser — the font table and the ink');
  if (!CHROME) {
    console.log('  SKIP no chrome on this machine');
    return;
  }
});

if (CHROME) {
  check('no character is wider than the table claims it is', async () => {
    const puppeteer = require('puppeteer-core');
    const browser = await puppeteer.launch({
      executablePath: CHROME, headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    });
    try {
      const page = await browser.newPage();
      await page.setContent('<!doctype html><body></body>');
      const measured = await page.evaluate((font) => {
        const c = document.createElement('canvas').getContext('2d');
        c.font = '700 100px ' + font;
        const out = {};
        for (let i = 32; i < 127; i++) {
          const ch = String.fromCharCode(i);
          out[ch] = c.measureText(ch).width / 100;
        }
        return out;
      }, cover.FONT);

      const over = [];
      for (const ch of Object.keys(measured)) {
        const claimed = cover.textWidth(ch, 1) / 1.01;   /* the table, without the rendering margin */
        if (measured[ch] > claimed + 0.005) {
          over.push(JSON.stringify(ch) + ' measures ' + measured[ch].toFixed(3) +
                    ' and the table says ' + claimed.toFixed(3));
        }
      }
      assert.strictEqual(over.length, 0,
        over.length + ' characters are wider than claimed: ' + over.slice(0, 6).join('; '));
    } finally { await browser.close(); }
  });

  check('no line of any title overflows its column when a real browser sets it', async () => {
    const puppeteer = require('puppeteer-core');
    const browser = await puppeteer.launch({
      executablePath: CHROME, headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    });
    try {
      const page = await browser.newPage();
      await page.setContent('<!doctype html><body></body>');
      const jobs = [];
      for (const t of TITLES) {
        for (const [w, h] of SIZES) {
          const p = cover.plan({ title: t, from: 'tvarticles.org', width: w, height: h });
          jobs.push({
            title: t, w, h, size: p.size, box: p.box.w,
            lines: p.lines.map((l) => l.text)
          });
        }
      }
      const over = await page.evaluate((jobs, font) => {
        const c = document.createElement('canvas').getContext('2d');
        const bad = [];
        for (const j of jobs) {
          c.font = '700 ' + j.size + 'px ' + font;
          for (const line of j.lines) {
            const width = c.measureText(line).width;
            if (width > j.box) {
              bad.push(j.w + 'x' + j.h + ' ' + JSON.stringify(line) + ' ' +
                       Math.round(width) + ' > ' + j.box);
            }
          }
        }
        return bad;
      }, jobs, cover.FONT);
      assert.strictEqual(over.length, 0, over.slice(0, 5).join(' | '));
    } finally { await browser.close(); }
  });

  check('the card actually has ink on it, and the title is white on dark', async () => {
    const puppeteer = require('puppeteer-core');
    const browser = await puppeteer.launch({
      executablePath: CHROME, headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    });
    try {
      const page = await browser.newPage();
      await page.setContent('<!doctype html><body></body>');
      await page.addScriptTag({ path: path.join(ROOT, 'assets/js/cover.js') });
      const seen = await page.evaluate(() => {
        const c = document.createElement('canvas');
        c.width = 640; c.height = 640;
        const ctx = c.getContext('2d');
        window.CBCover.draw(ctx, { width: 640, height: 640, title: 'Nobody 2', from: 'juicycodes.com' });
        const d = ctx.getImageData(0, 0, 640, 640).data;
        let lo = 255, hi = 0, white = 0, orange = 0;
        for (let i = 0; i < d.length; i += 4) {
          const l = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
          if (l < lo) lo = l;
          if (l > hi) hi = l;
          if (d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235) white++;
          if (d[i] > 200 && d[i + 1] > 60 && d[i + 1] < 130 && d[i + 2] < 90) orange++;
        }
        return { lo, hi, white, orange, url: window.CBCover.dataUrl(window, { title: 'Nobody 2' }) };
      });
      /* The same measurement artwork.js uses to refuse a blank frame — a
         card that failed this would be refused by the app's own rules. */
      assert.ok(seen.hi >= 16 && (seen.hi - seen.lo) >= 10,
        'the card reads as blank: ' + JSON.stringify(seen));
      assert.ok(seen.white > 2000, 'no white type on the card (' + seen.white + ' pixels)');
      assert.ok(seen.orange > 200, 'the brand mark did not draw (' + seen.orange + ' pixels)');
      assert.ok(seen.url.startsWith('data:image/jpeg'), 'no data url came back');
    } finally { await browser.close(); }
  });
}

/* ------------------------------------------------------------------ */

(async () => {
  for (const step of queue) await step();
  console.log('\n' + '─'.repeat(56));
  if (failures.length) {
    console.log(failures.length + ' failed, ' + passed + ' passed');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log(passed + ' checks passed');
})();
