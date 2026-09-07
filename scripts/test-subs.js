#!/usr/bin/env node
/* Proof for the subtitle converter in lib/subs.js.
 *
 * This module had no test at all, and it just became load-bearing: an .srt
 * chosen off the phone now goes through toVtt() and is STORED, so a
 * conversion fault is no longer a bad render that a reload fixes — it is a
 * bad file with an address, sitting in a table, being fetched by a
 * television. Everything here is offline; not one case needs a network.
 *
 *   node scripts/test-subs.js
 */

const assert = require('assert');
const { toVtt, normalizeStamp, looksLikeSubtitles, MAX_CUES } = require('../lib/subs');

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

const SRT = [
  '1',
  '00:00:01,000 --> 00:00:04,000',
  'The first line.',
  '',
  '2',
  '00:00:05,500 --> 00:00:09,250',
  'The second line,',
  'which runs on.',
  ''
].join('\n');

/* ---------- the ordinary case ---------- */

check('an ordinary SRT converts, header first', () => {
  const out = toVtt(SRT);
  assert.ok(out.vtt.startsWith('WEBVTT\n\n'), 'no WEBVTT header');
  assert.strictEqual(out.cues, 2);
});

check('the comma becomes a dot — the whole reason VTT refuses an SRT', () => {
  const out = toVtt(SRT);
  assert.ok(out.vtt.includes('00:00:01.000 --> 00:00:04.000'));
  assert.ok(out.vtt.includes('00:00:05.500 --> 00:00:09.250'));
  /* Scoped to the TIMING lines on purpose. Dialogue is full of commas and
     they belong there — it is the stamp either side of the arrow that VTT
     refuses to parse with one in it. */
  const timings = out.vtt.split('\n').filter((l) => l.includes('-->'));
  assert.strictEqual(timings.length, 2);
  timings.forEach((l) => assert.ok(!l.includes(','), 'a comma survived into a timing line: ' + l));
});

check('dialogue survives verbatim, both lines of a two-line cue', () => {
  const out = toVtt(SRT);
  assert.ok(out.vtt.includes('The second line,\nwhich runs on.'));
});

check('SRT sequence numbers are dropped, not left as cue text', () => {
  const out = toVtt(SRT);
  assert.ok(!/\n1\n/.test(out.vtt), 'a bare sequence number reached the output');
});

check('a non-numeric first line is a cue identifier and is kept', () => {
  const out = toVtt('intro\n00:00:01,000 --> 00:00:02,000\nHello.\n');
  assert.ok(out.vtt.includes('intro\n00:00:01.000'));
});

/* ---------- the shapes real files actually arrive in ---------- */

check('CRLF — every file written on Windows', () => {
  const out = toVtt(SRT.replace(/\n/g, '\r\n'));
  assert.strictEqual(out.cues, 2);
  assert.ok(!out.vtt.includes('\r'), 'a carriage return survived');
});

check('a UTF-8 BOM is stripped, not read as part of the first number', () => {
  const out = toVtt('﻿' + SRT);
  assert.strictEqual(out.cues, 2);
});

check('a bare mm:ss,mmm is widened to hh:mm:ss.mmm', () => {
  const out = toVtt('1\n01:30,000 --> 01:34,000\nShort form.\n');
  assert.ok(out.vtt.includes('00:01:30.000 --> 00:01:34.000'), out.vtt);
});

check('short milliseconds are padded, not truncated', () => {
  assert.strictEqual(normalizeStamp('00:00:01,5'), '00:00:01.500');
  assert.strictEqual(normalizeStamp('00:00:01,50'), '00:00:01.500');
});

check('a missing milliseconds field is zero, not a rejection', () => {
  assert.strictEqual(normalizeStamp('00:00:07'), '00:00:07.000');
});

check('an hour over 99 is still a stamp — long recordings exist', () => {
  assert.strictEqual(normalizeStamp('100:00:00,000'), '100:00:00.000');
});

check('61 minutes is not a time and is refused', () => {
  assert.strictEqual(normalizeStamp('00:61:00,000'), null);
  assert.strictEqual(normalizeStamp('00:00:61,000'), null);
});

