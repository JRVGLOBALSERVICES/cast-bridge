/* Re-asking a page for an address that has stopped working.
 *
 * Some hosts sign a media address to the network that asked for it. Proved
 * on sys.vkcdn5.com, which is what the vkprime embed serves through: a link
 * this server was given still plays eight minutes later, and the very same
 * link issued to a different address answers 200 with fourteen bytes of
 * HTML. Not expiry — ownership.
 *
 * That breaks the arrangement this app is built on. The scan runs here, the
 * playing runs on a phone, and the casting runs on a television, which is
 * three networks for one address. The phone gets a refusal, and every
 * signal it can see says "dead link" — which is exactly what it used to be
 * told, about an address that was alive and simply not its.
 *
 * /api/stream already exists to fetch on the television's behalf, so the
 * hop that fixes it is one we already make. What was missing is that when
 * the hop is refused, the proxy holds the page the media came from and can
 * simply ask it again, from here, and be handed an address of its own.
 *
 * Kept narrow on purpose:
 *   - only ever returns an address on the SAME host as the one that
 *     failed, so a page cannot use this to redirect a television anywhere
 *     of its choosing;
 *   - one page fetch and up to three frame fetches, no probing, because
 *     this runs inside a request a television is waiting on;
 *   - memoised, because seeking is a burst of Range requests and each one
 *     would otherwise re-scan the page.
 */

const {
  deobfuscate, extract, collectFrames, readCapped, safeFetch
} = require('./media');

const MAX_FRAMES = 3;
const FRAME_TIMEOUT_MS = 7000;

const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 50;
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key, value) {
  if (cache.size >= MAX_ENTRIES) {
    /* Oldest insertion first — Map preserves it, and a strict LRU buys
       nothing at fifty entries. */
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, { at: Date.now(), value });
}

/* Two addresses are the same rendition when they differ only in the part
   that was signed: same host, same filename, same number of path steps.
   These hosts serve every quality as `/<opaque>/v.mp4`, so the filename
   alone would match all of them — the label is what separates them, and
   this is the fallback for when there is no label to go on. */
function sameShape(a, b) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    if (!sameSite(a, b)) return false;
    const xs = x.pathname.split('/').filter(Boolean);
    const ys = y.pathname.split('/').filter(Boolean);
    if (xs.length !== ys.length) return false;
    return xs[xs.length - 1] === ys[ys.length - 1];
  } catch (e) {
    return false;
  }
}

function sameHost(a, b) {
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch (e) {
    return false;
  }
}

/* Second-level labels that are a registry rather than somebody's site.
   Short and deliberately incomplete: it exists so `a.co.uk` and `b.co.uk`
   are not read as one site, not to be a public-suffix list. */
const REGISTRY_LABEL = /^(co|com|net|org|gov|edu|ac|or|ne|in)$/i;

/* The same SITE, which is not the same host.
 *
 * These CDNs rotate their edge per issue. Measured on the vidmoly embed:
 * the address that was refused sat on prx-1317-ant.vmpx.online and the one
 * the page handed over a minute later sat on prx-1559-ant.vmpx.online —
 * same path, same film, different edge. A same-HOST rule reads that
 * correct replacement as an attempt to redirect the television somewhere
 * else and throws it away, which is a repair that can never once succeed.
 *
 * So: identical, or differing only in the leftmost label with at least two
 * labels of agreement behind it. That is wide enough for a rotating edge
 * and still narrow enough to be the guard it is there to be — a stranger's
 * page cannot use this to point a fetch at a host of its choosing, only at
 * a neighbour of the one that already refused us.
 */
function sameSite(a, b) {
  try {
    const x = new URL(a).hostname.toLowerCase();
    const y = new URL(b).hostname.toLowerCase();
    if (x === y) return true;

    const xs = x.split('.');
    const ys = y.split('.');
    if (xs.length < 3 || ys.length < 3) return false;

    const xr = xs.slice(1);
    const yr = ys.slice(1);
    if (xr.length !== yr.length) return false;
    if (xr.join('.') !== yr.join('.')) return false;
    /* `a.co.uk` vs `b.co.uk` agree on "co.uk", which is a registry and not
       a site. Two labels of agreement only counts when the first of them
       is somebody's name. */
    if (xr.length === 2 && REGISTRY_LABEL.test(xr[0])) return false;
    return true;
  } catch (e) {
    return false;
  }
}

/* Everything the page offers now, each entry remembering the document it
   came from.
 *
 * That last part is the whole reason this does its own frame walk instead
 * of calling readFrames: the address belongs to the embed, not to the
 * wrapper around it, and the host checks. Handing sys.vkcdn5.com the
 * blog's address as the referer is a 403 on a link that was issued
 * seconds earlier and works with the embed's. */
