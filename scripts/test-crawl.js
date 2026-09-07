#!/usr/bin/env node
/* Proof for the child-page finder in lib/crawl.js.
 *
 * The case that produced it is in scripts/fixtures/toroflix-season.html —
 * a real, trimmed season page from the site Rj pasted. Everything else here
 * is synthetic and deliberately so: the point of this module is that it
 * knows nothing about any particular site, and a suite made only of one
 * site's HTML would prove the opposite.
 *
 *   node scripts/test-crawl.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crawl = require('../lib/crawl');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok   ' + name);
  } catch (err) {
    failures.push(name + ' — ' + err.message);
    console.log('  FAIL ' + name + ' — ' + err.message);
  }
}

function page(links, opts) {
  opts = opts || {};
  const body = links.map((l) => {
    const label = l[1] === undefined ? '' : l[1];
    return '<a href="' + l[0] + '">' + label + '</a>';
  }).join('\n');
  return '<html><head><title>' + (opts.title || 'A Show') + '</title></head><body>' +
    (opts.h1 ? '<h1>' + opts.h1 + '</h1>' : '') + body + '</body></html>';
}

const urls = (r) => r.episodes.map((e) => e.url);

/* ---------- the real page ---------- */

const TOROFLIX = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'toroflix-season.html'), 'utf8');

check('the real season page yields its episode, numbered and named', () => {
  const r = crawl.findChildren(TOROFLIX, 'https://www.desicinema.org/season/bigg-boss-20/');
  assert.strictEqual(r.episodes.length, 1);
  const ep = r.episodes[0];
  assert.strictEqual(ep.url, 'https://www.desicinema.org/episode/bigg-boss-season-20-episode-1');
  assert.strictEqual(ep.num, 1);
  assert.strictEqual(ep.season, 20);
  assert.strictEqual(r.via, 'words');
  assert.ok(ep.title && ep.title.length > 3, 'the episode arrived without a name');
});

check('the real page reports no seasons — it IS a season', () => {
  const r = crawl.findChildren(TOROFLIX, 'https://www.desicinema.org/season/bigg-boss-20/');
  assert.strictEqual(r.seasons.length, 0);
});

/* ---------- ordinary listings ---------- */

const SEASON = page([
  ['/episode/the-show-season-2-episode-3', 'Episode 3'],
  ['/episode/the-show-season-2-episode-1', 'Episode 1'],
  ['/episode/the-show-season-2-episode-2', 'Episode 2']
], { title: 'The Show Season 2', h1: 'The Show Season 2' });

check('episodes come back in order, however the page listed them', () => {
  const r = crawl.findChildren(SEASON, 'https://x.test/season/the-show-2');
  assert.deepStrictEqual(r.episodes.map((e) => e.num), [1, 2, 3]);
});

check('the season number is read from the address, not assumed', () => {
  const r = crawl.findChildren(SEASON, 'https://x.test/season/the-show-2');
  r.episodes.forEach((e) => assert.strictEqual(e.season, 2));
});

check('S02E07 is a season and an episode, in that order', () => {
  assert.deepStrictEqual(crawl.numbersFrom('the-show-s02e07'), { season: 2, num: 7 });
  assert.deepStrictEqual(crawl.numbersFrom('The Show S2 E7'), { season: 2, num: 7 });
});

check('2x07 is read the same way', () => {
  assert.deepStrictEqual(crawl.numbersFrom('The Show 2x07'), { season: 2, num: 7 });
});

check('a bare "Episode 12" label carries the number when the slug will not', () => {
  const r = crawl.findChildren(page([
    ['/watch/90210', 'Episode 12'],
    ['/watch/90211', 'Episode 13']
  ], { title: 'A Show' }), 'https://x.test/series/a-show');
  assert.deepStrictEqual(r.episodes.map((e) => e.num), [12, 13]);
});

check('a row of bare numbers under a poster is an episode list', () => {
  const r = crawl.findChildren(page([
    ['/e/a-show-1', '1'], ['/e/a-show-2', '2'], ['/e/a-show-3', '3']
  ], { title: 'A Show' }), 'https://x.test/series/a-show');
  assert.strictEqual(r.episodes.length, 3);
});

