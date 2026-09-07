#!/usr/bin/env node
/* Proof for the packed-player-script reader in lib/media.js.
 *
 * The thing being proved is narrow and the risk is not. Unpacking runs on
 * every page the scanner reads, against text a stranger wrote, so the two
 * failures worth guarding are "it changes a page it should have left
 * alone" and "it gets slow or loud on something malformed". Both are
 * asserted here, alongside the recovery it exists for.
 *
 *   node scripts/test-unpack.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const m = require('../lib/media');

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

/* ------------------------------------------------------------------ *
 * A packer, so the decode is tested against the real encoding rather
 * than against a sample somebody typed out by hand. This is Dean
 * Edwards' encoder, the counterpart of what lib/media.js reverses.
 * ------------------------------------------------------------------ */

function encodeBase(n, radix) {
  const digit = (c) => (c > 35 ? String.fromCharCode(c + 29) : c.toString(36));
  let out = '';
  let v = n;
  do {
    out = digit(v % radix) + out;
    v = Math.floor(v / radix);
  } while (v > 0);
  return out;
}

function pack(source, radix) {
  const words = [];
  const index = new Map();
  const payload = source.replace(/\b\w+\b/g, (w) => {
    if (!index.has(w)) {
      index.set(w, words.length);
      words.push(w);
    }
    return encodeBase(index.get(w), radix);
  });
  const lit = (s) => "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  return "eval(function(p,a,c,k,e,d){while(c--)if(k[c])p=p.replace(" +
    "new RegExp('\\\\b'+c.toString(a)+'\\\\b','g'),k[c]);return p}(" +
    lit(payload) + ',' + radix + ',' + words.length + ',' +
    lit(words.join('|')) + ".split('|'),0,{}))";
}

/* ------------------------------------------------------------------ *
 * Recovery — the reason this exists
 * ------------------------------------------------------------------ */

const CONFIG =
  'jwplayer("player").setup({sources:[' +
  '{file:"https://cdn.example.net/aaaa/v.mp4",label:"720p"},' +
  '{file:"https://cdn.example.net/bbbb/v.mp4",label:"360p"}' +
  '],image:"https://cdn.example.net/i/thumb.jpg"});';

[36, 62].forEach((radix) => {
  check('round-trips a packed player config at base ' + radix, () => {
    const packed = pack(CONFIG, radix);
    assert.ok(packed.indexOf('cdn.example.net/aaaa') === -1,
      'the fixture is not actually packed — the address survived verbatim');
    const out = m.deobfuscate('<html><script>' + packed + '</script></html>');
    assert.ok(out.indexOf('https://cdn.example.net/aaaa/v.mp4') !== -1,
      'the first source did not come back');
    assert.ok(out.indexOf('https://cdn.example.net/bbbb/v.mp4') !== -1,
      'the second source did not come back');
  });
});

check('an unpacked config yields both files, labelled by quality', () => {
  const html = '<html><head><title>Clip</title></head><body><script>' +
    pack(CONFIG, 62) + '</script></body></html>';
  const parsed = m.extract(m.deobfuscate(html), 'https://host.example/embed.html');
  const labels = parsed.media.map((x) => x.label).sort();
  assert.strictEqual(parsed.media.length, 2, 'expected two sources, got ' + parsed.media.length);
  assert.deepStrictEqual(labels, ['360p', '720p'],
    'qualities came back as ' + JSON.stringify(labels) +
    ' — three copies of the same filename is not a choice');
});

check('reads the real vkprime block byte for byte', () => {
  const fixture = fs.readFileSync(
    path.join(__dirname, 'fixtures', 'packed-jwplayer.txt'), 'utf8');
  const out = m.deobfuscate(fixture);
  const found = (out.match(/https:\/\/sys\.vkcdn5\.com\/[a-z0-9]+\/v\.mp4/g) || []);
  assert.strictEqual(found.length, 3,
    'expected the three qualities vkprime ships, got ' + found.length);
  assert.ok(/label:"720p"/.test(out), 'the 720p label did not survive');
});

check('unpacks a packer inside a packer', () => {
  const inner = pack('var u="https://cdn.example.net/deep/v.mp4";', 62);
  const outer = pack('document.write(' + JSON.stringify(inner) + ');', 62);
  const out = m.deobfuscate(outer);
  assert.ok(out.indexOf('https://cdn.example.net/deep/v.mp4') !== -1,
    'the nested address did not come back');
});

/* ------------------------------------------------------------------ *
 * Leaving alone what it should leave alone
 * ------------------------------------------------------------------ */

check('an ordinary page comes back byte-identical', () => {
  const html = '<html><head><title>A post</title></head><body>' +
    '<p>Some words about a film.</p>' +
    '<script>var a = 1; function e(p) { return p; }</script>' +
    '<video src="https://cdn.example.net/plain.mp4"></video></body></html>';
  assert.strictEqual(m.deobfuscate(html), html,
    'a page with nothing packed in it was modified');
});

check('a page that merely mentions the signature is left alone', () => {
  const html = '<p>The old eval(function(p,a,c,k,e,d) packer is described here.</p>';
  assert.strictEqual(m.deobfuscate(html), html);
});

check('never runs what it reads', () => {
  /* Asserted by consequence, not by grep. The section's own comments and
     the regex that finds a packed block both contain the characters
     `eval(`, so reading the source for them proves nothing either way.
     Packing something that would be loud if executed does. */
  const evidence = '__castBridgeUnpackerExecuted';
  delete globalThis[evidence];
  const payload = 'globalThis.' + evidence + ' = true; ' +
    'globalThis.process && globalThis.process.exit && 0;';
  const out = m.deobfuscate('<script>' + pack(payload, 62) + '</script>');
  assert.ok(out.indexOf('globalThis.' + evidence) !== -1,
    'the payload was not recovered, so this proves nothing');
  assert.ok(!(evidence in globalThis),
    'the unpacker executed the page it was reading — a scanned page can run ' +
    'code on the server');

  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'media.js'), 'utf8');
  const start = src.indexOf('Packed player scripts');
  const end = src.indexOf('Widening the quick scan');
  assert.ok(start > 0 && end > start, 'could not locate the unpacker in lib/media.js');
  assert.ok(!/new\s+Function\s*\(/.test(src.slice(start, end)),
    'the unpacker builds a Function — the same hole by another name');
});

check('a global regex is not left mid-scan between calls', () => {
  const packed = '<script>' + pack(CONFIG, 62) + '</script>';
  const first = m.deobfuscate(packed);
  const second = m.deobfuscate(packed);
  assert.strictEqual(first, second,
    'the same document unpacked differently the second time — lastIndex leaked');
});

/* ------------------------------------------------------------------ *
 * Malformed input, which is most of the web
 * ------------------------------------------------------------------ */

const MALFORMED = {
  'a truncated call': 'eval(function(p,a,c,k,e,d){while(c--)}(\'a b c\',62,3,',
  'no dictionary at all': "eval(function(p,a,c,k,e,d){}('a b c',62,3,''.split('|'),0,{}))",
  'a radix of zero': "eval(function(p,a,c,k,e,d){}('a b',0,2,'x|y'.split('|'),0,{}))",
  'a radix past the digit set': "eval(function(p,a,c,k,e,d){}('a b',99,2,'x|y'.split('|'),0,{}))",
  'a payload full of quotes': "eval(function(p,a,c,k,e,d){}('a\\'b\\'c',62,1,'z'.split('|'),0,{}))",
  'an unterminated string': "eval(function(p,a,c,k,e,d){}('a b c,62,3,'x|y|z'.split('|')",
  'the signature with no call': 'eval(function(p,a,c,k,e,d){ return d; })'
};

Object.keys(MALFORMED).forEach((name) => {
  check('survives ' + name, () => {
    const started = Date.now();
    const out = m.deobfuscate('<html>' + MALFORMED[name] + '</html>');
    assert.strictEqual(typeof out, 'string', 'did not return a string');
    assert.ok(Date.now() - started < 2000,
      'took ' + (Date.now() - started) + 'ms on malformed input');
  });
});

check('a huge run of signatures stays bounded in time and size', () => {
  const packed = pack(CONFIG, 62);
  const html = new Array(200).join('<script>' + packed + '</script>');
  const started = Date.now();
  const out = m.deobfuscate(html);
  const ms = Date.now() - started;
  assert.ok(ms < 3000, 'took ' + ms + 'ms across 200 packed blocks');
  assert.ok(out.length - html.length < 700 * 1024,
    'appended ' + (out.length - html.length) + ' bytes — the cap did not hold');
});

check('an empty or absent document is not an error', () => {
  assert.strictEqual(m.deobfuscate(''), '');
  assert.strictEqual(m.deobfuscate(null), null);
  assert.strictEqual(m.deobfuscate(undefined), undefined);
});

/* ------------------------------------------------------------------ *
 * The rest of the parser still behaves
 * ------------------------------------------------------------------ */

check('a plain page with a video tag is unaffected', () => {
  const html = '<html><title>T</title><video src="/media/clip.mp4" ' +
    'poster="/i/p.jpg"></video></html>';
  const parsed = m.extract(m.deobfuscate(html), 'https://host.example/page');
  assert.strictEqual(parsed.media.length, 1);
  assert.strictEqual(parsed.media[0].url, 'https://host.example/media/clip.mp4');
  assert.strictEqual(parsed.poster, 'https://host.example/i/p.jpg');
});

check('a source list with no labels still reports its files', () => {
  const html = '<script>var c = {sources:[{file:"https://h.example/a.m3u8"}]};</script>';
  const parsed = m.extract(m.deobfuscate(html), 'https://h.example/');
  assert.strictEqual(parsed.media.length, 1);
  assert.strictEqual(parsed.media[0].kind, 'HLS');
});

check('a source list of images is still not media', () => {
  const html = '<script>var c={sources:[{file:"https://h.example/a.jpg",label:"big"}]};</script>';
  const parsed = m.extract(m.deobfuscate(html), 'https://h.example/');
  assert.strictEqual(parsed.media.length, 0, 'a jpg was reported as something to cast');
});

console.log('');
if (failures.length) {
  console.log(failures.length + ' failed, ' + passed + ' passed');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log(passed + ' passed');
