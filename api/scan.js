/* GET /api/scan?url=<page>
 *
 * The deep scan. Opens the page in a real headless browser, lets its
 * JavaScript run, and watches every network request the page makes for
 * something a TV can play.
 *
 * This exists because the quick scan at /api/extract only reads the HTML
 * that came off the wire. Most video sites ship a page with no <video> tag
 * at all and have a player script fetch the manifest afterwards — to a
 * fetch-and-parse scanner those pages look empty even though the stream is
 * right there. Running the page is the only way to see it, which is exactly
 * what the phone apps that do this well are doing behind their "in-app
 * browser". It costs a few seconds and a cold start, so it is the second
 * thing tried, not the first.
 */

const {
  MAX_RESULTS, MEDIA_EXT, assertPublic, kindOf, labelFor, rank,
  expandHlsMaster, walledService, walledMessage
} = require('../lib/media');
const auth = require('../lib/auth');

const NAV_TIMEOUT_MS = 20000;
const SETTLE_MS = 6000;
const FRAME_BOOT_MS = 2500;
const HARD_BUDGET_MS = 45000;

/* Where a lazy-loading page parks the real address until it decides to load.
   LiteSpeed Cache, WP Rocket and the rest of the caching plugins all do this,
   so it is an ordinary-web pattern, not an exotic one. */
const DEFERRED_SRC = [
  'data-litespeed-src', 'data-src', 'data-lazy-src', 'data-original', 'data-url'
];

/* Frames that are never a player, so their presence must not be read as
   "there is a player here but we missed its stream". */
const NOT_A_PLAYER =
  /googletagmanager|google-analytics|doubleclick|adservice|adsystem|facebook\.com|recaptcha|disqus/i;

/* Content types that mean "this response is playable", for the cases where
   the URL carries no useful extension (signed CDN links usually don't). */
const MEDIA_TYPE =
  /^(video\/|audio\/|application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml))/i;

/* Chromium is only present on the deployed function. Loading it lazily keeps
   a missing local install from breaking the module for everything else. */
async function launch() {
  /* @sparticuz/chromium only unpacks its shared libraries when it believes
     it is on Lambda, which it decides by reading AWS_EXECUTION_ENV or
     AWS_LAMBDA_JS_RUNTIME. Vercel's Node runtime sets neither, so the
     package skips the unpack and the browser dies on a missing libnss3.so.
     Naming the runtime here picks its Amazon Linux 2023 branch, which is
     what this function actually runs on. Set before the require, because
     the package reads it at import time as well as at extraction time. */
  if (!process.env.AWS_EXECUTION_ENV && !process.env.AWS_LAMBDA_JS_RUNTIME) {
    process.env.AWS_LAMBDA_JS_RUNTIME = 'nodejs22.x';
  }

  const chromium = require('@sparticuz/chromium');
  const puppeteer = require('puppeteer-core');

  return puppeteer.launch({
    args: chromium.args.concat([
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required'
    ]),
    defaultViewport: { width: 1280, height: 720 },
    executablePath: await chromium.executablePath(),
    headless: true
  });
}

function detailFor(u, via) {
  const p = String(u).split('?')[0];
  if (/\.m3u8$/i.test(p)) return via + ' · live stream';
  if (/\.mpd$/i.test(p)) return via + ' · adaptive stream';
  return via;
}