/* ---------- what must never come back ---------- */

check('another site is never a child, however episode-shaped its address', () => {
  const r = crawl.findChildren(page([
    ['https://elsewhere.test/episode/a-show-episode-1', 'Episode 1'],
    ['/episode/a-show-episode-2', 'Episode 2']
  ], { title: 'A Show' }), 'https://x.test/season/a-show');
  assert.deepStrictEqual(urls(r), ['https://x.test/episode/a-show-episode-2']);
});

check('a media file is not a page — that is the scanner\'s job, not this one', () => {
  const r = crawl.findChildren(page([
    ['/episode/a-show-episode-1.mp4', 'Episode 1'],
    ['/poster/a-show-episode-2.jpg', 'Episode 2'],
    ['/episode/a-show-episode-3', 'Episode 3']
  ], { title: 'A Show' }), 'https://x.test/season/a-show');
  assert.deepStrictEqual(urls(r), ['https://x.test/episode/a-show-episode-3']);
});

check('taxonomy, login and feed links are excluded', () => {
  /* This is the assertion that caught a real bug: the exclusion list was
     joined into one SEQUENCE rather than alternatives, so it matched
     nothing at all and every one of these came back as a child. */
  const r = crawl.findChildren(page([
    ['/category/drama-episode-1', 'Drama'],
    ['/tag/watch-episode-2', 'Tag'],
    ['/author/someone-episode-3', 'Author'],
    ['/letter/a-episode-4', 'A'],
    ['/wp-login.php?redirect_to=/episode/5', 'Log in'],
    ['/episode/a-show-episode-6', 'Episode 6']
  ], { title: 'A Show' }), 'https://x.test/season/a-show');
  assert.deepStrictEqual(urls(r), ['https://x.test/episode/a-show-episode-6']);
});

check('a page is never its own child', () => {
  const here = 'https://x.test/season/a-show-episode-1';
  const r = crawl.findChildren(page([
    [here, 'This page'], ['/episode/a-show-episode-2', 'Episode 2']
  ], { title: 'A Show' }), here);
  assert.deepStrictEqual(urls(r), ['https://x.test/episode/a-show-episode-2']);
});

check('the site root is not an episode', () => {
  const r = crawl.findChildren(page([
    ['/', 'Home'], ['/episode/a-show-episode-1', 'Episode 1']
  ], { title: 'A Show' }), 'https://x.test/season/a-show');
  assert.strictEqual(r.episodes.length, 1);
});

/* ---------- the same address, spelled four ways ---------- */

check('trailing slashes and fragments are one address, not four rows', () => {
  const r = crawl.findChildren(page([
    ['/episode/a-show-episode-1', 'Episode 1'],
    ['/episode/a-show-episode-1/', ''],
    ['/episode/a-show-episode-1/#respond', 'Comments'],
    ['/episode/a-show-episode-1#top', '']
  ], { title: 'A Show' }), 'https://x.test/season/a-show');
  assert.strictEqual(r.episodes.length, 1);
});

check('a poster link with no text takes the name from the titled link', () => {
  const r = crawl.findChildren(
    '<html><title>A Show</title><body>' +
    '<a href="/episode/a-show-episode-1"><img src="p.jpg"></a>' +
    '<a href="/episode/a-show-episode-1">The Grand Premiere</a></body></html>',
    'https://x.test/season/a-show');
  assert.strictEqual(r.episodes.length, 1);
  assert.strictEqual(r.episodes[0].title, 'The Grand Premiere');
});

check('single-quoted and unquoted hrefs are read, and relative ones resolved', () => {
  const r = crawl.findChildren(
    "<html><title>A Show</title><body>" +
    "<a href='/episode/a-show-episode-1'>One</a>" +
    "<a href=/episode/a-show-episode-2>Two</a>" +
    "<a href=\"episode/a-show-episode-3\">Three</a></body></html>",
    'https://x.test/season/a-show/');
  assert.deepStrictEqual(urls(r), [
    'https://x.test/episode/a-show-episode-1',
    'https://x.test/episode/a-show-episode-2',
    'https://x.test/season/a-show/episode/a-show-episode-3'
  ]);
});

