/* GET /api/probe?url=<stream>&from=<page>
 *
 * Answers the two questions a list of streams never answered: how long is
 * it, and how big. The scan finds addresses; this reads what is at them.
 *
 * Deliberately a separate call from the scan. The scan already spends a
 * browser and most of its budget getting the addresses at all, and a row
 * that arrives without its size is still a row you can play. So the list
 * renders first and each row fills itself in — one probe per row, in
 * parallel, none of them blocking the thing the person came for.
 *
 * Every number here is either measured or marked as an estimate. A live
 * stream has no size and gets none; a playlist whose segments we sampled
 * says so. Nothing is guessed and presented as fact — a wrong "1.8 GB"
 * is worse than an honest dash.
 */

const {
  assertPublic, safeFetch, kindOf, absolute, walledService
} = require('../lib/media');
const auth = require('../lib/auth');

const PROBE_TIMEOUT_MS = 8000;
const MAX_PLAYLIST_BYTES = 512 * 1024;
const MP4_HEAD_BYTES = 96 * 1024;
const MP4_TAIL_BYTES = 512 * 1024;
const SEGMENT_SAMPLES = 3;
const MAX_VARIANTS = 24;

/* A CDN that wants the embed page as its referer will refuse a bare
   request, exactly as it does for the segments themselves. Send the page
   the address came from, the same way the stream proxy does. */
function refererHeaders(from) {
  if (!from) return {};
  let origin;
  try { origin = new URL(from).origin; } catch (e) { return {}; }
  return { referer: from, origin: origin };
}

function drop(res) {
  try { if (res && res.body && res.body.cancel) res.body.cancel(); } catch (e) { /* closed */ }
}

/* ------------------------------------------------------------------ *
 * Size — asked for one byte, told the total
 *
 * HEAD is the obvious way and the unreliable one: plenty of media CDNs
 * answer it with 405, or with a Content-Length they made up. A one-byte
 * range is answered by anything that can serve video at all, and the
 * Content-Range it comes back with carries the real total.
 * ------------------------------------------------------------------ */
async function totalBytes(url, from) {
  let res;
  try {
    const r = await safeFetch(url, '*/*', {
      timeoutMs: PROBE_TIMEOUT_MS,
      headers: Object.assign({ range: 'bytes=0-0' }, refererHeaders(from))
    });
    res = r.res;
  } catch (e) {
    return null;
  }

  const range = res.headers.get('content-range');
  const length = res.headers.get('content-length');
  const status = res.status;
  drop(res);

  if (status === 206 && range) {
    const m = /\/(\d+)\s*$/.exec(range);
    if (m) return Number(m[1]);
  }
  /* Range ignored: the body IS the whole file, so its length is the size. */
  if (status === 200 && length) {
    const n = Number(length);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

async function fetchText(url, from, accept) {
  const { res, url: finalUrl } = await safeFetch(url, accept || '*/*', {
    timeoutMs: PROBE_TIMEOUT_MS,
    headers: refererHeaders(from)
  });
  if (!res.ok) { drop(res); throw new Error('That address answered ' + res.status + '.'); }
  const buf = Buffer.from(await res.arrayBuffer());
  return { text: buf.slice(0, MAX_PLAYLIST_BYTES).toString('utf8'), url: finalUrl };
}

/* ------------------------------------------------------------------ *
 * HLS
 * ------------------------------------------------------------------ */

function parseMaster(text, baseUrl) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
    const dims = /RESOLUTION=(\d+)x(\d+)/i.exec(line);
    const peak = (/[^-]BANDWIDTH=(\d+)/i.exec(' ' + line) || [])[1];
    const avg = (/AVERAGE-BANDWIDTH=(\d+)/i.exec(line) || [])[1];
    let next = '';
    for (let j = i + 1; j < lines.length; j++) {
      const cand = lines[j].trim();
      if (!cand) continue;
      if (cand.startsWith('#')) continue;
      next = cand;
      break;
    }
    if (!next) continue;
    const abs = absolute(next, baseUrl);
    if (!abs) continue;
    out.push({
      url: abs,
      width: dims ? Number(dims[1]) : null,
      height: dims ? Number(dims[2]) : null,
      bandwidth: peak ? Number(peak) : null,
      avgBandwidth: avg ? Number(avg) : null
    });
    if (out.length >= MAX_VARIANTS) break;
  }
  return out;
}

function parseMediaPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  let duration = 0;
  const segments = [];
  let pendingExtinf = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const n = parseFloat(line.slice(8));
      if (Number.isFinite(n)) duration += n;
      pendingExtinf = true;
      continue;
    }
    if (line.startsWith('#')) continue;
    if (pendingExtinf) {
      const abs = absolute(line, baseUrl);
      if (abs) segments.push(abs);
      pendingExtinf = false;
    }
  }

  return {
    duration: duration > 0 ? duration : null,
    segments: segments,
    live: !/#EXT-X-ENDLIST/.test(text)
  };
}

