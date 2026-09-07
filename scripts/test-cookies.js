#!/usr/bin/env node
/* Proof for the pasted-sign-in reader in lib/bilibili.js.
 *
 * Offline, and deliberately so — every case here is about reading a file,
 * not about Bilibili. What sent me here was a real cookies.txt: four
 * anonymous cookies scoped to bilibili.tv, which authenticate nothing at
 * api.bilibili.com (checked live — an identical "not logged in" with them
 * and without). Reading it showed the worse fault behind it: a correct,
 * signed-in bilibili.com export was refused too, because a Netscape line
 * separates the name from the value with a tab where a Cookie header uses
 * an equals.
 *
 *   node scripts/test-cookies.js
 */

const assert = require('assert');
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

const SESS = '9f2ab1cd%2C1790000000%2Cbb3e1%2Ac1CjAxxxxxxxxx';
const JCT = '0123456789abcdef0123456789abcdef';
const UID = '12345678';

function netscape(rows) {
  return ['# Netscape HTTP Cookie File', '# https://curl.haxx.se/rfc/cookie_spec.html', '']
    .concat(rows.map((r) => r.join('\t'))).join('\n');
}

const SIGNED_IN = netscape([
  ['.bilibili.com', 'TRUE', '/', 'FALSE', '0', 'buvid3', 'ABCDEF'],
  ['#HttpOnly_.bilibili.com', 'TRUE', '/', 'TRUE', '1790000000', 'SESSDATA', SESS],
  ['.bilibili.com', 'TRUE', '/', 'FALSE', '1790000000', 'bili_jct', JCT],
  ['.bilibili.com', 'TRUE', '/', 'FALSE', '1790000000', 'DedeUserID', UID]
]);

/* Verbatim from the file that prompted this, values included — they are
   anonymous device and telemetry cookies, which is the whole point. */
const TV_EXPORT = netscape([
  ['.bilibili.tv', 'TRUE', '/', 'FALSE', '0', 'buvid3', 'TXDF1DAFCBA2ADD0414B30E5E3ED447BE132BB'],
  ['.bilibili.tv', 'TRUE', '/', 'FALSE', '1788885634', 'bstar-web-lang', 'ms'],
  ['.bilibili.tv', 'TRUE', '/', 'FALSE', '0', 'bsource', 'search_google'],
  ['.bilibili.tv', 'TRUE', '/', 'FALSE', '1823359234', 'buvid4', 'DEFAD6FE-8706-3192-80FF-088C6889C77733099-126090800-fvtL0C%2BoP1eqQ']
]);

console.log('\ncookies.txt — the Netscape export');

check('a signed-in bilibili.com export yields all three', () => {
  const jar = bili.parseCookieText(SIGNED_IN);
  assert.deepStrictEqual(jar, { SESSDATA: SESS, bili_jct: JCT, DedeUserID: UID });
});

check('the #HttpOnly_ prefix is stripped, not read as a comment', () => {
  /* SESSDATA is always HttpOnly, so an export that marks it this way is the
     common case rather than an edge one. Skip the prefix and the file has
     no session in it at all. */
  const one = netscape([['#HttpOnly_.bilibili.com', 'TRUE', '/', 'TRUE', '0', 'SESSDATA', SESS]]);
  assert.strictEqual(bili.parseCookieText(one).SESSDATA, SESS);
});

check('an ordinary # comment is still a comment', () => {
  const withNoise = '# .bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tNOTAREALONE\n' + SIGNED_IN;
  assert.strictEqual(bili.parseCookieText(withNoise).SESSDATA, SESS);
});

check('the value is kept percent-encoded', () => {
  /* A Cookie header wants SESSDATA exactly as Bilibili wrote it. Decoding
     the %2C here would produce a session Bilibili does not recognise. */
  const jar = bili.parseCookieText(SIGNED_IN);
  assert.ok(jar.SESSDATA.indexOf('%2C') !== -1, 'the encoding was undone');
  assert.strictEqual(jar.SESSDATA.indexOf(','), -1);
});