check('entities in a label are decoded, not shown raw', () => {
  const r = crawl.findChildren(page([
    ['/episode/a-show-episode-1', 'Ep 1 &amp; 2 &#8212; &quot;Pilot&quot;']
  ], { title: 'A Show' }), 'https://x.test/season/a-show');
  assert.ok(r.episodes[0].title.includes('& 2'), r.episodes[0].title);
  assert.ok(!r.episodes[0].title.includes('&amp;'));
});

/* ---------- the related-content rail, which is the real failure mode ---------- */

check('a rail of other shows is dropped once this page has children of its own', () => {
  /* Measured on the real page before this rule existed: seventeen "seasons",
     sixteen of them different programmes from a sidebar. */
  const r = crawl.findChildren(page([
    ['/episode/bigg-boss-season-20-episode-1', 'Episode 1'],
    ['/episode/the-night-manager-season-2-episode-4', 'Episode 4'],
    ['/episode/undekhi-season-4-episode-2', 'Episode 2']
  ], { title: 'Bigg Boss Season 20', h1: 'Bigg Boss Season 20' }),
  'https://x.test/season/bigg-boss-20');
  assert.deepStrictEqual(urls(r), ['https://x.test/episode/bigg-boss-season-20-episode-1']);
});

check('a navbox for a different show is dropped even when it lands in the other list', () => {
  /* Measured on a real Wikipedia "List of Breaking Bad episodes" article:
     the season links are named after the page, the navbox links are a
     different programme, and they landed in different lists. Judged per
     list, the episode list had no kinship at all, the fallback kept every
     row of it, and the page reported six Better Call Saul seasons as
     Breaking Bad episodes. */
  const r = crawl.findChildren(page([
    ['/wiki/Breaking_Bad_season_1', 'Season 1'],
    ['/wiki/Breaking_Bad_season_2', 'Season 2'],
    ['/wiki/Better_Call_Saul_season_1', '1'],
    ['/wiki/Better_Call_Saul_season_2', '2'],
    ['/wiki/Better_Call_Saul_season_3', '3']
  ], { title: 'List of Breaking Bad episodes' }),
  'https://x.test/wiki/List_of_Breaking_Bad_episodes');
  assert.deepStrictEqual(r.episodes, [], 'a different show came back as episodes');
  assert.deepStrictEqual(r.seasons.map((s) => s.url), [
    'https://x.test/wiki/Breaking_Bad_season_1',
    'https://x.test/wiki/Breaking_Bad_season_2'
  ]);
});

check('a plural "episodes" is an index, not something to play', () => {
  /* `/episodes/` and `list-of-x-episodes` name a LISTING. Reading the plural
     as a leaf is what let a Wikipedia article's own boilerplate — Talk:,
     Special:, the licence link — come back as episodes of it. */
  const r = crawl.findChildren(page([
    ['/series/a-show/episodes', 'All episodes'],
    ['/episode/a-show-episode-1', 'Episode 1']
  ], { title: 'A Show' }), 'https://x.test/series/a-show');
  assert.deepStrictEqual(urls(r), ['https://x.test/episode/a-show-episode-1']);
});

check('a wiki namespace is a page ABOUT a page, never a child of it', () => {
  const r = crawl.findChildren(page([
    ['/wiki/Talk:List_of_A_Show_episodes', 'Talk'],
    ['/wiki/Special:WhatLinksHere/List_of_A_Show_episodes', 'What links here'],
    ['/wiki/Category:A_Show_episodes', 'Category'],
    ['/wiki/A_Show_episode_1', 'Episode 1']
  ], { title: 'List of A Show episodes' }), 'https://x.test/wiki/List_of_A_Show_episodes');
  assert.deepStrictEqual(urls(r), ['https://x.test/wiki/A_Show_episode_1']);
});

