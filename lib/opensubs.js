/* Subtitle search against OpenSubtitles.
 *
 * Two doors to the same catalogue:
 *
 *   rest.opensubtitles.org   the legacy REST search. Keyless — it asks only
 *                            for a User-Agent — and its download links are
 *                            gzipped files fetched by numeric id.
 *   api.opensubtitles.com    the current API. Needs OPENSUBTITLES_API_KEY and
 *                            spends a daily download quota per key.
 *
 * The legacy door is tried first because it needs nothing configured; the
 * keyed one is the fallback when it refuses (it rate-limits and has blocked
 * cloud address ranges before). Without a key a legacy failure is the answer.
 *
 * Proved from the VPS 2026-09-15: a title search returns JSON, the filead
 * download works by id alone without the vrf token, and path segments must
 * be in alphabetical order (episode, query, season, sublanguageid) — any
 * other order is answered with a bare 302.
 */

const zlib = require('zlib');

const LEGACY = 'https://rest.opensubtitles.org/search/';
const LEGACY_DL = 'https://dl.opensubtitles.org/en/download/filead/';
const API = 'https://api.opensubtitles.com/api/v1/';
const UA = 'TemporaryUserAgent';          // the legacy API's documented keyless agent
const TIMEOUT_MS = 8000;
const MAX_RESULTS = 25;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/* The languages offered in the picker. `os` is the legacy three-letter id,
   `iso` what the current API takes. Kept short on purpose: the people this
   app is sold to watch in these, and a 60-row select on a phone is a scroll
   nobody finishes. */
const LANGUAGES = [
  { os: 'eng', iso: 'en', name: 'English' },
  { os: 'may', iso: 'ms', name: 'Malay' },
  { os: 'ind', iso: 'id', name: 'Indonesian' },
  { os: 'chi', iso: 'zh-CN', name: 'Chinese (simplified)' },
  { os: 'zht', iso: 'zh-TW', name: 'Chinese (traditional)' },
  { os: 'tam', iso: 'ta', name: 'Tamil' },
  { os: 'hin', iso: 'hi', name: 'Hindi' },
  { os: 'ara', iso: 'ar', name: 'Arabic' },
  { os: 'jpn', iso: 'ja', name: 'Japanese' },
  { os: 'kor', iso: 'ko', name: 'Korean' },
  { os: 'tha', iso: 'th', name: 'Thai' },
  { os: 'vie', iso: 'vi', name: 'Vietnamese' },
  { os: 'spa', iso: 'es', name: 'Spanish' },
  { os: 'fre', iso: 'fr', name: 'French' }
];

function language(code) {
  const c = String(code || '').toLowerCase();
  return LANGUAGES.find((l) => l.os === c || l.iso.toLowerCase() === c) || null;
}

/* "Breaking Bad S01E02 720p WEB" → title "Breaking Bad", season 1, episode 2.
   Film titles as they arrive here are file names and page titles, so the
   release junk after the name is stripped: a search for the whole string
   finds nothing, and asking the person to tidy it is the step they skip. */
function parseTitle(raw) {
  let s = String(raw || '').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[._]+/g, ' ');
  let season = null;
  let episode = null;

  const se = s.match(/\bS(\d{1,2})\s*E(\d{1,3})\b/i) || s.match(/\b(\d{1,2})x(\d{1,3})\b/i);
  if (se) {
    season = Number(se[1]);
    episode = Number(se[2]);
    s = s.slice(0, se.index);
  } else {
    const ep = s.match(/\b(?:season|musim)\s*(\d{1,2}).*?\b(?:episode|ep|episod)\s*(\d{1,3})\b/i);
    if (ep) {
      season = Number(ep[1]);
      episode = Number(ep[2]);
      s = s.slice(0, ep.index);
    }
  }

  s = s
    .replace(/[\[(](?:19|20)\d{2}[\])].*$/, '')                // "(2009) …"
    .replace(/\b(?:19|20)\d{2}\b(?=.*\b(?:\d{3,4}p|web|bluray|hdrip|dvdrip|x26[45]|hevc)\b).*$/i, '')
    .replace(/\b(?:\d{3,4}p|web[- ]?dl|webrip|bluray|brrip|hdrip|dvdrip|x26[45]|hevc|aac|hdtv)\b.*$/i, '')
    .replace(/\s*[-|–—]\s*(?:watch|nonton|streaming|bilibili).*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s(?:19\d{2}|20[0-2]\d)$/, '');

  return { title: s.slice(0, 120), season, episode };
}

