#!/usr/bin/env node
/* Proof for the bilibili.tv path — lib/bstar.js.
 *
 * Offline. Everything live about bstar was measured while building it and is
 * written into that file's header; what is checkable without a network is
 * the part that decides whether a cast works: which sign-in a paste belongs
 * to, whether a manifest token can be forged, and whether the generated MPD
 * is the document a receiver needs.
 *
 * The case that made this file necessary: bilibili.com and bilibili.tv are
 * separate accounts, and for as long as only .com was supported a .tv export
 * was refused outright. Now that both are kept, the failure mode inverts — a
 * whole-browser export holds two SESSDATA values, and taking the wrong one
 * puts a .com session behind the .tv resolver, which authenticates nothing
 * and reads as a broken account rather than a mixed-up one.
 *
 *   node scripts/test-bstar.js
 */

process.env.CAST_PASSWORD = process.env.CAST_PASSWORD ||
  'test-secret-for-bstar-proof-do-not-deploy';

const assert = require('assert');
const bstar = require('../lib/bstar');
const bili = require('../lib/bilibili');

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

const TV_SESS = 'aa11bb22%2C1790000000%2Ccc33d%2Ae1CjTVxxxxxxx';
const COM_SESS = 'zz99yy88%2C1790000000%2Cxx77w%2Ae1CjCOMxxxxxx';

function netscape(rows) {
  return ['# Netscape HTTP Cookie File', '']
    .concat(rows.map((r) => r.join('\t'))).join('\n');
}

const tvRow = ['.bilibili.tv', 'TRUE', '/', 'TRUE', '0', 'SESSDATA', TV_SESS];
const comRow = ['.bilibili.com', 'TRUE', '/', 'TRUE', '0', 'SESSDATA', COM_SESS];

console.log('\nURL parsing');

check('accepts an episode link', () => {
  assert.deepStrictEqual(
    bstar.parseTarget('https://www.bilibili.tv/en/play/2117053/13436346'),
    { seasonId: '2117053', epId: '13436346' });
});

check('accepts a season-only link', () => {
  assert.deepStrictEqual(
    bstar.parseTarget('https://www.bilibili.tv/en/play/2117053'),
    { seasonId: '2117053', epId: null });
});

check('accepts a non-English locale segment', () => {
  const t = bstar.parseTarget('https://www.bilibili.tv/id/play/2117053/13436346');
  assert.strictEqual(t && t.seasonId, '2117053');
});

check('refuses a bilibili.com link', () => {
  assert.strictEqual(bstar.parseTarget('https://www.bilibili.com/video/BV1xx411c7mD'), null);
});

check('refuses a lookalike host', () => {
  assert.strictEqual(bstar.parseTarget('https://bilibili.tv.evil.example/en/play/1/2'), null);
});

check('the .com parser refuses a .tv link', () => {
  assert.strictEqual(bili.parseTarget('https://www.bilibili.tv/en/play/2117053/13436346'), null);
});

console.log('\nTwo sign-ins, kept apart');

check('a .tv export is read as .tv', () => {
  const jar = bstar.parseCookieText(netscape([tvRow]));
  assert.strictEqual(jar && jar.SESSDATA, TV_SESS);
});

check('a .com-only export is refused by the .tv reader', () => {
  assert.strictEqual(bstar.parseCookieText(netscape([comRow])), null);
});

check('a mixed export gives each reader its own site', () => {
  const mixed = netscape([tvRow, comRow]);
  assert.strictEqual(bstar.parseCookieText(mixed).SESSDATA, TV_SESS,
    'the .tv reader took the wrong row');
  assert.strictEqual(bili.parseCookieText(mixed).SESSDATA, COM_SESS,
    'the .com reader took the wrong row');
});

check('a bare SESSDATA is not claimed by .tv when the text names .com', () => {
  assert.strictEqual(bstar.parseCookieText(netscape([comRow]) + '\nSESSDATA=' + TV_SESS), null);
});

check('a loose paste naming no site is accepted by .tv', () => {
  const jar = bstar.parseCookieText('SESSDATA=' + TV_SESS);
  assert.strictEqual(jar && jar.SESSDATA, TV_SESS);
});

check('the refusal names the other site', () => {
  const why = bstar.diagnoseCookieText(netscape([comRow]));
  assert.ok(/bilibili\.com/.test(why) && /bilibili\.tv/.test(why), why);
});

check('the .com refusal points at Bilibili TV rather than away from it', () => {
  const why = bili.diagnoseCookieText(netscape([['.bilibili.tv', 'TRUE', '/', 'TRUE', '0', 'buvid3', 'anon']]));
  assert.ok(why && !/will not work here/i.test(why),
    'still telling people .tv is unsupported: ' + why);
});

