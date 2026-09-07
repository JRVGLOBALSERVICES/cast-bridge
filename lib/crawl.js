/* Finding the children of a page.
 *
 * The problem this solves, in the words it was given in: "if I put a season
 * page in, it should find the child pages, and if I pick episode 2 it finds
 * the links for it, so I don't need to keep finding and pasting links."
 *
 * That is a different job from /api/extract, which reads ONE page and reports
 * the media on it. This reads one page and reports the OTHER PAGES on it —
 * and then the existing scanner does the rest, unchanged. A crawl produces
 * addresses, never streams.
 *
 * ---------------------------------------------------------------------------
 * Why it is not a list of site rules
 *
 * The obvious implementation is a table of selectors per site, and it rots
 * the week after it is written. Three signals are used instead, all of them
 * true of pages in general rather than of one theme:
 *
 *   1. THE WORDS. `/episode/`, `-episode-4`, `S02E07`, `4x12`, `Episode 4`.
 *      Strong, and enough on its own — these appear in the address or the
 *      link text on nearly every series page in existence.
 *   2. THE SHAPE. Replace every run of digits in a path with `#`. Every link
 *      in a real listing collapses to one shape, and the shape with the most
 *      members is the listing. This is what carries a site that never writes
 *      the word "episode" anywhere.
 *   3. THE PARENT. A child usually lives under, or beside, the address it was
 *      linked from. A link that shares the parent's first path segment beats
 *      one that does not.
 *
 * ---------------------------------------------------------------------------
 * Why "seasons" is a separate answer, and not just more episodes
 *
 * Measured on the page this was built against — a Bigg Boss season index —
 * the delivered HTML contains NO episode links at all. What it contains is a
 * link to a season page, and the episode rows are fetched afterwards by the
 * theme's own script. A crawler that reported "nothing found" there would be
 * telling the truth about the wrong page.
 *
 * So the two are answered separately. Episodes are things to play. Seasons
 * are things to open — one more hop, taken by the handler, at a page the
 * person can also see and choose from. A series with twenty seasons must
 * never be twenty automatic fetches.
 */

/* Words that appear on every page of every one of these sites and so
   distinguish nothing. Without this list "season" and "episode" would make
   every show on the site a relative of every other. */
const NOISE_WORDS = new Set([
  'season', 'seasons', 'episode', 'episodes', 'ep', 'part', 'series', 'serie',
  'show', 'watch', 'online', 'free', 'full', 'hd', 'movie', 'movies', 'tv',
  'the', 'and', 'for', 'with', 'download', 'video', 'stream', 'play', 'new'
]);

/* The words in a name, minus the ones every name has. Digits are kept and
   they matter: `bigg-boss-20` and `bigg-boss-season-20-episode-1` share the
   20, and that is often the only thing separating one season from the next. */
function tokensOf(text) {
  const out = new Set();
  for (const word of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (!word || word.length < 2) continue;
    if (NOISE_WORDS.has(word)) continue;
    out.add(word);
  }
  return out;
}

function lastSegment(pathname) {
  const parts = String(pathname).split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/* How many words a candidate shares with the page it was found on.
 *
 * This is the signal that was missing, and the page it was missing on is the
 * one this was built against: a season index carries a sidebar rail of a
 * dozen OTHER shows, every one of them a perfectly good "season" link by
 * path and by label. Seventeen answers, one of them right. What separates
 * them is that the right one is called after the same show — `bigg-boss-20`
 * beside a page titled "Bigg Boss Season 20" — and the rail is not.
 */
function kinship(pageTokens, row) {
  if (!pageTokens.size) return 0;
  let shared = 0;
  let candidate;
  try { candidate = new URL(row.url); } catch (e) { return 0; }
  const words = tokensOf(lastSegment(candidate.pathname) + ' ' + (row.title || ''));
  for (const word of words) if (pageTokens.has(word)) shared += 1;
  return shared;
}

/* Anchors, with the text people actually read. `[^>]*` on either side of the
   href is what catches the ordinary case of class, rel and target attributes
   sitting around it; the text is flattened because a link's label is very
   often wrapped in a span or an <i> icon. */
const ANCHOR = /<a\b([^>]*)href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))([^>]*)>([\s\S]*?)<\/a>/gi;

/* Never a child page. Feeds, logins, taxonomy listings and the comment
   permalinks WordPress puts on every page — all of them share a host with
   the real answer, which is exactly why "same host" is not a filter by
   itself. */
