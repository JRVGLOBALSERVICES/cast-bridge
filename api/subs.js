/* GET /api/subs?u=<subtitle-file>
 *
 * Fetches a subtitle file, converts it to WebVTT, and re-serves it with the
 * cross-origin header a television needs. This exists because the Cast
 * receiver fetches the track itself, from its own address, and will take
 * only VTT served CORS-open — while the subtitle files people actually have
 * are SRTs on hosts that send no CORS header at all. Without this hop the
 * subtitle button lights up and the TV silently shows nothing.
 *
 * Deliberately unauthenticated: the thing doing the fetching is a
 * Chromecast, which carries no session and cannot be made to. What keeps
 * that honest is that it is not a general proxy — every hop is checked
 * against private address space by safeFetch, the body is capped, and the
 * only thing it can ever emit is text/vtt built by our own parser. An
 * address that answers with something which is not subtitle-shaped is
 * refused rather than passed through.
 */

const { safeFetch, readCapped } = require('../lib/media');
const { toVtt, looksLikeSubtitles } = require('../lib/subs');

function fail(res, status, message) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ok: false, error: message }));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    fail(res, 405, 'Use GET.');
    return;
  }

  const raw = (req.query && req.query.u) ||
    new URL(req.url, 'http://localhost').searchParams.get('u');

  if (!raw) {
    fail(res, 400, 'No subtitle address given.');
    return;
  }

  let target = String(raw).trim();
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;

  let source;
  try {
    const { res: subRes } = await safeFetch(target, 'text/vtt,application/x-subrip,text/plain,*/*;q=0.8');

    if (!subRes.ok) {
      fail(res, 502, 'That subtitle file answered ' + subRes.status + '.');
      return;
    }

    /* A host that hands back its own web page instead of the file is the
       usual shape of a dead or moved link, and it parses as zero cues.
       Say so here rather than let it read as "the file was empty". */
    const type = (subRes.headers.get('content-type') || '').toLowerCase();
    if (type.includes('text/html')) {
      fail(res, 415, 'That address is a web page, not a subtitle file.');
      return;
    }

    source = await readCapped(subRes);
  } catch (e) {
    fail(res, 502, (e && e.message) || "That subtitle file couldn't be reached.");
    return;
  }

  if (!looksLikeSubtitles(source)) {
    fail(res, 415, "That doesn't look like a subtitle file — it needs to be .srt or .vtt.");
    return;
  }

  let converted;
  try {
    converted = toVtt(source);
  } catch (e) {
    fail(res, 422, (e && e.message) || 'That subtitle file could not be read.');
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('X-Subtitle-Cues', String(converted.cues));
  res.setHeader('Access-Control-Expose-Headers', 'X-Subtitle-Cues');
  /* The receiver may refetch on a seek or a reconnect; a subtitle file for
     a given address does not change under it. */
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.end(req.method === 'HEAD' ? undefined : converted.vtt);
};