check('the seals do not cross', () => {
  const sealed = bstar.sealJar({ SESSDATA: TV_SESS });
  assert.ok(bstar.unsealJar(sealed), 'bstar cannot read its own seal');
  assert.strictEqual(bili.unsealJar(sealed), null, 'the .com reader accepted a .tv seal');
  const other = bili.sealJar({ SESSDATA: COM_SESS });
  assert.strictEqual(bstar.unsealJar(other), null, 'the .tv reader accepted a .com seal');
});

check('the cookies are stored under different names', () => {
  assert.notStrictEqual(bstar.JAR_COOKIE, bili.JAR_COOKIE);
});

console.log('\nThe manifest token');

check('round-trips an episode and a quality', () => {
  const claim = bstar.readToken(bstar.issueToken('13436346', 64, null));
  assert.deepStrictEqual(claim, { epId: '13436346', qn: 64, sealed: null });
});

check('refuses a tampered episode id', () => {
  const t = bstar.issueToken('13436346', 64, null);
  assert.strictEqual(bstar.readToken(t.replace('13436346', '99999999')), null);
});

check('refuses a tampered quality', () => {
  const t = bstar.issueToken('13436346', 32, null);
  assert.strictEqual(bstar.readToken(t.replace('.32.', '.112.')), null);
});

check('refuses a stripped signature', () => {
  const t = bstar.issueToken('13436346', 64, null);
  assert.strictEqual(bstar.readToken(t.slice(0, t.lastIndexOf('.'))), null);
});

check('refuses an expired token', () => {
  /* Minted through the real signer with a negative TTL. Editing the
     timestamp on a live token instead — which is what this check did first —
     breaks the signature, so readToken refuses it one branch earlier and the
     expiry check is never reached. That version stayed green with the expiry
     check deleted. */
  const t = bstar.issueToken('13436346', 64, null, -1000);
  assert.ok(t, 'could not mint');
  assert.strictEqual(bstar.readToken(t), null);
});

check('accepts a token that has not expired yet', () => {
  assert.ok(bstar.readToken(bstar.issueToken('13436346', 64, null, 60000)),
    'the expiry check is refusing a live token');
});

check('refuses junk', () => {
  [null, '', 'x', 'b1.1.2.3.4.5', 'a'.repeat(5000)].forEach((v) => {
    assert.strictEqual(bstar.readToken(v), null, 'accepted ' + String(v).slice(0, 12));
  });
});

console.log('\nThe generated MPD');

/* Shaped like a real /web/playurl answer, including the part that matters
   most: the renditions above 480p come back present with an empty url,
   which is how bstar expresses its sign-in gate rather than an error. */
const PLAYURL = {
  quality: 32,
  duration: 1127966,
  video: [
    { video_resource: { quality: 112, codecs: 'avc1.640032', url: '', bandwidth: 4357715, segment_base: { range: '0-1', index_range: '2-3' } } },
    { video_resource: { quality: 80, codecs: 'hev1.1.6.L150.90', url: '', bandwidth: 2000000, segment_base: { range: '0-1', index_range: '2-3' } } },
    /* Playable, and the same quality as the avc entry below it. The locked
       hev1 above cannot demonstrate the codec preference — it is filtered
       for having no url before ranking ever happens, so a build that
       preferred hevc still passed. */
    { video_resource: { quality: 32, codecs: 'hev1.1.6.L150.90', url: 'https://cdn.example/v-hev.m4s', bandwidth: 400000, size: 60000000, width: 852, height: 480, mime_type: 'video/mp4', segment_base: { range: '0-940', index_range: '941-3600' } } },
    { video_resource: { quality: 32, codecs: 'avc1.64001F', url: 'https://cdn.example/v.m4s?e=1&uipk=5', bandwidth: 499179, size: 70385847, width: 852, height: 480, frame_rate: '1691941/56398', sar: '640:639', mime_type: 'video/mp4', segment_base: { range: '0-948', index_range: '949-3692' } } },
    { video_resource: { quality: 16, codecs: 'avc1.64001E', url: 'https://cdn.example/v16.m4s', bandwidth: 200000, size: 30000000, width: 640, height: 360, mime_type: 'video/mp4', segment_base: { range: '0-900', index_range: '901-3000' } } }
  ],
  audio_resource: [
    { quality: 30280, codecs: 'mp4a.40.2', url: 'https://cdn.example/a.m4s?e=1&uipk=5', bandwidth: 193785, size: 27327816, mime_type: 'audio/mp4', segment_base: { range: '0-829', index_range: '830-3573' } }
  ]
};

const ORIGIN = 'https://cast.example.app';

