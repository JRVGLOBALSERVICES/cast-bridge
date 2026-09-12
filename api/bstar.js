/* GET /api/bstar?t=<signed-token>
 *
 * The DASH manifest for a bilibili.tv episode or user upload, built here
 * because bstar
 * does not publish one. See the header of lib/bstar for why the manifest
 * has to be generated rather than relayed.
 *
 * UNAUTHENTICATED, for the same reason /api/stream and /api/subs are: the
 * fetcher is a television. It carries no session and there is no way to give
 * it one. What stands in for a session is the token, which is signed with
 * this deploy's secret and names one episode — or one user upload — at one
 * quality for fifteen minutes. It is verified before any upstream call, so a
 * forged one costs nothing but a signature check.
 *
 * WHY IT RESOLVES AGAIN RATHER THAN CACHING. The CDN addresses inside the
 * manifest are time-limited and signed by Bilibili; the response carries an
 * `expire_at`. A manifest built when the link was pasted and fetched when
 * the film is started would be handing the television addresses that are
 * closer to expiry than they need to be. Resolving on fetch costs one API
 * call and gives the receiver the freshest addresses that exist.
 */

const bstar = require('../lib/bstar');
const hls = require('../lib/bstar-hls');

function fail(res, code, message) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ok: false, error: message }));
}

module.exports = async function handler(req, res) {
  /* A receiver fetching a manifest cross-origin sends a preflight for the
     Range header it will use on the segments. Answering it here rather than
     letting it fall through is the difference between a film that starts and
     one that fails with nothing in any log. */
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    fail(res, 405, 'Method not allowed.');
    return;
  }

  let token = null;
  let form = '';
  try {
    const q = new URL(req.url, 'http://x').searchParams;
    token = q.get('t');
    form = q.get('f') || '';
  } catch (e) { token = null; }

  const claim = bstar.readToken(token);
  if (!claim) {
    /* One message for forged, malformed and expired alike. Distinguishing
       them tells someone probing which of the three they achieved; and the
       honest reading for the one real case — a cast started more than
       fifteen minutes after the link was pasted — is the same either way. */
    fail(res, 403, 'That link is no longer valid. Paste the Bilibili TV link again.');
    return;
  }

  /* The origin is read once and used twice: the second-vantage relay lives
     on this same deploy (api/bstar-alt, pinned to hkg1), and the manifest's
     segment URLs point back at this deploy's /api/stream. */
  const origin = bstar.originOf(req);

  const play = await bstar.playurlFor(claim, claim.qn, null, origin);
  if (!play.playurl) {
    fail(res, 502, bstar.describeRefusal(play.code, null));
    return;
  }

  /* HLS for Apple — same token, same pick, byte ranges read from the sidx.
     Why this exists is in lib/bstar-hls.js. */
  if (form === 'hls' || form === 'hls-v' || form === 'hls-a') {
    await answerHls(res, req, form, token, play.playurl, claim.qn, origin);
    return;
  }

  /* The manifest's segment URLs point back at this deploy's /api/stream, so
     it has to know its own address. A manifest built against the wrong origin
     is one whose segments 404 on the television and nowhere else. */
  const built = bstar.buildManifest(play.playurl, claim.qn, origin);
  if (!built) {
    fail(res, 502, 'Bilibili TV returned no playable rendition for that one.');
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/dash+xml; charset=utf-8');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length');
  /* No shared cache. The addresses inside expire, and a proxy holding this
     for the next asker would serve a manifest whose segments 403. */
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Length', Buffer.byteLength(built.xml));
  res.end(req.method === 'HEAD' ? undefined : built.xml);
};

/* The three HLS answers. The master names two media playlists on this same
   endpoint; each media playlist reads its rendition's sidx from the CDN (a
   few kilobytes) and lists every subsegment as a byte range through
   /api/stream, which is what carries the referer the CDN insists on. */
async function answerHls(res, req, form, token, playurl, qn, origin) {
  const pick = bstar.pickRenditions(playurl, qn);
  if (!pick) {
    fail(res, 502, 'Bilibili TV returned no playable rendition for that one.');
    return;
  }
  const self = String(origin || '').replace(/\/+$/, '') + '/api/bstar?t=' + encodeURIComponent(token);
  let body;
  if (form === 'hls') {
    body = hls.masterPlaylist(pick, self + '&f=hls-v', self + '&f=hls-a');
  } else {
    const r = form === 'hls-v' ? pick.video : pick.audio;
    const sb = r.segment_base || {};
    const init = hls.parseRange(sb.range);
    const index = hls.parseRange(sb.index_range);
    if (!init || !index) {
      fail(res, 502, 'That rendition carries no byte index, so it cannot be listed for Apple.');
      return;
    }
    let segments;
    try {
      const got = await fetch(r.url, {
        headers: {
          'user-agent': bstar.UA,
          referer: bstar.REFERER,
          range: 'bytes=' + index.start + '-' + (index.start + index.length - 1)
        },
        signal: AbortSignal.timeout(15000)
      });
      if (got.status !== 206 && got.status !== 200) throw new Error('CDN answered ' + got.status);
      let buf = Buffer.from(await got.arrayBuffer());
      /* A CDN that ignores Range sends the whole file from byte 0. */
      if (got.status === 200) buf = buf.subarray(index.start, index.start + index.length);
      segments = hls.parseSidx(buf, index.start);
    } catch (e) {
      fail(res, 502, 'Could not read the film\'s index for Apple (' + (e && e.message || e) + ').');
      return;
    }
    body = hls.mediaPlaylist(bstar.proxied(origin, r.url), init, segments);
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(req.method === 'HEAD' ? undefined : body);
}