check('a bare "e" ending a word is not an episode number', () => {
  /* Measured: `…ShareAlike_4.0_International_License` came back as
     "Episode 4", because the `e` alternative matched the last letter of a
     word that happened to be followed by a number. */
  assert.deepStrictEqual(crawl.numbersFrom('Attribution-ShareAlike_4.0_License'), {});
  assert.deepStrictEqual(crawl.numbersFrom('a-show-e4'), { num: 4 });
  assert.deepStrictEqual(crawl.numbersFrom('a-show ep 4'), { num: 4 });
});

check('when nothing is named after the page, the list is not emptied instead', () => {
  /* A site with opaque numeric slugs can have no kinship at all, and
     narrowing to zero would turn a working crawl into "nothing found". */
  const r = crawl.findChildren(page([
    ['/watch/10021', 'Episode 1'],
    ['/watch/10022', 'Episode 2']
  ], { title: 'Untitled' }), 'https://x.test/s/44');
  assert.strictEqual(r.episodes.length, 2);
});

check('kinship counts shared words and ignores the ones every page has', () => {
  const tokens = crawl.tokensOf('Bigg Boss Season 20');
  assert.ok(tokens.has('bigg') && tokens.has('boss') && tokens.has('20'));
  assert.ok(!tokens.has('season'), '"season" distinguishes nothing and must not count');
});

/* ---------- seasons ---------- */

check('a series page hands back its seasons rather than pretending they play', () => {
  const r = crawl.findChildren(page([
    ['/season/a-show-1', 'Season 1'],
    ['/season/a-show-2', 'Season 2']
  ], { title: 'A Show', h1: 'A Show' }), 'https://x.test/series/a-show');
  assert.strictEqual(r.episodes.length, 0);
  assert.deepStrictEqual(r.seasons.map((s) => s.season), [1, 2]);
});

check('nothing is both an episode and a season', () => {
  const r = crawl.findChildren(page([
    ['/season/a-show-1/episode-1', 'Season 1 Episode 1']
  ], { title: 'A Show' }), 'https://x.test/series/a-show');
  const both = r.episodes.filter((e) => r.seasons.some((s) => s.url === e.url));
  assert.strictEqual(both.length, 0);
});

/* ---------- the shape fallback ---------- */

check('a site that never writes "episode" is read from the shape instead', () => {
  const r = crawl.findChildren(page([
    ['/v/show-101', 'One'], ['/v/show-102', 'Two'],
    ['/v/show-103', 'Three'], ['/v/show-104', 'Four']
  ], { title: 'Show' }), 'https://x.test/v/show');
  assert.strictEqual(r.via, 'shape');
  assert.strictEqual(r.episodes.length, 4);
});

check('a shape needs three members — two links are not a listing', () => {
  const r = crawl.findChildren(page([
    ['/v/show-101', 'One'], ['/v/show-102', 'Two']
  ], { title: 'Show' }), 'https://x.test/v/show');
  assert.strictEqual(r.via, 'none');
  assert.strictEqual(r.episodes.length, 0);
});

check('a shape with no digits is a navigation bar, not a listing', () => {
  const r = crawl.findChildren(page([
    ['/v/alpha', 'Alpha'], ['/v/beta', 'Beta'],
    ['/v/gamma', 'Gamma'], ['/v/delta', 'Delta']
  ], { title: 'Show' }), 'https://x.test/v/show');
  assert.strictEqual(r.episodes.length, 0);
});

check('the words beat the shape where both apply', () => {
  /* The largest same-shaped group on a film site is very often its "you may
     also like" rail, so the shape rule is a fallback and never a tie-break. */
  const r = crawl.findChildren(page([
    ['/episode/a-show-episode-1', 'Episode 1'],
    ['/promo/x-1', ''], ['/promo/x-2', ''], ['/promo/x-3', ''], ['/promo/x-4', '']
  ], { title: 'A Show' }), 'https://x.test/season/a-show');
  assert.strictEqual(r.via, 'words');
  assert.deepStrictEqual(urls(r), ['https://x.test/episode/a-show-episode-1']);
});

/* ---------- limits and shapes of input ---------- */