check('a whole-browser export takes only the bilibili.com session', () => {
  const mixed = netscape([
    ['.example.com', 'TRUE', '/', 'TRUE', '0', 'SESSDATA', 'SOMEBODY-ELSES-VALUE'],
    ['.bilibili.com', 'TRUE', '/', 'TRUE', '0', 'SESSDATA', SESS],
    ['.bilibili.com', 'TRUE', '/', 'FALSE', '0', 'DedeUserID', UID]
  ]);
  const jar = bili.parseCookieText(mixed);
  assert.strictEqual(jar.SESSDATA, SESS);
});

check('CRLF line endings read the same as LF', () => {
  assert.strictEqual(bili.parseCookieText(SIGNED_IN.replace(/\n/g, '\r\n')).SESSDATA, SESS);
});

check('a truncated line is skipped rather than mis-read', () => {
  const short = '.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\n' + SIGNED_IN;
  assert.strictEqual(bili.parseCookieText(short).SESSDATA, SESS);
});

console.log('\nthe shapes that already worked, still working');

check('a Cookie header pasted whole', () => {
  const jar = bili.parseCookieText(
    'buvid3=ABC; SESSDATA=' + SESS + '; bili_jct=' + JCT + '; DedeUserID=' + UID);
  assert.deepStrictEqual(jar, { SESSDATA: SESS, bili_jct: JCT, DedeUserID: UID });
});

check('the three values on three lines', () => {
  const jar = bili.parseCookieText(
    'SESSDATA: ' + SESS + '\nbili_jct: ' + JCT + '\nDedeUserID: ' + UID);
  assert.strictEqual(jar.bili_jct, JCT);
});

check('a bare SESSDATA with its name left behind', () => {
  assert.strictEqual(bili.parseCookieText(SESS).SESSDATA, SESS);
});

console.log('\nwhat is refused, and what it is told');

check('the bilibili.tv export carries no session', () => {
  assert.strictEqual(bili.parseCookieText(TV_EXPORT), null);
});

check('a bilibili.tv export is named as the wrong site', () => {
  const why = bili.diagnoseCookieText(TV_EXPORT);
  assert.ok(why, 'no reason given for a file whose reason is on its face');
  assert.ok(/bilibili\.tv/.test(why), 'the reason does not name the site');
  assert.ok(/bilibili\.com/.test(why), 'the reason does not name where to go');
});

check('a signed-out bilibili.com export is named as signed out', () => {
  const out = netscape([
    ['.bilibili.com', 'TRUE', '/', 'FALSE', '0', 'buvid3', 'ABCDEF'],
    ['.bilibili.com', 'TRUE', '/', 'FALSE', '0', 'b_nut', '1750000000']
  ]);
  assert.strictEqual(bili.parseCookieText(out), null);
  const why = bili.diagnoseCookieText(out);
  assert.ok(/signed out|HttpOnly/i.test(why), 'the reason does not say why: ' + why);
  assert.ok(!/bilibili\.tv/.test(why), 'the wrong-site reason was given for the right site');
});

check('a diagnosis is withheld when there is nothing to diagnose', () => {
  /* A wrong guess about why is worse than the generic requirement, so
     anything that is not a cookies.txt gets no invented explanation. */
  assert.strictEqual(bili.diagnoseCookieText('hello'), null);
  assert.strictEqual(bili.diagnoseCookieText(''), null);
  assert.strictEqual(bili.diagnoseCookieText(null), null);
});

check('a bilibili.tv export that also holds a real .com session is accepted', () => {
  /* Both sites in one file is the ordinary case for anyone who visited
     both. The .com session decides, and no wrong-site reason is raised. */
  const both = TV_EXPORT + '\n' + SIGNED_IN.split('\n').slice(3).join('\n');
  assert.strictEqual(bili.parseCookieText(both).SESSDATA, SESS);
  assert.strictEqual(bili.diagnoseCookieText(both), null);
});

check('an oversized paste is refused rather than scanned', () => {
  assert.strictEqual(bili.parseCookieText('x'.repeat(262145)), null);
});

check('a real export sits well inside the size the handler accepts', () => {
  /* The paste endpoint reads 256 KB. A one-site export is a couple of KB;
     this asserts the two numbers are not on the wrong sides of each other. */
  assert.ok(Buffer.byteLength(SIGNED_IN) < 4096);
});

console.log('');
if (failures.length) {
  console.log(failures.length + ' failed, ' + passed + ' passed');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log(passed + ' passed');
