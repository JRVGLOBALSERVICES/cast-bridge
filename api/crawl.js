/* GET /api/crawl?url=<page>
 *
 * The children of a page: the episodes on a season, the seasons on a series.
 * It returns ADDRESSES, never streams — picking one hands it to /api/extract
 * and the scanner does what it has always done. That split is the whole
 * design, and it is why this file is small.
 *
 * ---------------------------------------------------------------------------
 * The one hop, and why it is exactly one
 *
 * Measured against the page this was built for — a Bigg Boss season index —
 * the delivered HTML contains no episode links at all. What it contains is a
 * link to `/season/bigg-boss-20/`, and THAT page carries the episodes. So a
 * crawler that read one page and stopped would report "nothing here" about a
 * page two clicks from the answer.
 *
 * So: when a page yields no episodes but a small number of season pages that
 * are named after it, those are read too. Small is the operative word. A
 * series with twenty seasons is twenty fetches inside one request a phone is
 * waiting on, and the right answer there is not to be clever — it is to hand
 * back the twenty seasons and let a person point at one. The follow only
 * happens at FOLLOW_MAX or fewer.
 *
 * Nothing here is authenticated to the site being read. This reads public
 * pages exactly as a browser would, at the same rate a person tapping would,
 * and it does not log in, submit anything, or touch a page it was not given.
 */

const {
  safeFetch, readCapped, walledService, walledMessage, botWallPhrase
} = require('../lib/media');
const { findChildren } = require('../lib/crawl');
const auth = require('../lib/auth');

/* How many season pages may be read to answer for one crawl. Three is two
   more than the case that motivated this and still bounded well inside the
   function's own time limit. */
const FOLLOW_MAX = 3;
/* The whole request, including the follows. Kept under the function's
   maxDuration so a slow site ends in an explanation rather than a timeout. */
const BUDGET_MS = 24000;

const ACCEPT = 'text/html,application/xhtml+xml';

function fail(res, status, error, extra) {
  res.statusCode = status;
  res.end(JSON.stringify(Object.assign({ ok: false, error }, extra || {})));
}

async function readPage(target, deadline) {
  const left = deadline - Date.now();
  if (left <= 1500) throw new Error('That page took too long to read.');

  const { res, url } = await safeFetch(target, ACCEPT, { timeoutMs: Math.min(left, 12000) });
  if (!res.ok) {
    const e = new Error('That page answered ' + res.status + '.');
    e.status = res.status;
    throw e;
  }

  const type = (res.headers.get('content-type') || '').toLowerCase();
  /* A crawl of a .mp4 would read three megabytes of video as if it were
     markup. The scanner is the thing that handles a media address. */
  if (type && !/text\/html|application\/xhtml|text\/plain/.test(type)) {
    const e = new Error('That address is a file, not a page — paste it in the Link box instead.');
    e.status = 415;
    throw e;
  }

  return { html: await readCapped(res), finalUrl: url };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    fail(res, 405, 'Use GET.');
    return;
  }

  const user = await auth.guard(req, res);
  if (!user) return;

  const raw = (req.query && req.query.url) ||
    new URL(req.url, 'http://localhost').searchParams.get('url');

  if (!raw) {
    fail(res, 400, 'No page address given.');
    return;
  }

  let target = String(raw).trim();
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;

  /* A service that will not be read at all is answered before a fetch is
     spent on it, in the same shape the scanner uses so the screen can say
     the same thing either way. */
  const walled = walledService(target);
  if (walled) {
    res.statusCode = 200;
    res.end(JSON.stringify({
      ok: false, walled: walled.why, service: walled.name, error: walledMessage(walled)
    }));
    return;
  }

  const deadline = Date.now() + BUDGET_MS;

  let first;
  try {
    first = await readPage(target, deadline);
  } catch (e) {
    fail(res, e.status && e.status < 500 ? 400 : 502,
      (e && e.message) || "That page couldn't be read.");
    return;
  }

  /* A wall reads as an empty page, and "no episodes found" would be the
     wrong sentence about it — the page was never shown to us. */
  const wall = botWallPhrase(first.html);
  if (wall) {
    res.statusCode = 200;
    res.end(JSON.stringify({
      ok: false, botWall: true, phrase: wall,
      error: 'That site is asking us to prove we are a browser, so its list never loaded.'
    }));
    return;
  }

  const found = findChildren(first.html, first.finalUrl);
  const followed = [];

  /* No episodes, but a short list of seasons that belong to this page. Read
     them — this is the case the whole hop exists for. */
  if (!found.episodes.length && found.seasons.length && found.seasons.length <= FOLLOW_MAX) {
    for (const season of found.seasons) {
      if (Date.now() > deadline - 2000) break;
      try {
        const page = await readPage(season.url, deadline);
        const deeper = findChildren(page.html, page.finalUrl);
        if (!deeper.episodes.length) continue;
        followed.push({ url: season.url, title: season.title || deeper.title, count: deeper.episodes.length });
        for (const ep of deeper.episodes) {
          /* Carry the season's own number down. An episode page that only
             says "Episode 1" in its slug has no season in it, and a merged
             list of three seasons all numbered 1..N would sort into
             nonsense without this. */
          if (ep.season === null && season.season !== null) ep.season = season.season;
          found.episodes.push(ep);
        }
      } catch (e) { /* one unreadable season must not lose the others */ }
    }

    if (followed.length) {
      const seen = new Set();
      found.episodes = found.episodes.filter((e) => {
        if (seen.has(e.url)) return false;
        seen.add(e.url);
        return true;
      });
      found.via = 'followed';
    }
  }

  res.statusCode = 200;
  res.end(JSON.stringify({
    ok: true,
    url: target,
    finalUrl: first.finalUrl,
    title: found.title || '',
    host: (() => { try { return new URL(first.finalUrl).host.replace(/^www\./, ''); } catch (e) { return ''; } })(),
    /* `via` is reported rather than hidden because it changes how much the
       list should be trusted: 'words' read the addresses, 'shape' guessed
       from a repeating pattern, 'followed' had to open a season page to get
       there. The screen says which. */
    via: found.via,
    episodes: found.episodes,
    seasons: found.seasons,
    followed
  }));
};