async function rescan(pageUrl) {
  const cached = cacheGet('page:' + pageUrl);
  if (cached !== undefined) return cached;

  const readable = (res) => {
    const t = (res.headers.get('content-type') || '').toLowerCase();
    return t.includes('html') || t.includes('text') || t.includes('xml');
  };
  const drop = (res) => {
    try { res && res.body && res.body.cancel(); } catch (e) { /* already gone */ }
  };

  let media = [];
  try {
    const { res, url } = await safeFetch(pageUrl);
    if (!res.ok || !readable(res)) {
      drop(res);
    } else {
      const html = deobfuscate(await readCapped(res));
      media = extract(html, url).media
        .map((x) => ({ url: x.url, label: x.label, from: url }));

      if (!media.length) {
        const frames = collectFrames(html, url).slice(0, MAX_FRAMES);
        for (const frameUrl of frames) {
          try {
            const got = await safeFetch(frameUrl, null, {
              timeoutMs: FRAME_TIMEOUT_MS,
              headers: { referer: url }
            });
            if (!got.res.ok || !readable(got.res)) { drop(got.res); continue; }
            const inner = deobfuscate(await readCapped(got.res));
            extract(inner, got.url).media.forEach((x) => {
              media.push({ url: x.url, label: x.label, from: got.url });
            });
          } catch (e) {
            /* One frame that will not open is not the end of the walk. */
          }
          if (media.length) break;
        }
      }
    }
  } catch (e) {
    media = [];
  }

  cacheSet('page:' + pageUrl, media);
  return media;
}

/* ---------- The deep re-issue ----------
 *
 * rescan() above re-reads the page's HTML. That is the cheap answer and it
 * is often enough, but it cannot help the pages this app exists for: a
 * player that builds its source in JavaScript leaves no address in the
 * HTML to re-read, which is the entire reason /api/scan runs a browser.
 *
 * So run one here too. Not for novelty — for cost. A network-signed
 * address is only ever valid for the box that asked for it, so an address
 * minted on the Vercel function is an address this VPS may not fetch, and
 * the only two ways out of that are to send the film through Vercel (which
 * bills every byte twice and is the reason this box exists) or to mint the
 * address here. This mints it here.
 *
 * Off unless CHROME_EXECUTABLE_PATH names a browser, which is how the
 * serverless deploy opts out: there, the address was already minted by the
 * host that is fetching it, so there is nothing to re-issue and a cold
 * chromium inside a request a television is waiting on would be pure loss.
 */

/* Long enough for a slow player to build its source, short enough to lose
   to the receiver's own patience rather than hold a socket open past it.
   api/scan.js gives its own budget 45s; this one runs inside somebody's
   fetch, so it is tighter. */
const DEEP_BUDGET_MS = 35000;

/* A phone-shaped, non-headless-looking agent, matching what api/scan.js
   presents. A player that refuses an automated browser refuses it here for
   exactly the same reasons. */
const DEEP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/* Scans in flight, by page.
 *
 * Without this, the burst that arrives when an HLS playlist is refused —
 * every segment, at once, each one entering the retry independently —
 * launches one Chromium per segment. Sharing the promise makes a film cost
 * one browser, and it has to be a SEPARATE map from the memo above: the
 * memo only holds an answer, and the whole window being closed here is the
 * one before the first answer exists. */
const deepInFlight = new Map();

function deepAvailable() {
  return Boolean(String(process.env.CHROME_EXECUTABLE_PATH || '').trim());
}

