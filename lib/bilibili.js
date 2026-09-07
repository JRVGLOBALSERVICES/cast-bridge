/* Bilibili.
 *
 * WHY IT NEEDS ITS OWN FILE. Nothing about a Bilibili page is readable the
 * way the generic scanner reads a page. The video address is not in the
 * HTML, it is behind a signed API call; the page itself answers 412 to this
 * app's hosts, which is Bilibili's risk control refusing datacentre traffic;
 * and the address the API hands back is on a CDN that checks the referer.
 * So this resolves through the API instead of parsing anything.
 *
 * WHAT IS AND IS NOT REACHABLE. Measured from both hosts this app runs on,
 * 2026-09-07:
 *
 *   www.bilibili.com/video/<bvid>          412   risk control
 *   api /x/web-interface/view              412   risk control
 *   api /x/player/pagelist                 200   ← the cid comes from here
 *   api /x/player/playurl                  200   ← and the address from here
 *   api /x/web-interface/nav               200
 *   passport /x/passport-login/web/qrcode  200
 *
 * The two that are blocked are the two the obvious implementation would
 * reach for. pagelist gives the cid, the title and the duration without
 * touching either, which is the whole reason this works at all.
 *
 * QUALITY. platform=html5 returns a single progressive mp4, which is the one
 * shape a television can be handed as one address. The alternative — the
 * DASH response — is separate video and audio streams that a browser
 * assembles, and no Cast receiver will do that. The mp4 form caps at 720p
 * even for a signed-in account. That is the ceiling of casting Bilibili at
 * all, not a shortcut taken here.
 */

const { safeFetch } = require('./media');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/* Every CDN address Bilibili hands out checks this. Sending the CDN's own
   origin instead — which is what a generic proxy would derive — is a 403. */
const REFERER = 'https://www.bilibili.com/';

const API = 'https://api.bilibili.com';
const PASSPORT = 'https://passport.bilibili.com';

const TIMEOUT_MS = 10000;

function isBilibiliHost(host) {
  return /(^|\.)bilibili\.com$/i.test(host) || /^b23\.tv$/i.test(host);
}

/* bilibili.com/video/BV1xx411c7mD?p=3, and the b23.tv short form which has
   to be followed before anything can be read out of it. */
function parseTarget(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch (e) { return null; }
  if (!isBilibiliHost(u.hostname)) return null;

  if (/^b23\.tv$/i.test(u.hostname)) return { short: urlStr };

  const m = /\/video\/(BV[0-9A-Za-z]{10})/.exec(u.pathname);
  if (!m) return null;
  const page = Number(u.searchParams.get('p')) || 1;
  return { bvid: m[1], page: page > 0 ? page : 1 };
}