check('a VTT that is already a VTT is not given a second header', () => {
  const out = toVtt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nAlready fine.\n');
  assert.strictEqual(out.vtt.match(/WEBVTT/g).length, 1);
  assert.strictEqual(out.cues, 1);
});

check("a VTT cue's positioning settings are carried through", () => {
  const out = toVtt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000 line:90% align:center\nDown there.\n');
  assert.ok(out.vtt.includes('line:90% align:center'), out.vtt);
});

check('blank cues and stray blank lines do not become empty cues', () => {
  const out = toVtt('1\n00:00:01,000 --> 00:00:02,000\nOne.\n\n\n\n2\n00:00:03,000 --> 00:00:04,000\n\n');
  assert.strictEqual(out.cues, 1);
});

/* ---------- the parts that stop a file breaking the document ---------- */

check('a "-->" spoken in dialogue cannot start a new cue', () => {
  const out = toVtt('1\n00:00:01,000 --> 00:00:02,000\nhe said --> that\n');
  const body = out.vtt.split('\n\n')[1];
  assert.strictEqual((body.match(/-->/g) || []).length, 1, 'a second arrow reached the body');
});

check('an unknown tag is escaped; the formatting tags VTT knows are kept', () => {
  const out = toVtt('1\n00:00:01,000 --> 00:00:02,000\n<i>soft</i> <script>x</script>\n');
  assert.ok(out.vtt.includes('<i>soft</i>'), 'italics were escaped');
  assert.ok(out.vtt.includes('&lt;script'), 'a script tag was not escaped');
});

check('a file with no cues at all is refused, not returned empty', () => {
  /* An empty track that loads cleanly is worse than a refusal: the subtitle
     button lights up and then says nothing for two hours. */
  assert.throws(() => toVtt('just some prose, no timings anywhere'), /no subtitles/i);
  assert.throws(() => toVtt(''), /no subtitles/i);
});

check('the cue ceiling is enforced rather than trusted', () => {
  const many = [];
  for (let i = 0; i < MAX_CUES + 50; i++) {
    many.push(i + '\n00:00:0' + (i % 9) + ',000 --> 00:00:0' + ((i % 9) + 1) + ',000\nline ' + i);
  }
  assert.strictEqual(toVtt(many.join('\n\n')).cues, MAX_CUES);
});

/* ---------- what the upload gate lets through ---------- */

check('an SRT is recognised by its shape, not its file name', () => {
  assert.strictEqual(looksLikeSubtitles(SRT), true);
  assert.strictEqual(looksLikeSubtitles('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nx'), true);
  assert.strictEqual(looksLikeSubtitles('﻿WEBVTT\n\n'), true);
});

check('a JPEG renamed .srt is refused — a phone picker will hand one over', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString('binary');
  assert.strictEqual(looksLikeSubtitles(jpeg), false);
});

check('a web page is refused — the usual shape of a dead subtitle link', () => {
  assert.strictEqual(looksLikeSubtitles('<!doctype html><html><body>Not found</body></html>'), false);
});

check('nothing at all is refused rather than throwing', () => {
  assert.strictEqual(looksLikeSubtitles(''), false);
  assert.strictEqual(looksLikeSubtitles(null), false);
  assert.strictEqual(looksLikeSubtitles(undefined), false);
});

check('a feature-length file sits well inside the 1 MB upload cap', () => {
  /* The handler reads at most 1 MB. This asserts the two numbers are not on
     the wrong sides of each other for an ordinary film. */
  const cues = [];
  for (let i = 0; i < 1400; i++) {
    cues.push(i + '\n00:0' + (i % 6) + ':0' + (i % 6) + ',000 --> 00:0' + (i % 6) + ':0' + ((i % 6) + 1) +
      ',000\nA line of dialogue of about the length people speak in.');
  }
  const file = cues.join('\n\n');
  assert.ok(Buffer.byteLength(file) < 1024 * 1024, 'a normal film exceeds the cap');
  assert.strictEqual(toVtt(file).cues, 1400);
});

console.log('');
if (failures.length) {
  console.log(failures.length + ' failed, ' + passed + ' passed');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log(passed + ' passed');