/* Three segments spread across the playlist, one byte requested from each.
   Their average times the segment count is a real measurement of a real
   file, which is why it is preferred over the playlist's own declared
   BANDWIDTH — that number is a ceiling the encoder promised not to
   exceed, not what the film actually weighs. */
async function sampleSegments(segments, from) {
  if (!segments.length) return null;
  const picks = [];
  const step = Math.max(1, Math.floor(segments.length / SEGMENT_SAMPLES));
  for (let i = 0; i < segments.length && picks.length < SEGMENT_SAMPLES; i += step) {
    picks.push(segments[i]);
  }
  const sizes = await Promise.all(picks.map((s) => totalBytes(s, from).catch(() => null)));
  const good = sizes.filter((n) => Number.isFinite(n) && n > 0);
  if (!good.length) return null;
  return good.reduce((a, b) => a + b, 0) / good.length;
}

async function probeMediaPlaylist(url, from, bitrate) {
  const { text, url: finalUrl } = await fetchText(
    url, from, 'application/vnd.apple.mpegurl,*/*');
  if (!/#EXTM3U/.test(text)) throw new Error('That address is not a playlist.');

  const parsed = parseMediaPlaylist(text, finalUrl);
  const out = {
    duration: parsed.duration,
    live: parsed.live,
    segments: parsed.segments.length,
    bytes: null,
    bytesBasis: null
  };

  /* A live stream has no length and no size. Estimating one would be a
     number about a thing that has not finished happening. */
  if (parsed.live || !parsed.duration) return out;

  const avgSegment = await sampleSegments(parsed.segments, from);
  if (avgSegment) {
    out.bytes = Math.round(avgSegment * parsed.segments.length);
    out.bytesBasis = 'sampled';
  } else if (bitrate) {
    out.bytes = Math.round((bitrate / 8) * parsed.duration);
    out.bytesBasis = 'bitrate';
  }
  return out;
}

async function probeHls(url, from) {
  const { text, url: finalUrl } = await fetchText(
    url, from, 'application/vnd.apple.mpegurl,*/*');
  if (!/#EXTM3U/.test(text)) throw new Error('That address is not a playlist.');

  if (!/#EXT-X-STREAM-INF/.test(text)) {
    const media = await probeMediaPlaylist(finalUrl, from, null);
    return Object.assign({ kind: 'HLS', master: false, variants: 0 }, media);
  }

  const variants = parseMaster(text, finalUrl)
    .sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
  const best = variants[0];
  const out = {
    kind: 'HLS',
    master: true,
    variants: variants.length,
    width: best ? best.width : null,
    height: best ? best.height : null,
    bandwidth: best ? (best.avgBandwidth || best.bandwidth) : null,
    duration: null,
    live: null,
    segments: 0,
    bytes: null,
    bytesBasis: null
  };
  if (!best) return out;

  try {
    const media = await probeMediaPlaylist(
      best.url, from, best.avgBandwidth || best.bandwidth);
    out.duration = media.duration;
    out.live = media.live;
    out.segments = media.segments;
    out.bytes = media.bytes;
    out.bytesBasis = media.bytesBasis;
  } catch (e) { /* the master still told us the quality ladder */ }
  return out;
}

/* ------------------------------------------------------------------ *
 * DASH
 * ------------------------------------------------------------------ */

/* ISO 8601 duration, the subset MPEG-DASH actually emits. */
function iso8601Seconds(s) {
  const m = /^P(?:([\d.]+)Y)?(?:([\d.]+)M)?(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?$/i
    .exec(String(s).trim());
  if (!m) return null;
  const n = (x) => (x ? parseFloat(x) : 0);
  const total = n(m[1]) * 31536000 + n(m[2]) * 2592000 + n(m[3]) * 86400 +
    n(m[4]) * 3600 + n(m[5]) * 60 + n(m[6]);
  return total > 0 ? total : null;
}

async function probeDash(url, from) {
  const { text } = await fetchText(url, from, 'application/dash+xml,*/*');
  const dur = (/mediaPresentationDuration\s*=\s*"([^"]+)"/i.exec(text) || [])[1];
  const dims = /width\s*=\s*"(\d+)"[^>]*height\s*=\s*"(\d+)"/i.exec(text);
  const live = /type\s*=\s*"dynamic"/i.test(text);
  return {
    kind: 'DASH',
    duration: dur ? iso8601Seconds(dur) : null,
    live: live,
    width: dims ? Number(dims[1]) : null,
    height: dims ? Number(dims[2]) : null,
    bytes: null,
    bytesBasis: null,
    segments: 0,
    variants: (text.match(/<Representation\b/gi) || []).length
  };
}

/* ------------------------------------------------------------------ *
 * Progressive files
 *
 * An mp4 keeps its length in the mvhd box inside moov. A file written for
 * streaming puts moov at the front; one written by an ordinary encoder
 * puts it at the very end. Both are one ranged read, so try the front and
 * then the back rather than downloading a film to time it.
 * ------------------------------------------------------------------ */

function mvhdDuration(buf) {
  const at = buf.indexOf('mvhd', 0, 'latin1');
  if (at < 0) return null;
  const version = buf[at + 4];
  try {
    if (version === 1) {
      if (at + 36 > buf.length) return null;
      const timescale = buf.readUInt32BE(at + 24);
      const hi = buf.readUInt32BE(at + 28);
      const lo = buf.readUInt32BE(at + 32);
      const ticks = hi * 4294967296 + lo;
      if (!timescale || !ticks) return null;
      return ticks / timescale;
    }
    if (at + 24 > buf.length) return null;
    const timescale = buf.readUInt32BE(at + 16);
    const ticks = buf.readUInt32BE(at + 20);
    if (!timescale || !ticks) return null;
    return ticks / timescale;
  } catch (e) {
    return null;
  }
}

async function rangeBuffer(url, from, start, end) {
  let res;
  try {
    const r = await safeFetch(url, '*/*', {
      timeoutMs: PROBE_TIMEOUT_MS,
      headers: Object.assign(
        { range: 'bytes=' + start + '-' + end }, refererHeaders(from))
    });
    res = r.res;
  } catch (e) {
    return null;
  }
  if (res.status !== 206 && res.status !== 200) { drop(res); return null; }
  try {
    const buf = Buffer.from(await res.arrayBuffer());
    /* A server that ignored the range hands back the whole file; cap what
       we keep so a 2 GB mp4 cannot land in a function's memory. */
    return buf.length > MP4_TAIL_BYTES * 2 ? buf.slice(0, MP4_TAIL_BYTES * 2) : buf;
  } catch (e) {
    return null;
  }
}

async function probeFile(url, from, kind) {
  const bytes = await totalBytes(url, from);
  const out = {
    kind: kind,
    duration: null,
    live: false,
    bytes: bytes,
    bytesBasis: bytes ? 'measured' : null,
    width: null,
    height: null,
    segments: 0,
    variants: 0
  };

  if (!/^(MP4|M4V|MOV|M4A)$/i.test(kind)) return out;

  const head = await rangeBuffer(url, from, 0, MP4_HEAD_BYTES - 1);
  if (head) {
    const d = mvhdDuration(head);
    if (d) { out.duration = d; return out; }
  }
  if (bytes && bytes > MP4_TAIL_BYTES) {
    const tail = await rangeBuffer(url, from, bytes - MP4_TAIL_BYTES, bytes - 1);
    if (tail) {
      const d = mvhdDuration(tail);
      if (d) out.duration = d;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Handler
 * ------------------------------------------------------------------ */

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: 'Use GET.' }));
    return;
  }

  const user = await auth.guard(req, res);
  if (!user) return;

  const params = new URL(req.url, 'http://localhost').searchParams;
  const raw = (req.query && req.query.url) || params.get('url');
  const from = (req.query && req.query.from) || params.get('from') || null;

  if (!raw) {
    res.statusCode = 400;
    res.end(JSON.stringify({ ok: false, error: 'No address given.' }));
    return;
  }

  let target = String(raw).trim();
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;

  if (walledService(target)) {
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: false, error: 'That service is not readable from here.' }));
    return;
  }

  try {
    await assertPublic(target);
  } catch (err) {
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: false, error: err.message }));
    return;
  }

  const kind = kindOf(target);
  try {
    let info;
    if (kind === 'HLS') info = await probeHls(target, from);
    else if (kind === 'DASH') info = await probeDash(target, from);
    else info = await probeFile(target, from, kind);

    res.statusCode = 200;
    res.end(JSON.stringify(Object.assign({ ok: true, url: target }, info)));
  } catch (err) {
    res.statusCode = 200;
    res.end(JSON.stringify({
      ok: false,
      url: target,
      kind: kind,
      error: (err && err.message) || 'That address could not be read.'
    }));
  }
};

module.exports.parseMaster = parseMaster;
module.exports.parseMediaPlaylist = parseMediaPlaylist;
module.exports.mvhdDuration = mvhdDuration;
module.exports.iso8601Seconds = iso8601Seconds;