async function collect(page, target) {
  const found = new Map();

  const note = (url, via) => {
    if (!url || found.has(url)) return;
    if (!/^https?:\/\//i.test(url)) return;
    if (found.size >= 200) return;
    found.set(url, {
      url,
      kind: kindOf(url),
      label: labelFor(url),
      detail: detailFor(url, via)
    });
  };

  page.on('request', (r) => {
    const url = r.url();
    if (MEDIA_EXT.test(url)) note(url, 'requested by the page');
  });

  page.on('response', (r) => {
    const url = r.url();
    const type = (r.headers()['content-type'] || '').toLowerCase();
    if (MEDIA_EXT.test(url) || MEDIA_TYPE.test(type)) {
      note(url, 'served to the page');
    }
  });

  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

  /* A lazy-loaded player is an empty frame until the page decides to fill it.
     The caching plugins ship `src="about:blank"` and keep the real address in
     a data- attribute, swapping it in on scroll or on first touch. A scanner
     that only waits sees about:blank for the whole budget and then reports a
     page that plainly has a player on it as having no video at all. Promote
     the deferred address ourselves instead of hoping the page gets round to
     it, and scroll, because scrolling is what most lazy-loaders listen for. */
  let promoted = 0;
  try {
    promoted = await page.evaluate((attrs) => {
      let n = 0;
      document.querySelectorAll('iframe').forEach((f) => {
        const cur = f.getAttribute('src') || '';
        if (cur && cur !== 'about:blank') return;
        for (const a of attrs) {
          const v = f.getAttribute(a);
          if (v && /^(https?:)?\/\//i.test(v)) { f.setAttribute('src', v); n++; break; }
        }
      });
      const h = document.body ? document.body.scrollHeight : 0;
      window.scrollTo(0, h);
      window.scrollTo(0, 0);
      return n;
    }, DEFERRED_SRC);
  } catch (e) { /* a page that refuses to be read is still worth watching */ }

  if (promoted) await new Promise((r) => setTimeout(r, FRAME_BOOT_MS));

  /* The play control is nearly always inside the player's own frame, not on
     the page that embeds it. Poking only the top document clicks the site's
     own chrome and leaves the player untouched, so walk every frame. */
  const poke = () => {
    const hit = document.querySelector(
      '[class*="play" i],[id*="play" i],[aria-label*="play" i],button,video'
    );
    if (hit && typeof hit.click === 'function') hit.click();
    document.querySelectorAll('video').forEach((v) => {
      v.muted = true;
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
    });
  };

  const pokeEveryFrame = async () => {
    for (const frame of page.frames()) {
      try {
        await frame.evaluate(poke);
      } catch (e) { /* detached, cross-origin-locked, or hostile — keep going */ }
    }
  };

  /* Twice, with a gap. An embed usually builds its own inner frame only after
     it boots, so the frame holding the actual play control does not exist yet
     during the first pass — poking once means poking everything except the
     one that matters. */
  await pokeEveryFrame();
  await new Promise((r) => setTimeout(r, FRAME_BOOT_MS));
  await pokeEveryFrame();

  await new Promise((r) => setTimeout(r, SETTLE_MS));

  /* Whatever the player finally put on the <video> element counts too. */
  try {
    const inline = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('video,audio,source').forEach((el) => {
        if (el.currentSrc) out.push(el.currentSrc);
        if (el.src) out.push(el.src);
      });
      return out;
    });
    inline.forEach((u) => note(u, 'set on the player'));
  } catch (e) { /* navigated away mid-read */ }

  let title = '';
  let poster = null;
  try {
    const meta = await page.evaluate(() => ({
      t: document.title || '',
      p: (document.querySelector('video[poster]') || {}).poster ||
         (document.querySelector('meta[property="og:image"]') || {}).content || null
    }));
    title = meta.t;
    poster = meta.p;
  } catch (e) { /* keep the media, drop the trimmings */ }

  /* Did this page even have something to play? "Nothing found" on a page
     carrying a player and "nothing found" on a page carrying no player are
     different answers, and telling someone their video needs a sign-in when
     the address simply has no video on it sends them hunting for a password
     that was never the problem. */
  let evidence = { players: 0, frames: 0 };
  try {
    evidence = await page.evaluate((attrs, notPlayer) => {
      const re = new RegExp(notPlayer, 'i');
      const frames = Array.from(document.querySelectorAll('iframe')).filter((f) => {
        const src = attrs
          .map((a) => f.getAttribute(a) || '')
          .find((v) => /^(https?:)?\/\//i.test(v)) || '';
        if (!src || re.test(src)) return false;
        const r = f.getBoundingClientRect();
        return r.width > 40 && r.height > 40;
      });
      return {
        players: document.querySelectorAll('video,audio').length,
        frames: frames.length
      };
    }, ['src'].concat(DEFERRED_SRC), NOT_A_PLAYER.source);
  } catch (e) { /* an unreadable page just gets the vaguer message */ }

  return { media: Array.from(found.values()), title, poster, evidence };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: 'Use GET.' }));
    return;
  }

  const user = await auth.guard(req, res);
  if (!user) return;

  const raw = (req.query && req.query.url) ||
    new URL(req.url, 'http://localhost').searchParams.get('url');

  if (!raw) {
    res.statusCode = 400;
    res.end(JSON.stringify({ ok: false, error: 'No address given.' }));
    return;
  }

  let target = String(raw).trim();
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;

  const walled = walledService(target);
  if (walled) {
    res.statusCode = 200;
    res.end(JSON.stringify({
      ok: false, walled: walled.why, service: walled.name,
      error: walledMessage(walled)
    }));
    return;
  }

  /* Same address check the quick scan does. A browser makes SSRF worse, not
     better — it will happily follow a redirect into a private network. */
  try {
    await assertPublic(target);
  } catch (err) {
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: false, error: err.message }));
    return;
  }

  let browser = null;
  const budget = setTimeout(() => {
    if (browser) browser.close().catch(() => {});
  }, HARD_BUDGET_MS);

  try {
    browser = await launch();
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0 Safari/537.36'
    );

    const result = await collect(page, target);

    /* Expand a master playlist so the quality picker has real options,
       the same way the quick scan does. */
    const master = result.media.find((x) => x.kind === 'HLS');
    if (master) {
      const variants = await expandHlsMaster(master.url);
      const known = new Set(result.media.map((x) => x.url));
      variants.forEach((v) => {
        if (!known.has(v.url)) { result.media.push(v); known.add(v.url); }
      });
    }

    result.media.sort((a, b) => rank(a) - rank(b));
    const media = result.media.slice(0, MAX_RESULTS);

    if (!media.length) {
      const saw = result.evidence || { players: 0, frames: 0 };
      const noPlayer = !saw.players && !saw.frames;
      res.statusCode = 200;
      res.end(JSON.stringify({
        ok: false,
        empty: true,
        deep: true,
        finalUrl: target,
        saw,
        error: noPlayer
          ? 'Ran the page in a browser. There is no video on it at all — no ' +
            'player, no embed, nothing to cast. Check the address is the one ' +
            'you meant to send.'
          : 'Ran the page in a browser, opened its player and watched every ' +
            'request. The player is there but never fetched anything ' +
            'playable. It probably needs a sign-in, or it is encrypted the ' +
            'way the big streaming apps are.'
      }));
      return;
    }

    res.statusCode = 200;
    res.end(JSON.stringify({
      ok: true,
      deep: true,
      finalUrl: target,
      title: result.title,
      poster: result.poster,
      media,
      direct: false
    }));
  } catch (err) {
    res.statusCode = 200;
    res.end(JSON.stringify({
      ok: false,
      deep: true,
      error: 'The deep scan could not finish: ' +
        ((err && err.message) || 'the browser stopped early') + '.'
    }));
  } finally {
    clearTimeout(budget);
    if (browser) { try { await browser.close(); } catch (e) { /* gone already */ } }
  }
};
