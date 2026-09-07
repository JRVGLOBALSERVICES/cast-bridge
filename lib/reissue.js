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
    if (x.hostname !== y.hostname) return false;
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

  const media = await rescan(pageUrl);
  if (!media.length) return null;

  const wanted = String(label || '').trim().toLowerCase();
  const byLabel = wanted
    ? media.find((x) => String(x.label || '').trim().toLowerCase() === wanted)
    : null;

  const pick =
    byLabel ||
    media.find((x) => sameShape(x.url, failedUrl)) ||
    media.find((x) => sameHost(x.url, failedUrl));

  if (!pick) return null;
  /* Never hand the television an address somewhere else. The page is a
     stranger's; the only thing this is allowed to do is re-sign the host
     that already refused us. */
  if (!sameHost(pick.url, failedUrl)) return null;
  if (pick.url === failedUrl) return null;
  return { url: pick.url, referer: pick.from || pageUrl };
}

module.exports = { reissue, rescan, sameShape, sameHost, _cache: cache };
