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
const HARD_BUDGET_MS = 45000;

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

  /* Plenty of players only fetch the manifest once something is clicked.
     One nudge at whatever looks like a play control is worth the second. */
  try {
    await page.evaluate(() => {
      const hit = document.querySelector(
        '[class*="play" i],[id*="play" i],[aria-label*="play" i],button,video'
      );
      if (hit && typeof hit.click === 'function') hit.click();
      document.querySelectorAll('video').forEach((v) => {
        v.muted = true;
        const p = v.play();
        if (p && p.catch) p.catch(() => {});
      });
    });
  } catch (e) { /* a page that refuses to be poked is still worth watching */ }

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

  return { media: Array.from(found.values()), title, poster };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: 'Use GET.' }));
    return;
  }

  if (!auth.guard(req, res)) return;

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
      res.statusCode = 200;
      res.end(JSON.stringify({
        ok: false,
        empty: true,
        deep: true,
        finalUrl: target,
        error: 'Ran the page in a browser and watched everything it fetched. ' +
          'Nothing playable came through. The video may need a sign-in, or ' +
          'it may be encrypted like the big streaming apps are.'
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