async function get(url, cookie) {
  const headers = {
    'user-agent': UA,
    referer: REFERER,
    accept: 'application/json, text/plain, */*'
  };
  if (cookie) headers.cookie = cookie;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal, redirect: 'follow' });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (e) { body = null; }
    return { status: res.status, body: body, text: text, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

/* A b23.tv link is a redirect and nothing else. safeFetch already refuses
   private addresses and follows a bounded number of hops, so the long form
   comes back from it without this file needing its own guard. */
async function expandShort(urlStr) {
  try {
    const { url } = await safeFetch(urlStr, { method: 'HEAD' });
    return url;
  } catch (e) {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Resolving one video
 * ------------------------------------------------------------------ */

const QUALITY_NAMES = {
  6: '240p', 16: '360p', 32: '480p', 64: '720p', 74: '720p60',
  80: '1080p', 112: '1080p+', 116: '1080p60', 120: '4K'
};

async function resolve(urlStr, cookie) {
  let target = parseTarget(urlStr);
  if (!target) return null;

  if (target.short) {
    const long = await expandShort(target.short);
    if (!long) {
      return { ok: false, error: 'That b23.tv link did not lead anywhere.' };
    }
    target = parseTarget(long);
    if (!target || !target.bvid) {
      return { ok: false, error: 'That b23.tv link is not a video.' };
    }
  }

  const pages = await get(API + '/x/player/pagelist?bvid=' + encodeURIComponent(target.bvid), cookie);
  if (pages.status === 412) {
    return {
      ok: false,
      error: 'Bilibili is refusing this server (412 — its risk control blocks ' +
        'traffic from data centres). Nothing here can get past that.'
    };
  }
  if (!pages.body || pages.body.code !== 0 || !Array.isArray(pages.body.data) || !pages.body.data.length) {
    return {
      ok: false,
      error: pages.body && pages.body.message
        ? 'Bilibili said: ' + pages.body.message
        : 'Bilibili would not say what is on that page.'
    };
  }

  const list = pages.body.data;
  const part = list[Math.min(target.page, list.length) - 1] || list[0];
  const title = (list.length > 1 && part.part) ? part.part : (part.part || target.bvid);

  /* qn is a request, not an instruction: without a signed-in cookie the
     answer comes back at 360p whatever is asked for, and saying 80 costs
     nothing when it is refused. */
  const play = await get(API + '/x/player/playurl' +
    '?bvid=' + encodeURIComponent(target.bvid) +
    '&cid=' + encodeURIComponent(part.cid) +
    '&qn=80&fnval=1&fourk=1&platform=html5&high_quality=1', cookie);

  if (play.status === 412) {
    return { ok: false, error: 'Bilibili refused this server (412).' };
  }
  if (!play.body || play.body.code !== 0 || !play.body.data) {
    const msg = play.body && play.body.message;
    /* -404 here is almost always the members-only case, and saying "not
       found" about a video that is plainly there is the wrong sentence. */
    if (play.body && play.body.code === -404) {
      return {
        ok: false,
        error: cookie
          ? 'Bilibili will not serve that one to this account — it is likely ' +
            'members-only or region-locked.'
          : 'Bilibili will not serve that one to a signed-out request. Sign in ' +
            'to Bilibili below and try again.'
      };
    }
    return { ok: false, error: msg ? 'Bilibili said: ' + msg : 'Bilibili would not give an address for it.' };
  }

  const data = play.body.data;
  const durl = Array.isArray(data.durl) ? data.durl : [];
  if (!durl.length) {
    return { ok: false, error: 'Bilibili returned no playable address for that.' };
  }

  /* A multi-segment durl is one video split across several files. There is
     no single address for it, so a television cannot be handed it — say
     that rather than casting the first few minutes and stopping. */
  if (durl.length > 1) {
    return {
      ok: false,
      error: 'Bilibili splits that one into ' + durl.length + ' separate files, ' +
        'and a television can only be handed one address. It plays here but ' +
        'cannot be cast.'
    };
  }

  const quality = QUALITY_NAMES[data.quality] || (data.quality ? 'q' + data.quality : '');
  const pageUrl = 'https://www.bilibili.com/video/' + target.bvid +
    (target.page > 1 ? '?p=' + target.page : '');

  return {
    ok: true,
    finalUrl: pageUrl,
    title: title,
    /* Both of these matter downstream. `from` becomes the referer the stream
       proxy sends, without which the CDN answers 403; `viaProxy` is what
       stops the app handing the television a naked CDN address that it would
       then be refused at. */
    referer: REFERER,
    signedIn: Boolean(cookie),
    media: [{
      url: durl[0].url,
      kind: 'MP4',
      label: title + (quality ? ' · ' + quality : ''),
      detail: 'Bilibili' + (quality ? ' · ' + quality : '') +
        (durl[0].size ? ' · ' + Math.round(durl[0].size / 1e6) + ' MB' : ''),
      bytes: durl[0].size || 0,
      seconds: Math.round((data.timelength || 0) / 1000) || null,
      viaProxy: true
    }]
  };
}

/* ------------------------------------------------------------------ *
 * Signing in
 *
 * The QR flow, which is the only web login Bilibili offers that does not
 * involve a captcha. generate hands back a key and a URL; poll answers with
 * a code until the phone confirms, and then with Set-Cookie headers.
 * ------------------------------------------------------------------ */

async function qrStart() {
  const r = await get(PASSPORT + '/x/passport-login/web/qrcode/generate');
  if (!r.body || r.body.code !== 0 || !r.body.data) {
    return { ok: false, error: 'Bilibili would not start a sign-in.' };
  }
  return { ok: true, key: r.body.data.qrcode_key, url: r.body.data.url };
}

const POLL_STATES = {
  0: 'ok',
  86038: 'expired',
  86090: 'scanned',   // scanned, waiting for the tap on the phone
  86101: 'waiting'
};

/* Only these three are kept. Bilibili sets a dozen cookies and the rest are
   tracking; carrying them would mean storing more of someone's account than
   is needed to ask for a video address. */
const KEEP = ['SESSDATA', 'bili_jct', 'DedeUserID'];

function cookiesFrom(headers) {
  const raw = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : (headers.raw ? (headers.raw()['set-cookie'] || []) : []);
  const out = {};
  for (const line of raw) {
    const pair = String(line).split(';')[0];
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const name = pair.slice(0, eq).trim();
    if (KEEP.indexOf(name) === -1) continue;
    out[name] = pair.slice(eq + 1).trim();
  }
  return out;
}

async function qrPoll(key) {
  if (!key || !/^[0-9a-f]{16,64}$/i.test(String(key))) {
    return { ok: false, error: 'That sign-in has gone. Start another.' };
  }
  const r = await get(PASSPORT + '/x/passport-login/web/qrcode/poll?qrcode_key=' +
    encodeURIComponent(key));
  if (!r.body || r.body.code !== 0 || !r.body.data) {
    return { ok: false, error: 'Bilibili would not say how the sign-in is going.' };
  }
  const state = POLL_STATES[r.body.data.code] || 'waiting';
  if (state !== 'ok') return { ok: true, state: state };

  const jar = cookiesFrom(r.headers);
  if (!jar.SESSDATA) {
    return { ok: false, error: 'Bilibili confirmed the sign-in but sent no session.' };
  }
  return { ok: true, state: 'ok', cookies: jar };
}

function cookieHeader(jar) {
  if (!jar) return '';
  return KEEP.filter((k) => jar[k]).map((k) => k + '=' + jar[k]).join('; ');
}

/* A sign-in that was pasted rather than scanned.
 *
 * The QR is a two-device flow by construction: the code is on one screen
 * and the camera is on another. With one phone there is no second screen,
 * and the Bilibili app has no address bar, so the sign-in address this
 * panel used to offer for copying had nowhere on earth to be pasted. This
 * is the other end of it — sign in to bilibili.com in any browser, copy the
 * cookie, paste it here.
 *
 * Takes anything that CONTAINS the names, because what a person actually
 * has on the clipboard varies: a whole document.cookie dump, one
 * "SESSDATA=…" pair, a `curl -b` string, the three values on three lines.
 * Only the three in KEEP are read out; the rest of the paste is dropped on
 * the floor rather than stored, which matters because a document.cookie
 * dump from bilibili.com carries a dozen tracking values too.
 *
 * Values are kept exactly as pasted. SESSDATA arrives percent-encoded and a
 * Cookie header wants it that way — decoding it here would produce a
 * session Bilibili does not recognise.
 */
/* A cookies.txt file, in the Netscape format every "export cookies" browser
 * extension writes: seven tab-separated fields a line, name and value last.
 * The regex below cannot read one, because a Netscape line puts a TAB where
 * a Cookie header puts an "=". So the export people are most often told to
 * make was the one shape this refused — checked against a well-formed
 * signed-in bilibili.com export, which came back null before this existed.
 *
 * Domain matters here in a way it does not for a pasted header. bilibili.tv
 * is Bilibili's international site and a separate sign-in from bilibili.com;
 * its cookies authenticate nothing at api.bilibili.com — measured, an
 * identical -101 with them and without. So .tv lines are read for the
 * diagnosis below and never for credentials.
 */
function netscapeLines(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    /* #HttpOnly_ is how several extensions mark the flag, and SESSDATA is
       always HttpOnly, so stripping that prefix is load-bearing rather than
       tidy. Every other # line is a comment. */
    const bare = line.replace(/^#HttpOnly_/, '');
    if (bare === line && line[0] === '#') continue;
    const f = bare.split('\t');
    if (f.length < 7) continue;
    out.push({ domain: f[0].trim().toLowerCase(), name: f[5].trim(), value: f[6].trim() });
  }
  return out;
}

function parseCookieText(text) {
  if (!text || typeof text !== 'string' || text.length > 262144) return null;

  const jar = {};

  /* Netscape first, because it is the only shape that carries its own
     domain, and a whole-browser export can hold a SESSDATA belonging to
     something else. Scoped to bilibili.com on purpose. */
  for (const row of netscapeLines(text)) {
    if (row.domain.indexOf('bilibili.com') === -1) continue;
    if (KEEP.indexOf(row.name) === -1 || !row.value) continue;
    jar[row.name] = row.value;
  }

  for (const name of KEEP) {
    if (jar[name]) continue;
    const re = new RegExp('(?:^|[;,\\s])' + name + '\\s*[=:]\\s*"?([^;,"\\s]+)', 'i');
    const m = re.exec(text);
    if (m) jar[name] = m[1];
  }

  /* A bare SESSDATA with its name left behind. It is the one value with a
     shape distinctive enough to recognise on its own — two commas, encoded
     or not, and a trailing *n — so a paste of just that is understood
     rather than refused on a technicality. */
  if (!jar.SESSDATA) {
    const bare = text.trim();
    if (/^[A-Za-z0-9%_\-*.]+$/.test(bare) &&
        bare.length >= 24 && bare.length <= 512 &&
        (bare.match(/%2C/gi) || []).length >= 2) {
      jar.SESSDATA = bare;
    }
  }

  return jar.SESSDATA ? jar : null;
}

/* Why a paste was refused, when the reason is knowable from the paste.
 * "No SESSDATA in that" is true of every refusal and useful in none of
 * them — it sends someone back to copy the same thing a second time. A
 * cookies.txt carries its own domains, so these two cases can be named:
 * the wrong Bilibili, and the right one while signed out. */
function diagnoseCookieText(text) {
  if (!text || typeof text !== 'string') return null;
  /* Only refusals have a reason. The handler asks after a null parse and
     nowhere else, but a file holding both sites would otherwise be told it
     carries no session while carrying one, so the guard is here rather
     than resting on the one caller. */
  if (parseCookieText(text)) return null;
  const rows = netscapeLines(text);
  if (!rows.length) return null;

  const tv = rows.some((r) => r.domain.indexOf('bilibili.tv') !== -1);
  const com = rows.some((r) => r.domain.indexOf('bilibili.com') !== -1);

  if (tv && !com) {
    return 'That export is from bilibili.tv. It is Bilibili’s international ' +
      'site and a separate sign-in from bilibili.com, so its cookies will not ' +
      'work here. Open bilibili.com, sign in there, and export again.';
  }
  if (com) {
    return 'That export is from bilibili.com but carries no SESSDATA. Either ' +
      'the browser was signed out when it was made, or the extension skipped ' +
      'HttpOnly cookies, and SESSDATA is one. Sign in, check your name shows on ' +
      'the page, then export again.';
  }
  return null;
}

/* Who the stored session belongs to, or null if it has lapsed. Bilibili
   sessions outlive most things and then stop working silently, so the panel
   asks rather than assuming the cookie it holds still means anything. */
async function whoami(cookie) {
  if (!cookie) return null;
  const r = await get(API + '/x/web-interface/nav', cookie);
  const d = r.body && r.body.data;
  if (!d || !d.isLogin) return null;
  return { name: d.uname || 'signed in', vip: Boolean(d.vipStatus) };
}

module.exports = {
  UA, REFERER, isBilibiliHost, parseTarget, resolve,
  qrStart, qrPoll, cookieHeader, parseCookieText, diagnoseCookieText, whoami, KEEP
};

/* ------------------------------------------------------------------ *
 * Where the Bilibili session is kept
 *
 * In a signed HttpOnly cookie on this app's own origin, not in the
 * database. Three reasons, in order: it is somebody's Bilibili account and
 * this app has no business holding it server-side; it is under 300 bytes,
 * so a cookie is the right size of container; and it needs no migration,
 * which means no schema to keep in step with a feature that may not survive
 * Bilibili's next change to its risk control.
 *
 * Signed with the same secret the session cookie uses, derived in exactly
 * one place — lib/auth's own. A missing secret fails shut, so an unsigned
 * deploy cannot be talked into accepting a jar someone else wrote.
 * ------------------------------------------------------------------ */

const crypto = require('crypto');
const auth = require('./auth');

const JAR_COOKIE = 'cb_bili';
const JAR_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function jarSign(body) {
  const s = auth.secret();
  if (!s) return null;
  return crypto.createHmac('sha256', s).update('bili|' + body).digest('base64url');
}

function sealJar(jar) {
  const kept = {};
  KEEP.forEach((k) => { if (jar && jar[k]) kept[k] = String(jar[k]); });
  if (!kept.SESSDATA) return null;
  const body = Buffer.from(JSON.stringify({
    j: kept, exp: Date.now() + JAR_TTL_MS
  })).toString('base64url');
  const sig = jarSign(body);
  return sig ? body + '.' + sig : null;
}

function unsealJar(token) {
  if (!token || typeof token !== 'string' || token.length > 4096) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = jarSign(body);
  if (!expected) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!parsed || !parsed.j || !parsed.j.SESSDATA) return null;
  if (!parsed.exp || parsed.exp <= Date.now()) return null;
  return parsed.j;
}

/* The jar for whoever is asking, as a Cookie header value, or ''. */
function jarFromRequest(req) {
  return cookieHeader(unsealJar(auth.readCookie(req, JAR_COOKIE)));
}

function setJarHeader(jar) {
  const sealed = sealJar(jar);
  if (!sealed) return null;
  const bits = [
    JAR_COOKIE + '=' + encodeURIComponent(sealed),
    'Path=/', 'HttpOnly', 'SameSite=Lax',
    'Max-Age=' + Math.floor(JAR_TTL_MS / 1000)
  ];
  if (!process.env.CAST_INSECURE_COOKIE) bits.splice(3, 0, 'Secure');
  return bits.join('; ');
}

function clearJarHeader() {
  const secure = process.env.CAST_INSECURE_COOKIE ? '' : ' Secure;';
  return JAR_COOKIE + '=; Path=/; HttpOnly;' + secure + ' SameSite=Lax; Max-Age=0';
}

module.exports.JAR_COOKIE = JAR_COOKIE;
module.exports.sealJar = sealJar;
module.exports.unsealJar = unsealJar;
module.exports.jarFromRequest = jarFromRequest;
module.exports.setJarHeader = setJarHeader;
module.exports.clearJarHeader = clearJarHeader;