async function runDeepScan(pageUrl) {
  /* Required here rather than at the top of the file so that a host with
     no browser never loads puppeteer at all. */
  const scan = require('../api/scan.js');

  let browser = null;
  let media = [];
  const budget = setTimeout(() => {
    if (browser) browser.close().catch(() => {});
  }, DEEP_BUDGET_MS);

  try {
    browser = await scan.launch();
    const page = await browser.newPage();

    /* A poked play control opens ad tabs, and a background page goes on
       requesting for the rest of the budget. Same guard api/scan.js uses. */
    browser.on('targetcreated', async (t) => {
      try {
        if (t.type() !== 'page') return;
        const opened = await t.page();
        if (opened && opened !== page) await opened.close().catch(() => {});
      } catch (e) { /* it closed itself first */ }
    });

    /* Which document each address was requested from.
     *
     * The referer is not a detail: these hosts check it, and handing the
     * CDN the blog's address instead of the embed's is a 403 on a link
     * issued a second earlier. api/scan.js does not report it because the
     * phone does not need it — the phone plays through /api/stream, which
     * is what does need it. Read from the frame tree here rather than
     * changing collect(), so the scan the app runs stays byte-identical. */
    const from = new Map();
    page.on('request', (r) => {
      try {
        const f = r.frame();
        const u = f && f.url();
        if (u && /^https?:\/\//i.test(u)) from.set(r.url(), u);
      } catch (e) { /* a frame that detached mid-request */ }
    });

    await page.setUserAgent(DEEP_UA);
    const result = await scan.collect(page, pageUrl);
    media = (result.media || []).map((x) => ({
      url: x.url,
      label: x.label,
      /* An address the page never requested — one read out of the player's
         own variables — has no frame to name, and the page it was found on
         is the closest honest answer. */
      from: from.get(x.url) || pageUrl
    }));
  } catch (e) {
    media = [];
  } finally {
    clearTimeout(budget);
    if (browser) { try { await browser.close(); } catch (e) { /* gone */ } }
  }

  return media;
}

/* Everything a real browser sees the page fetch, memoised like rescan()
   and single-flighted unlike it. */
async function deepRescan(pageUrl) {
  if (!deepAvailable()) return [];

  const key = 'deep:' + pageUrl;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  const running = deepInFlight.get(pageUrl);
  if (running) return running;

  const job = runDeepScan(pageUrl).then((media) => {
    /* Cached even when empty. A page a browser could not resolve will not
       resolve on the next segment either, and re-proving that costs
       another thirty seconds of the viewer's evening. */
    cacheSet(key, media);
    return media;
  });

  deepInFlight.set(pageUrl, job);
  try {
    return await job;
  } finally {
    deepInFlight.delete(pageUrl);
  }
}

/* Which of the addresses a scan turned up is the one that just failed.
 *
 * Shared by both re-issues so they cannot disagree about it — and the
 * refusals are the important half: a page is a stranger's, and the only
 * thing either re-issue may do is re-sign the host that already refused
 * us. Anywhere else and this would be a redirector pointing a television
 * at an address of the page's choosing. */
function choose(media, failedUrl, label) {
  if (!media || !media.length) return null;

  const wanted = String(label || '').trim().toLowerCase();
  const byLabel = wanted
    ? media.find((x) => String(x.label || '').trim().toLowerCase() === wanted)
    : null;

  const pick =
    byLabel ||
    media.find((x) => sameShape(x.url, failedUrl)) ||
    media.find((x) => sameSite(x.url, failedUrl));

  if (!pick) return null;
  if (!sameSite(pick.url, failedUrl)) return null;
  if (pick.url === failedUrl) return null;
  return { url: pick.url, referer: pick.from || null };
}

/* A working address for the same thing, and the referer to fetch it with,
 * or null.
 *
 * `label` is the quality the viewer chose. Without it the qualities are
 * indistinguishable — they share a filename and differ only inside the
 * signature — so a missing label means the best that can be done is the
 * first one of that shape, and handing back 192p when 720p was asked for
 * is still better than handing back a refusal. */
async function reissue(pageUrl, failedUrl, label) {
  if (!pageUrl || !failedUrl) return null;
  if (!/^https?:\/\//i.test(pageUrl)) return null;
  /* The page and the media on the same host means the address was not
     issued by an embed at all, and re-reading the page would just find
     the address that has already been refused. */
  if (sameHost(pageUrl, failedUrl)) return null;

  const got = choose(await rescan(pageUrl), failedUrl, label);
  if (!got) return null;
  return { url: got.url, referer: got.referer || pageUrl };
}

/* The same question, asked of a browser instead of the HTML.
 *
 * Second, never first: it costs a Chromium and up to thirty-five seconds,
 * against a page fetch and a few frames. It is the one that works on the
 * pages this app was built for, though, so a refusal is only really a
 * refusal once this has also said no.
 *
 * Same shape and the same guards as reissue() — the picking is literally
 * the same function — so nothing a page returns can point a television
 * anywhere but the host that already refused us. */
async function deepReissue(pageUrl, failedUrl, label) {
  if (!pageUrl || !failedUrl) return null;
  if (!/^https?:\/\//i.test(pageUrl)) return null;
  if (!deepAvailable()) return null;
  if (sameHost(pageUrl, failedUrl)) return null;

  const got = choose(await deepRescan(pageUrl), failedUrl, label);
  if (!got) return null;
  return { url: got.url, referer: got.referer || pageUrl };
}

module.exports = {
  reissue, deepReissue, rescan, deepRescan, deepAvailable,
  choose, sameShape, sameHost, sameSite, _cache: cache, _inFlight: deepInFlight
};
