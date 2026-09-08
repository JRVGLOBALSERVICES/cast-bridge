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
  DEFERRED_SRC_ATTRS, NOT_A_PLAYER, botWallPhrase, emptyVerdict,
  offerable, playlistLinks
} = require('../lib/media');
const auth = require('../lib/auth');

const NAV_TIMEOUT_MS = 20000;
/* How long to keep watching after the first poke, and how often to look. */
const WATCH_MS = 18000;
const WATCH_STEP_MS = 3000;
const FRAME_BOOT_MS = 2500;
/* How long the last playlist bodies get to arrive once watching has stopped.
   A cap rather than a wait: an unread playlist costs one segment left in the
   list, and that is a far smaller failure than a scan that never returns. */
const PLAYLIST_READ_MS = 2000;
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
        '--autoplay-policy=no-user-gesture-required',
        '--disable-blink-features=AutomationControlled'
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
      '--autoplay-policy=no-user-gesture-required',
      '--disable-blink-features=AutomationControlled'
    ]),
    defaultViewport: { width: 1280, height: 720 },
    executablePath: await chromium.executablePath(),
    headless: true
  });
}

/* Where the address came from, and nothing else.
 *
 * This used to append "· live stream" to every .m3u8 and "· adaptive
 * stream" to every .mpd, which is a claim about the content made purely
 * from the file extension. A Bigg Boss episode is a fixed-length recording
 * and every row on it read "live stream". The playlist itself settles it —
 * it is live only when it has no #EXT-X-ENDLIST — and /api/probe reads
 * that, so the answer now comes from the stream rather than from its name. */
