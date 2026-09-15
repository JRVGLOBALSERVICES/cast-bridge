#!/usr/bin/env node
/* Proof for lib/opensubs.js — the OpenSubtitles search behind the Subtitles
 * panel's "search by name". Offline: every network call is a fake fetch, so
 * this proves the parsing, the URL shape the legacy API insists on, the
 * fallback to the keyed API, and that a pick can never be steered to a host
 * other than OpenSubtitles.
 *
 *   node scripts/test-opensubs.js
 */

const assert = require('assert');
const zlib = require('zlib');
const o = require('../lib/opensubs');

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ok   ' + name);
  } catch (err) {
    failures.push(name + ' — ' + err.message);
    console.log('  FAIL ' + name + ' — ' + err.message);
  }
}

function reply(status, body, headers) {
  const h = new Map(Object.entries(headers || {}));
  return {
    status,
    headers: { get: (k) => h.get(k.toLowerCase()) || null },
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    arrayBuffer: async () => {
      const b = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
    }
  };
}

const SRT = '1\r\n00:00:01,000 --> 00:00:02,000\r\nHello\r\n';

(async () => {
  await check('parseTitle strips a file name down to the film', () => {
    assert.deepStrictEqual(o.parseTitle('Chandni.Chowk.To.China.2009.mp4'), { title: 'Chandni Chowk To China', season: null, episode: null });
  });
  await check('parseTitle pulls season and episode out of S01E02', () => {
    assert.deepStrictEqual(o.parseTitle('Breaking.Bad.S01E02.720p.WEB-DL.mkv'), { title: 'Breaking Bad', season: 1, episode: 2 });
  });
  await check('parseTitle keeps a year that is part of the name', () => {
    assert.strictEqual(o.parseTitle('Blade Runner 2049').title, 'Blade Runner 2049');
  });
  await check('parseTitle drops a site suffix', () => {
    assert.strictEqual(o.parseTitle('Parasite (2019) - Watch on Bilibili').title, 'Parasite');
  });

  await check('legacy URL segments are alphabetical (anything else is a 302)', () => {
    const u = o.legacySearchUrl({ title: 'Breaking Bad', season: 1, episode: 2, lang: o.language('may') });
    assert.strictEqual(u, 'https://rest.opensubtitles.org/search/episode-2/query-breaking%20bad/season-1/sublanguageid-may');
  });
  await check('language accepts either code and refuses unknowns', () => {
    assert.strictEqual(o.language('ms').os, 'may');
    assert.strictEqual(o.language('eng').iso, 'en');
    assert.strictEqual(o.language('xx'), null);
  });

  await check('fromLegacy keeps srt/vtt only, most downloaded first', () => {
    const rows = o.fromLegacy([
      { IDSubtitleFile: '1', SubFormat: 'srt', SubDownloadsCnt: '5', MovieReleaseName: 'a' },
      { IDSubtitleFile: '2', SubFormat: 'sub', SubDownloadsCnt: '900', MovieReleaseName: 'b' },
      { IDSubtitleFile: '3', SubFormat: 'srt', SubDownloadsCnt: '50', MovieReleaseName: 'c', SubHearingImpaired: '1' }
    ]);
    assert.deepStrictEqual(rows.map((r) => r.ref), ['os:3', 'os:1']);
    assert.strictEqual(rows[0].hearingImpaired, true);
  });

  await check('parseRef refuses anything that is not a search ref', () => {
    assert.deepStrictEqual(o.parseRef('os:1952021872'), { door: 'os', id: '1952021872' });
    assert.strictEqual(o.parseRef('https://evil.example/x.srt'), null);
    assert.strictEqual(o.parseRef('os:12/../x'), null);
  });

  await check('decodeBytes honours the legacy CP1252 label', () => {
    const buf = Buffer.from([0x63, 0x61, 0x66, 0xe9]);   // "café" in windows-1252
    assert.strictEqual(o.decodeBytes(buf, 'CP1252'), 'café');
    assert.strictEqual(o.decodeBytes(buf, ''), 'café');   // invalid utf-8 falls back
  });

  await check('search uses the keyless door when it answers', async () => {
    const seen = [];
    const r = await o.search({ title: 'x', lang: 'eng' }, {}, async (u) => {
      seen.push(u);
      return reply(200, [{ IDSubtitleFile: '7', SubFormat: 'srt', SubDownloadsCnt: '1' }]);
    });
    assert.strictEqual(r.via, 'opensubtitles.org');
    assert.strictEqual(r.results[0].ref, 'os:7');
    assert.strictEqual(seen.length, 1);
  });

  await check('search falls back to the keyed API when the legacy door refuses', async () => {
    const r = await o.search({ title: 'x', lang: 'ms' }, { OPENSUBTITLES_API_KEY: 'k' }, async (u, init) => {
      if (u.startsWith('https://rest.')) return reply(503, 'no');
      assert.strictEqual(init.headers['Api-Key'], 'k');
      assert.ok(u.includes('languages=ms'));
      return reply(200, { data: [{ attributes: { language: 'ms', download_count: 3, files: [{ file_id: 99 }] } }] });
    });
    assert.strictEqual(r.via, 'opensubtitles.com');
    assert.strictEqual(r.results[0].ref, 'osc:99');
  });

  await check('search without a key says so when the legacy door refuses', async () => {
    await assert.rejects(o.search({ title: 'x' }, {}, async () => reply(429, 'slow')), /didn't answer/);
  });

  await check('search tries the keyless door once more when it is busy', async () => {
    let n = 0;
    const r = await o.search({ title: 'x', lang: 'eng' }, { retryDelayMs: 1 }, async () => {
      n++;
      return n === 1 ? reply(503, 'busy') : reply(200, [{ IDSubtitleFile: '8', SubFormat: 'srt', SubDownloadsCnt: '1' }]);
    });
    assert.strictEqual(n, 2);
    assert.strictEqual(r.results[0].ref, 'os:8');
  });

  await check('download tries once more after a dropped connection, never on a 404', async () => {
    let n = 0;
    const t = await o.download('os:5', 'UTF-8', { retryDelayMs: 1 }, async () => {
      n++;
      if (n === 1) throw new TypeError('fetch failed');
      return reply(200, zlib.gzipSync(Buffer.from(SRT)));
    });
    assert.strictEqual(t, SRT);
    assert.strictEqual(n, 2);
    let m = 0;
    await assert.rejects(o.download('os:5', '', { retryDelayMs: 1 }, async () => { m++; return reply(404, 'gone'); }), /refused/);
    assert.strictEqual(m, 1);
  });

  await check('download gunzips a legacy file', async () => {
    const t = await o.download('os:5', 'UTF-8', {}, async (u) => {
      assert.strictEqual(u, 'https://dl.opensubtitles.org/en/download/filead/5.gz');
      return reply(200, zlib.gzipSync(Buffer.from(SRT)));
    });
    assert.strictEqual(t, SRT);
  });

  await check('download refuses a redirect off opensubtitles.org', async () => {
    await assert.rejects(
      o.download('os:5', '', {}, async () => reply(302, '', { location: 'https://169.254.169.254/latest/' })),
      /somewhere else/
    );
  });

  await check('keyed download refuses a link off opensubtitles', async () => {
    await assert.rejects(
      o.download('osc:5', '', { OPENSUBTITLES_API_KEY: 'k' }, async () => reply(200, { link: 'https://evil.example/a.srt' })),
      /somewhere else/
    );
  });

  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) process.exit(1);
})();