const NOT_A_CHILD = new RegExp([
  '/(?:wp-login|wp-admin|wp-json|xmlrpc)',
  '/feed/?$',
  '\\?replytocom=',
  '/(?:tag|tags|category|categories|genre|genres|letter|author|actor|director' +
    '|cast|country|network|studio|year|search|login|register|signup|account' +
    '|profile|contact|privacy|terms|dmca|about|request)(?:/|$)',
  /* A colon inside a path segment is a wiki namespace — Talk:, Special:,
     Category:, File:, Template:. Every one of them is a page ABOUT a page,
     and on a "List of … episodes" article they all carry the article's own
     slug, so nothing else in this file would have told them apart. */
  '/[^/]*:[^/]'
].join('|'), 'i');

/* A file, not a page. A crawl that returns an .mp4 has skipped the scanner
   that knows how to check one. */
const NOT_A_PAGE = /\.(jpe?g|png|gif|webp|svg|ico|css|js|json|xml|txt|zip|rar|pdf|mp4|m4v|mkv|webm|mp3|m4a|torrent)(\?|#|$)/i;

/* Singular only. `/episodes/` and `list-of-x-episodes` are the INDEX of a
   season, not one to play — treating the plural as a leaf is what made a
   Wikipedia "List of … episodes" page report its own Talk page as episode 4. */
const EPISODE_PATH = /(^|[\/_-])(episode|ep|watch|video|play)([\/_-]|\d|$)/i;
/* The lookbehind is load-bearing. Without it the bare `e` alternative matches
   the last letter of any word that happens to be followed by a number —
   measured, on `…ShareAlike_4.0_International_License`, which came back as
   "Episode 4". */
const EPISODE_NUMBERED = /(?<![a-z0-9])(episode|ep|part|e)[\s._-]*(\d{1,4})(?!\d)/i;
const SEASON_EPISODE = /\bs(?:eason)?[\s._-]*(\d{1,3})[\s._-]*(?:e|ep|episode|x)[\s._-]*(\d{1,4})\b/i;
const CROSS = /\b(\d{1,3})\s*x\s*(\d{1,4})\b/i;
const SEASON_PATH = /(^|[\/_-])(seasons?|series|show|s\d{1,3})([\/_-]|$)/i;
const SEASON_NUMBERED = /(?<![a-z0-9])(season|s)[\s._-]*(\d{1,3})(?!\d)/i;

/* How many children one page may ever produce. A crawl that returns four
   thousand rows has found a sitemap, not a season. */
const MAX_CHILDREN = 400;
/* Links read off one page before the reader stops. A page with more anchors
   than this is a directory, and the answer is not further down it. */
const MAX_ANCHORS = 4000;

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function textOf(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/* Trailing slash and fragment removed so `/episode/x`, `/episode/x/` and
   `/episode/x/#respond` are one address rather than three rows of the same
   episode. The query is kept — plenty of sites carry the episode in it. */
function canonical(u) {
  try {
    const url = new URL(u);
    url.hash = '';
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch (e) {
    return null;
  }
}

/* Digits out, structure left. `/episode/bigg-boss-season-20-episode-7/` and
   `/episode/bigg-boss-season-20-episode-8/` are the same shape; the site's
   About page is not. */
function shapeOf(u) {
  try {
    const url = new URL(u);
    return url.host + url.pathname.replace(/\d+/g, '#');
  } catch (e) {
    return '';
  }
}

function firstSegment(pathname) {
  const parts = String(pathname).split('/').filter(Boolean);
  return parts.length ? parts[0].toLowerCase() : '';
}

/* The episode's number, and its season's if the address or the label carries
   one. Order matters: S02E07 and 2x07 both name a season and an episode, and
   reading the bare-number rule first would take the season as the episode. */
function numbersFrom(haystack) {
  let m = SEASON_EPISODE.exec(haystack);
  if (m) return { season: parseInt(m[1], 10), num: parseInt(m[2], 10) };

  m = CROSS.exec(haystack);
  if (m) return { season: parseInt(m[1], 10), num: parseInt(m[2], 10) };

  const out = {};
  m = SEASON_NUMBERED.exec(haystack);
  if (m) out.season = parseInt(m[2], 10);

  m = EPISODE_NUMBERED.exec(haystack);
  if (m) out.num = parseInt(m[2], 10);

  return out;
}

/* Everything the page links to, once each, with the label it was given. */
function readLinks(html, pageUrl) {
  const seen = new Map();
  const src = String(html || '');
  let m;
  let count = 0;

  ANCHOR.lastIndex = 0;
  while ((m = ANCHOR.exec(src)) !== null) {
    if (++count > MAX_ANCHORS) break;

    const raw = decodeEntities(m[3] || m[4] || m[5] || '').trim();
    if (!raw || /^(#|javascript:|mailto:|tel:|data:)/i.test(raw)) continue;

    let abs;
    try { abs = canonical(new URL(raw, pageUrl).toString()); } catch (e) { continue; }
    if (!abs || !/^https?:/i.test(abs)) continue;

    const label = textOf(m[7]);
    const prev = seen.get(abs);
    /* A page links to the same episode from the poster and from the title.
       The poster's anchor wraps an <img> and reads as empty, so the labelled
       one wins wherever both exist. */
    if (prev) {
      if (!prev.label && label) prev.label = label;
      prev.count += 1;
      continue;
    }
    seen.set(abs, { url: abs, label, count: 1 });
  }

  return Array.from(seen.values());
}

/* The page's own name, for the row that remembers it. An <h1> beats the
   <title>, which on these sites is padded with the site name and a sentence
   of keywords. */
function titleOf(html) {
  const h1 = /<h1[^>]*>([\s\S]{0,300}?)<\/h1>/i.exec(String(html || ''));
  if (h1) {
    const t = textOf(h1[1]);
    if (t) return t.slice(0, 200);
  }
  const t = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(String(html || ''));
  return t ? textOf(t[1]).slice(0, 200) : '';
}

/* The whole judgement, for one link. Returns a score and what it looks like.
   Kept as one function on purpose: the alternative is the same conditions
   restated in three places and drifting apart. */
function judge(link, page) {
  let target;
  try { target = new URL(link.url); } catch (e) { return null; }

  if (target.host !== page.host) return null;                 // never leave the site
  if (link.url === page.href) return null;                    // the page itself
  if (NOT_A_PAGE.test(target.pathname)) return null;
  if (NOT_A_CHILD.test(target.pathname)) return null;
  if (target.pathname === '/' || target.pathname === '') return null;

  const path = target.pathname + target.search;
  const label = link.label || '';
  const both = path + ' ' + label;

  let score = 0;
  let kind = '';

  if (EPISODE_PATH.test(path)) { score += 6; kind = 'episode'; }
  if (SEASON_EPISODE.test(both) || CROSS.test(both)) { score += 5; kind = 'episode'; }
  if (EPISODE_NUMBERED.test(both)) { score += 4; if (!kind) kind = 'episode'; }
  /* A label that is nothing but a number is the commonest episode link
     there is — a row of 1 2 3 4 under a poster. */
  if (/^\d{1,4}$/.test(label.trim())) { score += 3; if (!kind) kind = 'episode'; }

  if (!kind && SEASON_PATH.test(path)) { score += 4; kind = 'season'; }
  if (!kind && SEASON_NUMBERED.test(both) && /season/i.test(both)) { score += 3; kind = 'season'; }

  /* Sitting under the same first path segment as the page it was found on.
     Weak alone, decisive as a tie-break between two same-shaped groups. */
  if (firstSegment(target.pathname) === firstSegment(page.pathname)) score += 2;

  if (!kind) return null;

  const n = numbersFrom(both);
  return {
    url: link.url,
    title: label || null,
    kind,
    score,
    num: typeof n.num === 'number' ? n.num : null,
    season: typeof n.season === 'number' ? n.season : null,
    shape: shapeOf(link.url)
  };
}

/* Ascending by season, then by episode, and anything unnumbered last in the
   order the page listed it. A list that opens at episode 1 is the one thing
   every one of these sites gets wrong. */
function order(rows) {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const A = a.r;
      const B = b.r;
      const as = A.season === null ? Infinity : A.season;
      const bs = B.season === null ? Infinity : B.season;
      if (as !== bs) return as - bs;
      const an = A.num === null ? Infinity : A.num;
      const bn = B.num === null ? Infinity : B.num;
      if (an !== bn) return an - bn;
      return a.i - b.i;
    })
    .map((x) => x.r);
}

/* The shape rule. Only consulted when the words found nothing, because on a
   page where both apply the words are the better answer — the largest
   same-shaped group on a film site is very often its "you may also like"
   rail, which is a real listing of the wrong thing. */
function byShape(links, page) {
  const groups = new Map();

  for (const link of links) {
    let target;
    try { target = new URL(link.url); } catch (e) { continue; }
    if (target.host !== page.host) continue;
    if (link.url === page.href) continue;
    if (NOT_A_PAGE.test(target.pathname)) continue;
    if (NOT_A_CHILD.test(target.pathname)) continue;
    if (target.pathname === '/' || target.pathname === '') continue;
    /* No digit anywhere means nothing distinguishes one member of the group
       from another, which is a navigation bar, not a listing. */
    if (!/\d/.test(target.pathname + target.search)) continue;

    const shape = shapeOf(link.url);
    if (!groups.has(shape)) groups.set(shape, []);
    groups.get(shape).push(link);
  }

  let best = null;
  for (const [shape, members] of groups) {
    if (members.length < 3) continue;
    const sameSegment = firstSegment(new URL(members[0].url).pathname) === firstSegment(page.pathname);
    const weight = members.length + (sameSegment ? 5 : 0);
    if (!best || weight > best.weight) best = { shape, members, weight };
  }
  if (!best) return [];

  return best.members.map((link) => {
    const n = numbersFrom(new URL(link.url).pathname + ' ' + (link.label || ''));
    return {
      url: link.url,
      title: link.label || null,
      kind: 'episode',
      score: 1,
      num: typeof n.num === 'number' ? n.num : null,
      season: typeof n.season === 'number' ? n.season : null,
      shape: best.shape
    };
  });
}

/* Keep the children named after this page, if any of them are.
 *
 * Judged across BOTH lists at once rather than within each, and that is the
 * whole subtlety. Measured on a Wikipedia "List of Breaking Bad episodes"
 * article: its season links are named after the page and its navbox links
 * are a different programme entirely. Per-list, the episode list contained
 * nothing with kinship, so the fallback kept all of it and the page reported
 * six Better Call Saul seasons as Breaking Bad episodes. Across both lists,
 * something IS named after the page — so anything that is not is a different
 * show, wherever it happened to be filed.
 *
 * The fallback survives: when nothing anywhere is named after the page —
 * a site with opaque numeric slugs — both lists are left exactly as they
 * were, because narrowing to nothing is worse than a noisy answer.
 */
function preferKin(lists) {
  const anyKin = lists.some((rows) => rows.some((r) => r.kin > 0));
  if (!anyKin) return lists;
  return lists.map((rows) => rows.filter((r) => r.kin > 0));
}

/* HTML in, children out.
 *
 * `episodes` are pages to play. `seasons` are pages to open — the handler
 * takes at most one more hop, and only when there are no episodes, because
 * a series with twenty seasons must not become twenty fetches.
 */
function findChildren(html, pageUrl) {
  let page;
  try { page = new URL(pageUrl); } catch (e) {
    return { title: '', episodes: [], seasons: [], via: 'none' };
  }

  const links = readLinks(html, page.toString());
  const pageTitle = titleOf(html);
  /* What this page is called, in words. Both sources are used because
     either one alone is regularly useless: a <title> can be pure keyword
     padding, and a slug can be `/watch/90210`. */
  const pageTokens = tokensOf(pageTitle + ' ' + lastSegment(page.pathname));

  const judged = [];
  for (const link of links) {
    const row = judge(link, page);
    if (!row) continue;
    row.kin = kinship(pageTokens, row);
    if (row.kin) row.score += 4;
    judged.push(row);
  }

  let episodes = judged.filter((r) => r.kind === 'episode');
  let seasons = judged.filter((r) => r.kind === 'season');
  let via = 'words';

  /* The shape fallback runs BEFORE the narrowing below, not after it.
     Ordered the other way round it silently undoes it: the narrowing empties
     a list of unrelated rows, the emptiness is read as "the words found
     nothing", and the shape rule puts the very same rows back — measured,
     on a Wikipedia episode list, where six seasons of a different programme
     came back that way. */
  if (!episodes.length) {
    episodes = byShape(links, page).map((row) => {
      row.kin = kinship(pageTokens, row);
      return row;
    });
    via = episodes.length ? 'shape' : 'none';
  }

  /* Related-content rails are the failure mode both lists share, and one
     rule clears both: once ANY child anywhere is named after this page, the
     ones that are not are a different show. Applied only when there is
     something to prefer, so a site with opaque numeric slugs — where
     nothing has kinship and nothing can — is left exactly as it was. */
  const narrowed = preferKin([episodes, seasons]);
  episodes = narrowed[0];
  seasons = narrowed[1];
  if (!episodes.length && via === 'shape') via = 'none';

  /* Two links to the same address, one scored by its path and one by its
     label, are one episode. The higher score keeps its numbers. */
  const best = new Map();
  for (const row of episodes) {
    const prev = best.get(row.url);
    if (!prev || row.score > prev.score) best.set(row.url, row);
  }

  const seasonBest = new Map();
  for (const row of seasons) {
    if (best.has(row.url)) continue;   // an episode is never also a season
    const prev = seasonBest.get(row.url);
    if (!prev || row.score > prev.score) seasonBest.set(row.url, row);
  }

  return {
    title: titleOf(html),
    episodes: order(Array.from(best.values())).slice(0, MAX_CHILDREN),
    seasons: order(Array.from(seasonBest.values())).slice(0, 60),
    via
  };
}

module.exports = {
  findChildren, readLinks, judge, byShape, order, preferKin,
  canonical, shapeOf, numbersFrom, titleOf, tokensOf, kinship, lastSegment,
  MAX_CHILDREN, MAX_ANCHORS
};