function detailFor(u, via) {
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

/* The synthetic nudge that starts a player, run inside every frame.
 *
 * At module scope rather than buried in collect() so the suite can execute
 * THIS function against a real page instead of a retyped copy of the rule
 * it enforces. It closes over nothing — the page is its whole world.
 */
function poke() {
  /* A click that leaves the page is worse than no click at all.
   *
   * Measured on tamildude.net: this used to take the FIRST match of a
   * selector that includes a bare `button`, and the first button on that
   * page is the search field's submit. Clicking it navigated the top
   * document to /?s= before the vidmoly embed had built its player — so a
   * page whose stream is perfectly reachable reported no video at all,
   * three times over, once per poke. `[class*="play" i]` has the same
   * hazard from the other end: "display" contains "play", so any
   * display-classed wrapper wearing a link matches.
   *
   * Nothing here is a play control: a form submits, an anchor navigates,
   * and neither has ever been the thing that starts a video. Skipping
   * them costs nothing and is the difference between scanning the page
   * and leaving it. */
  const leaves = (el) => {
    if (!el) return true;
    try {
      if (el.closest('form')) return true;
      if (el.closest('a[href]')) return true;
    } catch (e) { /* no closest() on an exotic node */ }
    const type = String((el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
    return type === 'submit' || type === 'reset';
  };

  const hits = Array.prototype.slice.call(document.querySelectorAll(
    '[class*="play" i],[id*="play" i],[aria-label*="play" i],button,video'
  )).filter((el) => !leaves(el) && typeof el.click === 'function');

  /* A real control before a container that merely sounds like one. The
     first match in document order is routinely the player's own wrapper
     div — measured on desicinema.org, where a 1138x573 div carries a
     "play" class and sits above the control that actually starts the film.
     Clicking the wrapper is not wrong, it is just not the click the player
     is waiting for, and taking it means nothing below ever gets one. */
  const control = hits.find((el) => {
    const tag = (el.tagName || '').toUpperCase();
    if (tag === 'BUTTON' || tag === 'VIDEO') return true;
    return String(el.getAttribute('role') || '').toLowerCase() === 'button';
  });

  const hit = control || hits[0];
  if (hit) hit.click();

  document.querySelectorAll('video').forEach((v) => {
    v.muted = true;
    const p = v.play();
    if (p && p.catch) p.catch(() => {});
  });
}

async function collect(page, target) {
  const found = new Map();

  /* Every address a playlist named. Filled while the page plays, read once
     at the end — a segment is nearly always requested BEFORE the playlist
     that lists it has finished being read, so deciding at the moment of
     capture would decide too early and keep it. */
  const segments = new Set();
  /* Reads of playlist bodies that have not landed yet. Awaited before the
     list is filtered, because a filter that runs first has no evidence. */
  const pending = [];

  const note = (url, via, type) => {
    if (!url || found.has(url)) return;
    if (!/^https?:\/\//i.test(url)) return;
    if (found.size >= 200) return;
    found.set(url, {
      url,
      kind: kindOf(url),
      label: labelFor(url),
      detail: detailFor(url, via),
      /* Kept only to decide, below, whether this is a stream or a piece of
         one. It is stripped before the answer leaves this function. */
      type: type || ''
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
      note(url, 'served to the page', type);
    }
    /* A segment is captured at REQUEST time, a round trip before anything
       has said what it is, so by the time the type arrives the address is
       already known and note() would decline to touch it. Record the type
       anyway: it is the difference between refusing a fragment because a
       server called it video/mp2t and having to infer it from a name the
       site invented. */
    const known = found.get(url);
    if (known && !known.type && type) known.type = type;

    /* A playlist is the only thing on the wire that can say, without
       guessing, which of these addresses are parts rather than wholes. Read
       it here — the body is already in flight, and asking the CDN for it
       again from this box would be a second fetch of a signed address that
       is very often bound to the browser that asked first. */
    if (!/\.m3u8(\?|$)/i.test(url) && !/mpegurl/i.test(type)) return;
    pending.push(
      r.text()
        .then((body) => {
          if (!/#EXTM3U/.test(body)) return;
          const links = playlistLinks(body, url);
          /* A master's URIs are other playlists, and those are worth
             offering — expandHlsMaster exists to find exactly them. */
          if (links.master) return;
          links.urls.forEach((u) => segments.add(u));
        })
        .catch(() => { /* a body already discarded proves nothing either way */ })
    );
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
        /* And nothing that leaves the document, for the reason poke()
           gives at length. A real mouse event on a form or a link inside an
           embed tears down the player just as thoroughly as one on the page
           above it — the only difference is that it is harder to see. */
        let leaves = true;
        try {
          leaves = await handle.evaluate((el) => {
            try {
              if (el.closest('form')) return true;
              if (el.closest('a[href]')) return true;
            } catch (e) { /* exotic node */ }
            const type = String((el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
            return type === 'submit' || type === 'reset';
          });
        } catch (e) {
          leaves = false; /* unreadable is not a reason to refuse to poke */
        }
        if (leaves) continue;
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
    Array.from(found.values()).some(
      (m) => !NOT_A_PLAYER.test(m.url) && offerable(m.url, m.type, segments));

  /* Did this page even have something to play? "Nothing found" on a page
     carrying a player and "nothing found" on a page carrying no player are
     different answers, and telling someone their video needs a sign-in when
     the address simply has no video on it sends them hunting for a password
     that was never the problem.

     Kept as a high-water mark rather than a final reading, because clicking
     can destroy the very thing being counted. */
  let evidence = { players: 0, frames: 0, embeds: 0, embedHost: null, botWall: null };

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
        const seen = await frame.evaluate(() => ({
          n: document.querySelectorAll('video,audio').length,
          /* Capped: a refusal is a sentence, not a document, and the whole
             innerText of a real page is megabytes we would pay to move. */
          text: (document.body && document.body.innerText || '').slice(0, 2000)
        }));
        nested += seen.n;
        if (!evidence.botWall) evidence.botWall = botWallPhrase(seen.text);
      } catch (e) { /* detached or locked — it simply does not count */ }
    }

    try {
      const top = await page.evaluate((attrs, notPlayer) => {
        const re = new RegExp(notPlayer, 'i');
        /* Two counts, not one. `frames` is what is on screen right now;
           `embeds` is every player-shaped frame the page carries, on screen
           or not. A page that keeps its player in a collapsed panel until
           you pick a source has a zero-by-zero box, and reporting that as
           "no embed" told Rj to go and check a perfectly good address. The
           size test still earns its keep against 1x1 tracking frames, so it
           stays — as one of the two answers rather than the only one. */
        const srcOf = (f) => attrs
          .map((a) => f.getAttribute(a) || '')
          .find((v) => /^(https?:)?\/\//i.test(v)) || '';
        const all = Array.from(document.querySelectorAll('iframe'))
          .map((f) => ({ f: f, src: srcOf(f) }))
          .filter((x) => x.src && !re.test(x.src));
        const frames = all.filter((x) => {
          const r = x.f.getBoundingClientRect();
          return r.width > 40 && r.height > 40;
        });
        return {
          players: document.querySelectorAll('video,audio').length,
          frames: frames.length,
          embeds: all.length,
          embedSrc: all.length ? all[0].src : '',
          text: (document.body && document.body.innerText || '').slice(0, 2000)
        };
      }, ['src'].concat(DEFERRED_SRC), NOT_A_PLAYER.source);

      evidence.players = Math.max(evidence.players, nested + top.players);
      evidence.frames = Math.max(evidence.frames, top.frames);
      evidence.embeds = Math.max(evidence.embeds, top.embeds || 0);
      if (!evidence.embedHost && top.embedSrc) {
        try { evidence.embedHost = new URL(top.embedSrc, target).hostname; } catch (e) { /* unparseable */ }
      }
      /* First refusal wins and is never cleared. The wall replaces the page,
         so a later sample of the wreckage says nothing at all — and a signal
         that can be overwritten by its own aftermath is not a signal. */
      if (!evidence.botWall) evidence.botWall = botWallPhrase(top.text);
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

  /* The playlists have to be read before their segments can be recognised
     as segments. A few hundred milliseconds at the end of a scan that has
     already spent its budget watching. */
  try {
    await Promise.race([
      Promise.all(pending),
      new Promise((r) => setTimeout(r, PLAYLIST_READ_MS))
    ]);
  } catch (e) { /* a body that would not come is one fewer piece of evidence */ }

  const media = Array.from(found.values())
    .filter((m) => offerable(m.url, m.type, segments))
    .map((m) => ({ url: m.url, kind: m.kind, label: m.label, detail: m.detail }));

  return { media, title, poster, evidence };
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

    /* An automated browser announces itself, and a player that reads the
       announcement refuses to start — no manifest is ever requested, and
       from underneath that looks identical to a stream we simply failed to
       find. The user agent above already says Chrome; these are the rest of
       the tells that contradicted it. Nothing here defeats a check, it only
       stops the browser volunteering that it is driven, so the page behaves
       the way it does for the person holding the phone.

       Installed on the page, before its own scripts run. */
    await page.evaluateOnNewDocument(() => {
      /* Set by the automation protocol itself. The launch flag above
         removes it in most builds; this covers the ones where it does not. */
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      } catch (e) { /* already non-configurable */ }

      /* A headless build ships no plugins and no mime types, and an empty
         list is the second-most-read tell after webdriver. */
      try {
        if (!navigator.plugins || !navigator.plugins.length) {
          Object.defineProperty(navigator, 'plugins', {
            get: () => [1, 2, 3, 4, 5]
          });
        }
        if (!navigator.languages || !navigator.languages.length) {
          Object.defineProperty(navigator, 'languages', {
            get: () => ['en-US', 'en']
          });
        }
      } catch (e) { /* locked down by the page */ }

      /* window.chrome exists in every desktop Chrome and in no headless
         one, so its absence contradicts the user agent directly. */
      try {
        if (!window.chrome) window.chrome = { runtime: {} };
      } catch (e) { /* frozen */ }
    });

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
      const saw = result.evidence || { players: 0, frames: 0, embeds: 0, botWall: null };

      /* One sentence per genuinely different problem, composed in
         lib/media.js so it can be proved without a browser. */
      const verdict = emptyVerdict(saw);
      const error = verdict.error;

      res.statusCode = 200;
      res.end(JSON.stringify({
        ok: false,
        empty: true,
        deep: true,
        finalUrl: target,
        saw,
        botWall: saw.botWall || null,
        why: verdict.why,
        error
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

/* The two halves of the deep scan, on their own, so something other than
 * this endpoint can run one.
 *
 * The reason is cost, not tidiness. Some CDNs sign a media address to the
 * NETWORK that asked for it, so an address minted here is an address only
 * this host may fetch — and when the box that has to fetch it is the VPS
 * carrying the film, "scan on Vercel, fetch on the VPS" is a refusal by
 * construction. The answer is to run the scan where the fetching happens,
 * which means lib/reissue.js needs the browser half of this file without
 * the endpoint half: no session, no store, no HTTP.
 *
 * Exported rather than copied for the reason server/stream-server.js
 * requires api/stream.js rather than reimplementing it — two scanners
 * would drift, and the one that drifted would be the one nobody runs
 * locally.
 */
module.exports.launch = launch;
module.exports.collect = collect;
module.exports.poke = poke;