function parseMpd(xmlText) {
  /* No XML parser in this repo's dependencies, and adding one to read four
     attributes would be the larger cost. These are exact-shape reads against
     a document this file generates, not a tolerant parse of a foreign one. */
  const reps = [];
  const re = /<AdaptationSet contentType="([a-z]+)"[^>]*mimeType="([^"]+)"[\s\S]*?<Representation ([^>]*)>[\s\S]*?<BaseURL>([^<]*)<\/BaseURL>[\s\S]*?<SegmentBase indexRange="([^"]*)">[\s\S]*?<Initialization range="([^"]*)"/g;
  let m;
  while ((m = re.exec(xmlText))) {
    reps.push({ type: m[1], mime: m[2], attrs: m[3], base: m[4], index: m[5], init: m[6] });
  }
  return reps;
}

check('builds a manifest with both a video and an audio stream', () => {
  const built = bstar.buildManifest(PLAYURL, 80, ORIGIN);
  assert.ok(built, 'no manifest built');
  const reps = parseMpd(built.xml);
  assert.strictEqual(reps.length, 2, 'expected one video and one audio set, got ' + reps.length);
  assert.strictEqual(reps[0].type, 'video');
  assert.strictEqual(reps[1].type, 'audio');
});

check('skips the locked renditions rather than emitting an empty BaseURL', () => {
  const built = bstar.buildManifest(PLAYURL, 112, ORIGIN);
  assert.strictEqual(built.quality, 32,
    'picked a rendition whose url was the empty string');
  assert.ok(!/<BaseURL><\/BaseURL>/.test(built.xml));
});

