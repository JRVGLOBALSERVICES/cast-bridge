#!/usr/bin/env node
/* Proof for the Apple form of a Bilibili TV film (lib/bstar-hls.js).
 *
 * Offline half: a synthetic sidx (v0 and v1) and the playlists written from
 * it, byte for byte where it matters.
 *
 * Online half (--live): the same functions against a REAL on-demand fMP4 —
 * Shaka's public Sintel, which is laid out exactly like a Bilibili TV file
 * (one mp4 per rendition, SegmentBase init + indexRange). Every listed byte
 * range is checked to start on a `moof`/`styp` box, the ranges are checked to
 * tile the file to its last byte, and the durations to add up to the film.
 * Bilibili TV itself is region-gated from this VPS, so a real episode could
 * not be fetched here.
 *
 *   node scripts/test-bstar-hls.js          # offline
 *   node scripts/test-bstar-hls.js --live   # plus the real file
 */
const assert = require('assert');
const hls = require('../lib/bstar-hls');

let passed = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + e.message); }
}

function sidx(version, timescale, firstOffset, refs) {
  const head = version === 0 ? 32 : 40;
  const b = Buffer.alloc(head + refs.length * 12);
  b.writeUInt32BE(b.length, 0);
  b.write('sidx', 4, 'latin1');
  b.writeUInt8(version, 8);
  b.writeUInt32BE(1, 12);           // reference_ID
  b.writeUInt32BE(timescale, 16);
  let q = 20;
  if (version === 0) { b.writeUInt32BE(0, q); b.writeUInt32BE(firstOffset, q + 4); q += 8; }
  else { b.writeBigUInt64BE(0n, q); b.writeBigUInt64BE(BigInt(firstOffset), q + 8); q += 16; }
  b.writeUInt16BE(0, q); b.writeUInt16BE(refs.length, q + 2); q += 4;
  for (const [size, dur] of refs) {
    b.writeUInt32BE(size, q); b.writeUInt32BE(dur, q + 4); b.writeUInt32BE(0x90000000, q + 8); q += 12;
  }
  return b;
}

