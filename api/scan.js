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
  expandHlsMaster, walledService, walledMessage,
  DEFERRED_SRC_ATTRS, NOT_A_PLAYER
} = require('../lib/media');
const auth = require('../lib/auth');

const NAV_TIMEOUT_MS = 20000;
/* How long to keep watching after the first poke, and how often to look. */
const WATCH_MS = 18000;
const WATCH_STEP_MS = 3000;
const FRAME_BOOT_MS = 2500;
const HARD_BUDGET_MS = 45000;

/* Where a lazy-loading page parks the real address until it decides to load.
   LiteSpeed Cache, WP Rocket and the rest of the caching plugins all do this,
   so it is an ordinary-web pattern, not an exotic one. */
const DEFERRED_SRC = DEFERRED_SRC_ATTRS;

/* Frames that are never a player, so their presence must not be read as
   "there is a player here but we missed its stream". Shared with the quick
   scan so one list governs both passes. */

/* Content types that mean "this response is playable", for the cases where
   the URL carries no useful extension (signed CDN links usually don't). */
const MEDIA_TYPE =
  /^(video\/|audio\/|application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml))/i;

/* What a play control looks like. Deliberately narrower than the selector the
   in-page poke uses: that one may fall back to any `button`, because a
   synthetic click on the wrong button costs nothing. A real mouse event on the
   wrong button navigates away from the page we came to scan. */
const PLAY_CONTROL =
  '[class*="play" i],[id*="play" i],[aria-label*="play" i],[title*="play" i],video';

/* Enough to reach an overlay and the control beneath it, few enough that a
   page of "player"-classed wrappers cannot eat the whole budget. */
const MAX_TRUSTED_CLICKS = 3;

/* How long one click may take before we move on. */
const CLICK_TIMEOUT_MS = 4000;

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

  const puppeteer = require('puppeteer-core');

  /* The deployed function has no browser of its own, so it carries one. A
     machine that already has Chrome can point at it instead, which is the
     only way to run this path anywhere but production — without it the deep
     scan can only ever be tested by deploying it. */
  if (process.env.CHROME_EXECUTABLE_PATH) {
    return puppeteer.launch({
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--autoplay-policy=no-user-gesture-required'
      ],
      defaultViewport: { width: 1280, height: 720 },
      executablePath: process.env.CHROME_EXECUTABLE_PATH,
      headless: true
    });
  }

  const chromium = require('@sparticuz/chromium');

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

/* Installed in every frame before that frame's own scripts run.
 *
 * Watching URLs is not enough, and desicinema.org is where that stopped
 * being a theory: its player asks movieshub.rpmplay.xyz/api/v1/info for
 * its source, that answers 200 with an encrypted hex body, and the page
 * decrypts it in JavaScript. The address never appears in a request URL,
 * in a response body, or in an attribute a scanner can read from outside.
 * The only place it is ever in the clear is inside the page, for the
 * instant the player uses it.
 *
 * So read it there. Nothing below breaks anything: no key is recovered, no
 * sign-in is bypassed, no DRM is touched — a page that hands its own
 * player a plain address is simply asked what that address was. A page
 * whose media is genuinely encrypted, the way the big streaming apps do
 * it, puts nothing in the clear here and still yields nothing, which is
 * the correct answer for it.
 */