check('an unnumbered child sorts last, in the order the page gave it', () => {
  const rows = crawl.order([
    { num: null, season: null, url: 'c' },
    { num: 2, season: 1, url: 'b' },
    { num: 1, season: 1, url: 'a' }
  ]);
  assert.deepStrictEqual(rows.map((r) => r.url), ['a', 'b', 'c']);
});

check('the child ceiling is enforced rather than trusted', () => {
  const many = [];
  for (let i = 1; i <= crawl.MAX_CHILDREN + 80; i++) many.push(['/episode/a-show-episode-' + i, 'Episode ' + i]);
  const r = crawl.findChildren(page(many, { title: 'A Show' }), 'https://x.test/season/a-show');
  assert.strictEqual(r.episodes.length, crawl.MAX_CHILDREN);
});

check('a page with no links at all is an empty answer, not a throw', () => {
  const r = crawl.findChildren('<html><body>nothing here</body></html>', 'https://x.test/a');
  assert.deepStrictEqual(r.episodes, []);
  assert.strictEqual(r.via, 'none');
});

check('junk in is an empty answer, not a throw', () => {
  assert.deepStrictEqual(crawl.findChildren('', 'https://x.test/a').episodes, []);
  assert.deepStrictEqual(crawl.findChildren(null, 'https://x.test/a').episodes, []);
  assert.deepStrictEqual(crawl.findChildren('<a href="/x">y</a>', 'not a url').episodes, []);
});

check('the title comes from the h1 before the keyword-padded <title>', () => {
  const html = '<html><head><title>Bigg Boss Season 20 - watch free hd online</title></head>' +
    '<body><h1>Bigg Boss Season 20</h1></body></html>';
  assert.strictEqual(crawl.titleOf(html), 'Bigg Boss Season 20');
});


/* ------------------------------------------------------------------ *
 * Frames a browser would never load
 *
 * desi-serials.to leaves the previous week's player commented out above
 * the live one. collectFrames() is a regex over raw HTML, so it read that
 * dead markup as the page's embed — and the scan then reported an embed
 * host that was not in play, which is what sent Rj off to check an address
 * that had nothing to do with the problem.
 *
 * The legacy `<!--` wrapper inside <script> is the other half: strip
 * comments naively and every player config inside one goes with them.
 * ------------------------------------------------------------------ */

const media = require('../lib/media');

check('a commented-out iframe is not an embed', () => {
  const html = "<!-- <IFRAME SRC='https://dead.example/dsvid/'></IFRAME> -->" +
    "<iframe src='https://live.example/play/'></iframe>";
  assert.deepStrictEqual(
    media.collectFrames(html, 'https://page.test/e/'),
    ['https://live.example/play/']
  );
});

check('a page whose only iframe is commented out carries no frames at all', () => {
  const html = "<p>hi</p><!-- <iframe src='https://dead.example/x/'></iframe> -->";
  assert.deepStrictEqual(media.collectFrames(html, 'https://page.test/e/'), []);
});

check('the legacy <!-- wrapper inside a script does not eat the script', () => {
  const html = "<script>\n<!--\nvar file = 'https://cfg.example/a.m3u8';\n//-->\n</script>" +
    "<iframe src='https://live.example/play/'></iframe>";
  const ranges = media.commentRanges(html);
  assert.strictEqual(ranges.length, 0, 'a comment opened inside <script> is not a comment range');
  assert.deepStrictEqual(
    media.collectFrames(html, 'https://page.test/e/'),
    ['https://live.example/play/']
  );
});

check('several dead players above one live one still resolve to the live one', () => {
  const html = "<!-- <iframe src='https://old1.example/a/'></iframe> -->" +
    "<!-- <iframe src='https://old2.example/b/'></iframe> -->" +
    "<iframe src='https://now.example/c/'></iframe>";
  assert.deepStrictEqual(
    media.collectFrames(html, 'https://page.test/e/'),
    ['https://now.example/c/']
  );
});

console.log('');
if (failures.length) {
  console.log(failures.length + ' failed, ' + passed + ' passed');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log(passed + ' passed');