(async () => {
  await t('parseRange reads DASH inclusive ranges', () => {
    assert.deepStrictEqual(hls.parseRange('0-825'), { start: 0, length: 826 });
    assert.strictEqual(hls.parseRange('9-3'), null);
    assert.strictEqual(hls.parseRange(''), null);
  });

  await t('v0 sidx: offsets start after the box, plus first_offset', () => {
    const box = sidx(0, 1000, 0, [[5000, 4000], [6000, 4000], [700, 1500]]);
    const segs = hls.parseSidx(box, 826);
    assert.deepStrictEqual(segs, [
      { offset: 826 + box.length, length: 5000, duration: 4 },
      { offset: 826 + box.length + 5000, length: 6000, duration: 4 },
      { offset: 826 + box.length + 11000, length: 700, duration: 1.5 }
    ]);
  });

  await t('v1 sidx with a non-zero first_offset', () => {
    const box = sidx(1, 90000, 12, [[100, 180000]]);
    assert.deepStrictEqual(hls.parseSidx(box, 50), [{ offset: 50 + box.length + 12, length: 100, duration: 2 }]);
  });

  await t('hierarchical and empty sidx are refused, not mis-listed', () => {
    const h = sidx(0, 1000, 0, [[5000, 4000]]); h.writeUInt32BE(0x80001388, 32);
    assert.throws(() => hls.parseSidx(h, 0), /hierarchical/);
    assert.throws(() => hls.parseSidx(Buffer.from('nothing to see here, not a box at all'), 0), /no sidx/);
  });

  await t('media playlist: v7, init map, one byte range per subsegment, ends', () => {
    const uri = 'https://x/api/stream?u=a&r=b';
    const p = hls.mediaPlaylist(uri, { start: 0, length: 826 }, [
      { offset: 3522, length: 5000, duration: 4 }, { offset: 8522, length: 700, duration: 1.5 }
    ]);
    const lines = p.trim().split('\n');
    assert.strictEqual(lines[0], '#EXTM3U');
    assert.ok(lines.includes('#EXT-X-VERSION:7'));
    assert.ok(lines.includes('#EXT-X-TARGETDURATION:4'));
    assert.ok(lines.includes('#EXT-X-MAP:URI="' + uri + '",BYTERANGE="826@0"'));
    assert.deepStrictEqual(lines.filter((l) => l.startsWith('#EXT-X-BYTERANGE')), ['#EXT-X-BYTERANGE:5000@3522', '#EXT-X-BYTERANGE:700@8522']);
    assert.strictEqual(lines[lines.length - 1], '#EXT-X-ENDLIST');
  });

  await t('master playlist: CODECS, RESOLUTION, audio group, fractional frame rate', () => {
    const m = hls.masterPlaylist({
      video: { codecs: 'avc1.640020', bandwidth: 900000, width: 1280, height: 533, frame_rate: '24000/1001' },
      audio: { codecs: 'mp4a.40.2', bandwidth: 128000 }
    }, 'V', 'A');
    assert.ok(m.includes('CODECS="avc1.640020,mp4a.40.2"'));
    assert.ok(m.includes('RESOLUTION=1280x533'));
    assert.ok(m.includes('FRAME-RATE=23.976'));
    assert.ok(m.includes('GROUP-ID="aud"') && m.includes('URI="A"') && m.includes('AUDIO="aud"\nV'));
    assert.ok(!m.includes('NaN'));
  });

  await t('api/bstar.js answers the three HLS forms off the same pick', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'api/bstar.js'), 'utf8');
    assert.ok(/form === 'hls' \|\| form === 'hls-v' \|\| form === 'hls-a'/.test(src));
    assert.ok(/bstar\.pickRenditions\(/.test(src) && /hls\.parseSidx\(/.test(src));
  });

  if (process.argv.includes('--live')) {
    const BASE = 'https://storage.googleapis.com/shaka-demo-assets/sintel-mp4-only/';
    const reps = [
      { file: 'v-0144p-0100k-libx264.mp4', init: '0-825', index: '826-3521' },
      { file: 'a-eng-0128k-aac.mp4', init: '0-742', index: '743-3438' }
    ];
    const range = async (url, a, b) => {
      const r = await fetch(url, { headers: { range: 'bytes=' + a + '-' + b } });
      assert.strictEqual(r.status, 206, 'expected 206 from ' + url);
      return { buf: Buffer.from(await r.arrayBuffer()), total: Number(String(r.headers.get('content-range')).split('/')[1]) };
    };
    for (const rep of reps) {
      await t('live: ' + rep.file + ' — ranges start on boxes and tile the file', async () => {
        const url = BASE + rep.file;
        const idx = hls.parseRange(rep.index);
        const got = await range(url, idx.start, idx.start + idx.length - 1);
        const segs = hls.parseSidx(got.buf, idx.start);
        const last = segs[segs.length - 1];
        assert.strictEqual(last.offset + last.length, got.total, 'ranges do not end at the last byte');
        const dur = segs.reduce((s, x) => s + x.duration, 0);
        assert.ok(Math.abs(dur - 888.05) < 2, 'durations add to ' + dur);
        for (const s of [segs[0], segs[1], segs[Math.floor(segs.length / 2)], last]) {
          const head = (await range(url, s.offset, s.offset + 7)).buf;
          const type = head.toString('latin1', 4, 8);
          assert.ok(type === 'moof' || type === 'styp', 'range at ' + s.offset + ' starts on "' + type + '"');
        }
        const init = hls.parseRange(rep.init);
        const ih = (await range(url, init.start, init.start + 7)).buf.toString('latin1', 4, 8);
        assert.strictEqual(ih, 'ftyp');
        const pl = hls.mediaPlaylist(url, init, segs);
        assert.strictEqual(pl.split('#EXT-X-BYTERANGE').length - 1, segs.length);
        console.log('       ' + segs.length + ' subsegments, ' + dur.toFixed(1) + 's, ' + got.total + ' bytes');
        require('fs').writeFileSync('/tmp/hls-proof-' + (rep.file[0] === 'v' ? 'v' : 'a') + '.m3u8', pl);
      });
    }
  }

  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  process.exit(failures.length ? 1 : 0);
})();