/* Legacy path: segments in alphabetical order or the API answers 302. */
function legacySearchUrl(q) {
  const parts = [];
  if (q.episode) parts.push('episode-' + q.episode);
  parts.push('query-' + encodeURIComponent(q.title.toLowerCase()));
  if (q.season) parts.push('season-' + q.season);
  parts.push('sublanguageid-' + q.lang.os);
  return LEGACY + parts.join('/');
}

/* One result shape for both doors. `ref` is what the pick step is given
   back — never a URL, so the server decides where the file comes from. */
function fromLegacy(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => r && /^(srt|vtt)$/i.test(r.SubFormat || '') && /^\d+$/.test(String(r.IDSubtitleFile || '')))
    .map((r) => ({
      ref: 'os:' + r.IDSubtitleFile,
      name: String(r.MovieReleaseName || r.SubFileName || r.MovieName || '').trim().slice(0, 160),
      movie: String(r.MovieName || '').trim(),
      year: r.MovieYear ? Number(r.MovieYear) || null : null,
      season: Number(r.SeriesSeason) || null,
      episode: Number(r.SeriesEpisode) || null,
      lang: r.ISO639 || '',
      downloads: Number(r.SubDownloadsCnt) || 0,
      hearingImpaired: r.SubHearingImpaired === '1',
      encoding: String(r.SubEncoding || '')
    }))
    .sort((a, b) => b.downloads - a.downloads)
    .slice(0, MAX_RESULTS);
}

function fromApi(body) {
  const rows = body && Array.isArray(body.data) ? body.data : [];
  const out = [];
  for (const row of rows) {
    const a = row && row.attributes;
    const file = a && Array.isArray(a.files) && a.files[0];
    if (!file || !file.file_id) continue;
    const f = a.feature_details || {};
    out.push({
      ref: 'osc:' + file.file_id,
      name: String(a.release || file.file_name || f.title || '').trim().slice(0, 160),
      movie: String(f.parent_title || f.title || '').trim(),
      year: Number(f.year) || null,
      season: Number(f.season_number) || null,
      episode: Number(f.episode_number) || null,
      lang: a.language || '',
      downloads: Number(a.download_count) || 0,
      hearingImpaired: !!a.hearing_impaired,
      encoding: ''
    });
  }
  return out.sort((a, b) => b.downloads - a.downloads).slice(0, MAX_RESULTS);
}

async function timed(fetchImpl, url, init) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, Object.assign({ signal: controller.signal, redirect: 'manual' }, init || {}));
  } finally {
    clearTimeout(t);
  }
}

function apiHeaders(key) {
  return { 'Api-Key': key, 'User-Agent': 'CastBridge v1.0', Accept: 'application/json' };
}

/* search({ title, lang, season?, episode? }) → { results, via } */
async function search(input, env, fetchImpl) {
  const f = fetchImpl || fetch;
  const key = (env || process.env).OPENSUBTITLES_API_KEY || '';
  const lang = language(input.lang) || LANGUAGES[0];
  const q = { title: String(input.title || '').trim(), lang, season: input.season || null, episode: input.episode || null };
  if (!q.title) throw Object.assign(new Error('Type the name of the film or show.'), { status: 400 });

  let legacyError = null;
  try {
    const res = await timed(f, legacySearchUrl(q), { headers: { 'User-Agent': UA, 'X-User-Agent': UA, Accept: 'application/json' } });
    if (res.status !== 200) throw new Error('OpenSubtitles answered ' + res.status);
    return { results: fromLegacy(await res.json()), via: 'opensubtitles.org' };
  } catch (e) {
    legacyError = e;
  }

  if (!key) {
    throw Object.assign(new Error("OpenSubtitles didn't answer. Try again in a minute."), { status: 502, cause: legacyError });
  }

  const p = new URLSearchParams({ query: q.title, languages: lang.iso.toLowerCase() });
  if (q.season) p.set('season_number', String(q.season));
  if (q.episode) p.set('episode_number', String(q.episode));
  const res = await timed(f, API + 'subtitles?' + p.toString(), { headers: apiHeaders(key) });
  if (res.status !== 200) {
    throw Object.assign(new Error("OpenSubtitles didn't answer (" + res.status + '). Try again in a minute.'), { status: 502 });
  }
  return { results: fromApi(await res.json()), via: 'opensubtitles.com' };
}