check('prefers avc over hevc', () => {
  const built = bstar.buildManifest(PLAYURL, 80, ORIGIN);
  assert.ok(/codecs="avc1/.test(built.xml), 'chose a codec a receiver may not decode');
  assert.ok(!/hev1/.test(built.xml));
});

check('every BaseURL goes through the stream proxy', () => {
  const built = bstar.buildManifest(PLAYURL, 80, ORIGIN);
  parseMpd(built.xml).forEach((r) => {
    assert.ok(r.base.indexOf(ORIGIN + '/api/stream?u=') === 0,
      'a segment points straight at the CDN, which 403s a receiver: ' + r.base.slice(0, 60));
    assert.ok(r.base.indexOf('r=' + encodeURIComponent('https://www.bilibili.tv/')) !== -1,
      'the referer the CDN requires is not being forwarded');
  });
});

check('carries the byte ranges through unchanged', () => {
  const reps = parseMpd(bstar.buildManifest(PLAYURL, 80, ORIGIN).xml);
  assert.strictEqual(reps[0].init, '0-948');
  assert.strictEqual(reps[0].index, '949-3692');
  assert.strictEqual(reps[1].init, '0-829');
  assert.strictEqual(reps[1].index, '830-3573');
});

check('escapes the ampersands in a signed CDN address', () => {
  const built = bstar.buildManifest(PLAYURL, 80, ORIGIN);
  const bare = built.xml.replace(/&amp;|&lt;|&gt;|&quot;|&apos;/g, '');
  assert.strictEqual(bare.indexOf('&'), -1,
    'a raw ampersand makes the whole manifest unparseable');
});

check('states a duration a player can read', () => {
  const built = bstar.buildManifest(PLAYURL, 80, ORIGIN);
  assert.ok(/mediaPresentationDuration="PT1127\.966S"/.test(built.xml), 'duration missing or wrong');
});

check('keeps the display dimensions', () => {
  const attrs = parseMpd(bstar.buildManifest(PLAYURL, 80, ORIGIN).xml)[0].attrs;
  assert.ok(/width="852"/.test(attrs) && /height="480"/.test(attrs), attrs);
});

check('falls back to the smallest rendition when the ask is below all of them', () => {
  assert.strictEqual(bstar.buildManifest(PLAYURL, 1, ORIGIN).quality, 16);
});

check('returns nothing when every rendition is locked', () => {
  const locked = { duration: 1, video: PLAYURL.video.slice(0, 2), audio_resource: PLAYURL.audio_resource };
  assert.strictEqual(bstar.buildManifest(locked, 80, ORIGIN), null);
});

check('returns nothing when there is no audio', () => {
  const mute = { duration: 1, video: PLAYURL.video, audio_resource: [] };
  assert.strictEqual(bstar.buildManifest(mute, 80, ORIGIN), null,
    'a manifest with no audio is a film with no sound');
});

console.log('\nOrigin');

check('trusts the forwarded proto when there is one', () => {
  assert.strictEqual(
    bstar.originOf({ headers: { 'x-forwarded-proto': 'https,http', host: 'cast.app' } }),
    'https://cast.app');
});

check('falls back to the socket rather than assuming https', () => {
  assert.strictEqual(
    bstar.originOf({ headers: { host: '127.0.0.1:8099' }, socket: {} }),
    'http://127.0.0.1:8099');
  assert.strictEqual(
    bstar.originOf({ headers: { host: 'cast.app' }, socket: { encrypted: true } }),
    'https://cast.app');
});

console.log('\nRegion refusals');

/* The codes below are not guesses. On 2026-09-12 the same twenty titles were
   resolved from a box in Singapore, from this app in Vercel's iad1 and from
   the same app in sin1. Nine played from either Singapore vantage and seven
   from Washington; the two that differed were refused with 10004001. That is
   the whole basis for calling 10004001 the geo-gate and 10004404 something
   else, so these tests pin the distinction rather than the wording. */

check('names the region only for the code that actually varies by region', () => {
  const region = bstar.describeRefusal(10004001, null);
  assert.ok(/region/i.test(region), 'the geo code must say region: ' + region);

  const gone = bstar.describeRefusal(10004404, null);
  assert.ok(!/region/i.test(gone),
    '10004404 was identical from every vantage measured, so calling it a ' +
    'region block sends the reader to change a thing that is not the cause: ' + gone);
});

check('does not report a bad episode id as a region block', () => {
  const missing = bstar.describeRefusal(-404, 'SESSDATA=x');
  assert.ok(!/region/i.test(missing),
    '-404 was reported as "likely region-locked" before this was measured, ' +
    'and region has its own code: ' + missing);
});

check('offers the sign-in only when there is no cookie', () => {
  assert.ok(/sign in/i.test(bstar.describeRefusal(-404, null)));
  assert.ok(!/sign in/i.test(bstar.describeRefusal(-404, 'SESSDATA=x')),
    'telling someone already signed in to sign in is a dead end');
  assert.ok(!/sign in/i.test(bstar.describeRefusal(10004001, null)),
    'a sign-in cannot lift a geo-gate, so offering it wastes the reader\'s time');
});

check('never forwards the upstream message verbatim', () => {
  /* The real one seen beside 10004404 was Chinese text about activity tags
     having nothing to do with the request. */
  for (const code of [10004001, 10004404, -404, 70001, null]) {
    for (const cookie of [null, 'SESSDATA=x']) {
      const out = bstar.describeRefusal(code, cookie);
      assert.ok(typeof out === 'string' && out.length > 20,
        'every refusal needs a sentence, code ' + code);
      assert.ok(!/[\u4e00-\u9fff]/.test(out),
        'Chinese reached the reader for code ' + code + ': ' + out);
    }
  }
});

check('keeps an unknown code where it can be looked up', () => {
  assert.ok(/70001/.test(bstar.describeRefusal(70001, null)),
    'dropping a code we cannot explain leaves nothing to diagnose with');
  assert.ok(!/null|undefined|NaN/.test(bstar.describeRefusal(null, null)),
    'a missing code must not be printed as the word null');
});

check('names the resolving region from the environment, not a literal', () => {
  const prev = process.env.VERCEL_REGION;
  try {
    process.env.VERCEL_REGION = 'sin1';
    assert.ok(/Singapore/.test(bstar.describeRefusal(10004001, null)));
    process.env.VERCEL_REGION = 'iad1';
    assert.ok(/Washington/.test(bstar.describeRefusal(10004001, null)),
      'hardcoding Singapore would keep saying Singapore after a region change');
    process.env.VERCEL_REGION = 'zzz9';
    assert.ok(/zzz9/.test(bstar.describeRefusal(10004001, null)),
      'an unmapped region should still be named');
    delete process.env.VERCEL_REGION;
    const bare = bstar.describeRefusal(10004001, null);
    assert.ok(/region/i.test(bare) && !/\(\)/.test(bare),
      'off Vercel there is no region to name and the clause must drop: ' + bare);
  } finally {
    if (prev === undefined) delete process.env.VERCEL_REGION;
    else process.env.VERCEL_REGION = prev;
  }
});

check('the deploy is pinned to a region inside bstar\'s catalogue', () => {
  const cfg = require('../vercel.json');
  assert.ok(Array.isArray(cfg.regions) && cfg.regions.length === 1,
    'bilibili.tv gates on the region the ADDRESS is requested from, so the ' +
    'resolve and the segment proxy must agree on one region');
  assert.ok(Object.prototype.hasOwnProperty.call(bstar.REGION_CITY, cfg.regions[0]),
    'a region the messages cannot name: ' + cfg.regions[0]);
  assert.strictEqual(cfg.regions[0], 'sin1',
    'measured 2026-09-12: iad1 played 7 of 20 sampled titles, sin1 played 9');
});

console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
