/* The same Bilibili TV film, as HLS — for Apple.
 *
 * Rj, 2026-09-12: AirPlay "doesn't even load, somehow loads but no video,
 * only audio", and no stream logs.
 *
 * /api/bstar answers DASH. No Apple browser plays DASH, so the iPhone played
 * it through Shaka, i.e. Media Source Extensions. An MSE element has no
 * address for AirPlay to hand the Apple TV — only buffers this page appended
 * — so iOS routes what it can, which is the audio. Nothing ever asked the
 * stream host for a byte on the TV's behalf, which is the missing log.
 *
 * Safari and the Apple TV both play HLS natively, including fragmented MP4
 * addressed by byte range (HLS version 7). The Bilibili files are exactly
 * that: one fMP4 per rendition, an init range, and a `sidx` box listing every
 * subsegment's size and duration. So the playlists are a translation, not a
 * transcode — read the sidx, write one EXT-X-BYTERANGE per subsegment.
 *
 * Pure functions here; the fetching lives in api/bstar.js.
 */
'use strict';

/* "123-456" (inclusive, as DASH writes it) → { start, length }. */
function parseRange(s) {
  const m = /^(\d+)-(\d+)$/.exec(String(s || '').trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!(end >= start)) return null;
  return { start: start, length: end - start + 1 };
}

/* The sidx box, read from the bytes of its index range. `boxStart` is the
 * absolute file offset those bytes began at: sidx offsets are counted from
 * the first byte AFTER the box, so the box's place in the file is needed to
 * turn them into file offsets. Returns [{ offset, length, duration }]. */
function parseSidx(buf, boxStart) {
  if (!buf || buf.length < 32) throw new Error('sidx too short');
  let p = 0;
  // A range can start a few bytes early on some encoders; find the box.
  const at = buf.indexOf('sidx', 0, 'latin1');
  if (at < 4) throw new Error('no sidx box in index range');
  p = at - 4;
  const size = buf.readUInt32BE(p);
  const version = buf.readUInt8(p + 8);
  let q = p + 12; // size, type, version+flags
  q += 4; // reference_ID
  const timescale = buf.readUInt32BE(q); q += 4;
  if (!timescale) throw new Error('sidx timescale is zero');
  let firstOffset;
  if (version === 0) {
    q += 4; // earliest_presentation_time
    firstOffset = buf.readUInt32BE(q); q += 4;
  } else {
    q += 8;
    firstOffset = Number(buf.readBigUInt64BE(q)); q += 8;
  }
  q += 2; // reserved
  const count = buf.readUInt16BE(q); q += 2;
  if (buf.length < q + count * 12) throw new Error('sidx truncated');

  let offset = boxStart + p + size + firstOffset;
  const out = [];
  for (let i = 0; i < count; i++) {
    const ref = buf.readUInt32BE(q);
    const dur = buf.readUInt32BE(q + 4);
    q += 12;
    if (ref & 0x80000000) throw new Error('hierarchical sidx is not supported');
    const length = ref & 0x7fffffff;
    out.push({ offset: offset, length: length, duration: dur / timescale });
    offset += length;
  }
  if (!out.length) throw new Error('sidx lists no subsegments');
  return out;
}

/* One rendition's media playlist. `uri` is the absolute address every byte
 * range is read from — the stream proxy, since the CDN wants a referer the
 * Apple TV will never send. */
function mediaPlaylist(uri, init, segments) {
  const target = Math.max(1, Math.ceil(Math.max.apply(null, segments.map((s) => s.duration))));
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-TARGETDURATION:' + target,
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-MAP:URI="' + uri + '",BYTERANGE="' + init.length + '@' + init.start + '"'
  ];
  for (const s of segments) {
    lines.push('#EXTINF:' + s.duration.toFixed(3) + ',');
    lines.push('#EXT-X-BYTERANGE:' + s.length + '@' + s.offset);
    lines.push(uri);
  }
  lines.push('#EXT-X-ENDLIST', '');
  return lines.join('\n');
}

/* "25", "23.976" or "24000/1001" → a number, or 0 when it is none of those. */
function frameRate(fr) {
  const m = /^(\d+(?:\.\d+)?)(?:\/(\d+))?$/.exec(String(fr || '').trim());
  if (!m) return 0;
  const n = Number(m[1]) / (m[2] ? Number(m[2]) : 1);
  return isFinite(n) && n > 0 ? n : 0;
}

/* The master playlist: one video variant carrying one audio rendition.
 * CODECS is not optional for fMP4 on Apple — without it Safari has been seen
 * to pick the variant and then play it silently, or not at all. */
function masterPlaylist(pick, videoUri, audioUri) {
  const v = pick.video;
  const a = pick.audio;
  const bandwidth = (Number(v.bandwidth) || 0) + (Number(a.bandwidth) || 0) || 1000000;
  const codecs = [v.codecs, a.codecs].filter(Boolean).join(',');
  const res = v.width && v.height ? ',RESOLUTION=' + v.width + 'x' + v.height : '';
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="' + audioUri + '"',
    '#EXT-X-STREAM-INF:BANDWIDTH=' + bandwidth + (codecs ? ',CODECS="' + codecs + '"' : '') + res +
      (frameRate(v.frame_rate) ? ',FRAME-RATE=' + frameRate(v.frame_rate).toFixed(3) : '') + ',AUDIO="aud"',
    videoUri,
    ''
  ].join('\n');
}

module.exports = { parseRange, parseSidx, mediaPlaylist, masterPlaylist };