/* The legacy API names encodings the Windows way; TextDecoder wants WHATWG
   labels. Anything unknown is decoded as UTF-8 and then windows-1252, the
   same order the phone-side upload uses. */
function decodeBytes(buf, encoding) {
  const label = String(encoding || '').toLowerCase().replace(/^cp/, 'windows-');
  if (label && label !== 'ascii' && label !== 'utf-8') {
    try { return new TextDecoder(label).decode(buf); } catch (e) { /* unknown label */ }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

function parseRef(ref) {
  const m = String(ref || '').match(/^(os|osc):(\d{1,12})$/);
  return m ? { door: m[1], id: m[2] } : null;
}

async function readLimited(res) {
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_FILE_BYTES) throw new Error('That subtitle file is too big.');
  return buf;
}

/* download(ref, encoding?) → text of the subtitle file */
async function download(ref, encoding, env, fetchImpl) {
  const f = fetchImpl || fetch;
  const r = parseRef(ref);
  if (!r) throw Object.assign(new Error('That is not a subtitle from the search.'), { status: 400 });

  if (r.door === 'os') {
    let url = LEGACY_DL + r.id + '.gz';
    let res;
    /* The download host redirects within itself; followed by hand so a hop
       can never leave opensubtitles.org. */
    for (let hop = 0; hop < 3; hop++) {
      res = await timed(f, url, { headers: { 'User-Agent': UA } });
      if (res.status < 300 || res.status >= 400) break;
      const next = new URL(res.headers.get('location') || '', url);
      if (!/(^|\.)opensubtitles\.org$/i.test(next.hostname) || next.protocol !== 'https:') {
        throw Object.assign(new Error('OpenSubtitles sent the download somewhere else.'), { status: 502 });
      }
      url = next.toString();
    }
    if (!res || res.status !== 200) {
      throw Object.assign(new Error('OpenSubtitles refused the download (' + (res && res.status) + '). Try another one.'), { status: 502 });
    }
    let buf = await readLimited(res);
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf, { maxOutputLength: MAX_FILE_BYTES });
    return decodeBytes(buf, encoding);
  }

  const key = (env || process.env).OPENSUBTITLES_API_KEY || '';
  if (!key) throw Object.assign(new Error('That subtitle needs an OpenSubtitles key this server does not have.'), { status: 503 });
  const res = await timed(f, API + 'download', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, apiHeaders(key)),
    body: JSON.stringify({ file_id: Number(r.id), sub_format: 'srt' })
  });
  const body = await res.json().catch(() => ({}));
  if (res.status !== 200 || !body.link) {
    throw Object.assign(new Error((body && body.message) || 'OpenSubtitles refused the download.'), { status: res.status === 406 ? 429 : 502 });
  }
  const link = new URL(body.link);
  if (link.protocol !== 'https:' || !/(^|\.)opensubtitles\.(com|org)$/i.test(link.hostname)) {
    throw Object.assign(new Error('OpenSubtitles sent the download somewhere else.'), { status: 502 });
  }
  const fileRes = await timed(f, link.toString(), { headers: { 'User-Agent': 'CastBridge v1.0' }, redirect: 'follow' });
  if (fileRes.status !== 200) throw Object.assign(new Error('OpenSubtitles refused the download.'), { status: 502 });
  return decodeBytes(await readLimited(fileRes), '');
}

module.exports = {
  LANGUAGES, language, parseTitle, legacySearchUrl, fromLegacy, fromApi,
  decodeBytes, parseRef, search, download
};