const INSTRUMENT = function () {
  try {
    if (window.__cbHooked) return;
    window.__cbHooked = true;
    var seen = (window.__cbSeen = []);

    var MEDIA =
      /https?:\/\/[^\s"'<>\\)]+?\.(m3u8|mpd|mp4|m4v|webm|mkv|mov|m4a|mp3)(\?[^\s"'<>\\)]*)?/gi;

    function push(u, via) {
      try {
        if (typeof u !== 'string' || !u) return;
        if (seen.length > 60) return;
        /* A blob: or MediaSource handle is a local object, not an address
           anything else could ever fetch. */
        if (/^(blob:|data:|about:)/i.test(u)) return;
        var abs = new URL(u, document.baseURI).href;
        if (!/^https?:/i.test(abs)) return;
        for (var i = 0; i < seen.length; i++) if (seen[i].url === abs) return;
        seen.push({ url: abs, via: via });
      } catch (e) { /* an unparseable string is not an address */ }
    }

    /* Text that may carry an address somewhere inside it. */
    function sweep(text, via) {
      try {
        if (typeof text !== 'string') return;
        if (text.length > 2000000) return;
        if (text.indexOf('http') === -1) return;
        var m = text.match(MEDIA);
        if (!m) return;
        for (var i = 0; i < m.length && i < 20; i++) push(m[i], via);
      } catch (e) { /* a hostile string is not worth the frame */ }
    }

    /* Whatever the player finally hands the media element IS the stream,
       extension or not — signed CDN links usually carry none. */
    try {
      var d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
      if (d && d.set) {
        Object.defineProperty(HTMLMediaElement.prototype, 'src', {
          configurable: true,
          enumerable: d.enumerable,
          get: d.get,
          set: function (v) { push(v, 'set on the player'); return d.set.call(this, v); }
        });
      }
    } catch (e) { /* a frame that froze its prototypes keeps the rest */ }

    try {
      var setAttr = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function (name, value) {
        try {
          if (/^src$/i.test(name) && /^(video|audio|source)$/i.test(this.tagName)) {
            push(value, 'set on the player');
          }
        } catch (e) { /* keep the assignment working whatever happens */ }
        return setAttr.apply(this, arguments);
      };
    } catch (e) { /* ditto */ }

    /* A response body in the clear. This is the ordinary case the old scan
       missed outright: plenty of players fetch a plain JSON manifest, and
       the address only ever exists inside it, never in a URL. */
    try {
      var fetch0 = window.fetch;
      if (typeof fetch0 === 'function') {
        window.fetch = function () {
          return fetch0.apply(this, arguments).then(function (res) {
            try {
              var type = (res.headers.get('content-type') || '').toLowerCase();
              var len = Number(res.headers.get('content-length') || 0);
              /* Never read a media body — that is the stream itself, and
                 draining it would cost the page its playback. */
              if (/(json|text|javascript|xml|urlencoded)/.test(type) && len < 524288) {
                res.clone().text().then(function (t) {
                  sweep(t, 'answered to the player');
                }, function () {});
              }
            } catch (e) { /* the response is still the page's to use */ }
            return res;
          });
        };
      }
    } catch (e) { /* ditto */ }

    try {
      var send0 = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function () {
        try {
          this.addEventListener('load', function () {
            try {
              if (this.responseType && this.responseType !== 'text') return;
              sweep(this.responseText, 'answered to the player');
            } catch (e) { /* cross-origin or binary — nothing to read */ }
          });
        } catch (e) { /* keep the request working */ }
        return send0.apply(this, arguments);
      };
    } catch (e) { /* ditto */ }

    /* The two places a decrypted payload becomes readable text. Hooking
       these is what catches an address that was encrypted on the wire:
       whatever the page's own code decrypts, it then parses or decodes,
       and at that moment it is an ordinary string. */
    try {
      var parse0 = JSON.parse;
      JSON.parse = function (text) {
        sweep(text, 'read out of the player');
        return parse0.apply(this, arguments);
      };
    } catch (e) { /* ditto */ }

    try {
      var atob0 = window.atob;
      if (typeof atob0 === 'function') {
        window.atob = function () {
          var out = atob0.apply(this, arguments);
          sweep(out, 'read out of the player');
          return out;
        };
      }
    } catch (e) { /* ditto */ }
  } catch (e) { /* instrumentation must never cost the page its load */ }
};

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

  /* Before the navigation, so it lands in the top document AND in every
     frame the page builds afterwards — which is where the player is. */
  try {
    await page.evaluateOnNewDocument(INSTRUMENT);
  } catch (e) { /* an older protocol still gets everything else */ }

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

  /* A player that builds its source only on a real user gesture ignores
     everything above. `el.click()` from page script arrives with
     `isTrusted: false`, and that flag is exactly what such a player tests —
     it is the one thing page script cannot forge. A CDP mouse event is a real
     one as far as the renderer is concerned, so it passes the same test, and
     puppeteer resolves the coordinates through the frame tree, so a control
     inside a cross-origin embed is clicked where it actually sits on screen. */
  const trustedPoke = async (frame) => {
    let handles = [];
    try { handles = await frame.$$(PLAY_CONTROL); } catch (e) { return; }

    let used = 0;
    for (const handle of handles) {
      try {
        if (used >= MAX_TRUSTED_CLICKS) continue;
        const box = await handle.boundingBox();
        /* No box means off-screen or `display:none`; a sliver means an icon
           that never rendered. Neither is the control a person would hit. */
        if (!box || box.width < 16 || box.height < 16) continue;
        used++;
        /* A click can block indefinitely: puppeteer scrolls the element into
           view first, and a frame that is busy loading an ad never settles.
           The budget is for watching the page, not for one control. */
        await Promise.race([
          handle.click({ delay: 20 }),
          new Promise((r) => setTimeout(r, CLICK_TIMEOUT_MS))
        ]);
      } catch (e) {
        /* covered by an overlay, scrolled out of reach, or detached mid-click */
      } finally {
        await handle.dispose().catch(() => {});
      }
    }
  };

  /* At most twice per frame. Poking a third time is not more persuasive, and
     a click on a video that is already playing pauses it. */
  const pokes = new Map();

  const pokeEveryFrame = async () => {
    for (const frame of page.frames()) {
      const seen = pokes.get(frame.url()) || 0;
      if (seen >= 2) continue;
      pokes.set(frame.url(), seen + 1);

      try {
        await frame.evaluate(poke);
      } catch (e) { /* detached, cross-origin-locked, or hostile — keep going */ }

      /* Never a real click on the top document. Measured on desicinema.org:
         the page's own 1138x573 player wrapper carries a "play" class, and a
         trusted click on it navigates — which destroys the very frames the
         player lives in, so the scan then finds nothing on a page that was
         about to work. The synthetic poke above is harmless there and still
         runs; the real mouse stays inside the embed, which is where a control
         that gates on a gesture actually is. */
      if (frame !== page.mainFrame()) await trustedPoke(frame);
    }
  };

  /* Whatever the player finally put on the <video> element counts too — in
     every frame, because that is where the element lives. Reading only the
     top document finds the media element on the rare site that hosts its own
     player and misses it on every site that embeds one, which is most of
     them: the page holds an iframe, that iframe holds another, and the
     <video> is at the bottom. */
  /* Drain what the hooks saw, in every frame. Kept apart from reading the
     DOM because the two answer different questions: the DOM says what is on
     the element now, the hooks say what the page ever handed it. A player
     that sets a source and is then torn down by an ad leaves nothing in the
     DOM and everything here. */
  const readInstrumented = async () => {
    for (const frame of page.frames()) {
      try {
        const rows = await frame.evaluate(() => {
          const out = window.__cbSeen || [];
          window.__cbSeen = [];
          return out;
        });
        rows.forEach((r) => note(r.url, r.via));
      } catch (e) { /* detached or navigated away mid-read */ }
    }
  };

  const readMediaElements = async () => {
    for (const frame of page.frames()) {
      try {
        const inline = await frame.evaluate(() => {
          const out = [];
          document.querySelectorAll('video,audio,source').forEach((el) => {
            if (el.currentSrc) out.push(el.currentSrc);
            if (el.src) out.push(el.src);
          });
          return out;
        });
        inline.forEach((u) => note(u, 'set on the player'));
      } catch (e) { /* detached or navigated away mid-read */ }
    }
  };

  /* An embed builds its own inner frame only after it boots, so the frame
     holding the real player does not exist during the first pass. Two passes
     with a fixed gap was a guess at when it would, and it was a coin flip:
     the same page reported three media elements on one run and none on the
     next. Watch instead — poke whatever is new, read what is there, and stop
     as soon as something playable turns up that is not an advert. */
  const realMedia = () =>
    Array.from(found.keys()).some((u) => !NOT_A_PLAYER.test(u));

  /* Did this page even have something to play? "Nothing found" on a page
     carrying a player and "nothing found" on a page carrying no player are
     different answers, and telling someone their video needs a sign-in when
     the address simply has no video on it sends them hunting for a password
     that was never the problem.

     Kept as a high-water mark rather than a final reading, because clicking
     can destroy the very thing being counted. */
  let evidence = { players: 0, frames: 0 };

  const sampleEvidence = async () => {
    let nested = 0;

    /* Count media elements wherever they are. The top document of an
       embedding site holds no <video> at all, so counting only there reports
       `players: 0` for a page that is, two frames down, showing a film — and
       the viewer is told there is nothing here when there plainly is. Ad
       frames are skipped so an unsold pre-roll slot is not mistaken for the
       feature. */
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      if (NOT_A_PLAYER.test(frame.url())) continue;
      try {
        nested += await frame.evaluate(
          () => document.querySelectorAll('video,audio').length
        );
      } catch (e) { /* detached or locked — it simply does not count */ }
    }

    try {
      const top = await page.evaluate((attrs, notPlayer) => {
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

      evidence.players = Math.max(evidence.players, nested + top.players);
      evidence.frames = Math.max(evidence.frames, top.frames);
    } catch (e) {
      /* an unreadable top document still leaves what the frames reported */
      evidence.players = Math.max(evidence.players, nested);
    }
  };

  /* Look before touching anything. This is not tidiness: measured on
     desicinema.org, the embed at movieshub.rpmplay.xyz loads
     `download-page-link.js` and sells its first click — clicking the player
     navigates that frame away, so its three <video> elements cease to exist
     and a scan that clicked before it counted reports an empty page. Sample
     first, poke second, and let the count only ever rise. */
  const deadline = Date.now() + WATCH_MS;
  while (Date.now() < deadline) {
    await sampleEvidence();
    await readMediaElements();
    await readInstrumented();
    if (realMedia()) break;
    await pokeEveryFrame();
    await new Promise((r) => setTimeout(r, WATCH_STEP_MS));
  }
  await sampleEvidence();
  await readMediaElements();
  await readInstrumented();

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

    /* A real click on an embed's play control often opens an ad tab, and a
       background page goes on requesting for the rest of our budget. Close
       anything that is not the page we opened. */
    browser.on('targetcreated', async (t) => {
      try {
        if (t.type() !== 'page') return;
        const opened = await t.page();
        if (opened && opened !== page) await opened.close().catch(() => {});
      } catch (e) { /* the target closed itself first */ }
    });
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0 Safari/537.36'
    );

    const result = await collect(page, target);

    /* Expand a master playlist so the quality picker has real options,
       the same way the quick scan does. */
    const masters = result.media.filter((x) => x.kind === 'HLS').slice(0, 2);
    if (masters.length) {
      const known = new Set(result.media.map((x) => x.url));
      for (const master of masters) {
        const variants = await expandHlsMaster(master.url);
        variants.forEach((v) => {
          if (!known.has(v.url)) { result.media.push(v); known.add(v.url); }
        });
      }
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
