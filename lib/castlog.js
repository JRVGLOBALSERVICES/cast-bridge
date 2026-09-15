/* Shaping a batch of cast-log lines from a phone before it is stored.
 *
 * Kept apart from api/castlog.js so the rules can be tested without a
 * database: what counts as a problem line, how long a line may be, and what a
 * session id has to look like. Everything here is reading input from a
 * browser, so it trims and caps rather than trusts.
 */

const MAX_LINES_PER_BATCH = 400;
const MAX_LINE = 300;
const MAX_DETAIL = 1500;

/* A line that reads as the film failing, or about to. Counted per row so the
   list can mark the casts worth opening without reading every one. The
   heartbeat and ordinary state lines must NOT match: "TV player state:
   PLAYING" is the good news. */
const PROBLEM = /\b(refused|error|failed|not playing|expired|couldn'?t|could not|did not end|took the tv|stalled|idle reason: (error|interrupted|cancelled))\b/i;

function isProblem(e) {
  return PROBLEM.test(e.line) || /idle reason: (ERROR|INTERRUPTED)/.test(e.detail || '');
}

function validSession(s) {
  return typeof s === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(s);
}

function clip(v, n) {
  if (v === undefined || v === null || v === '') return null;
  return String(v).slice(0, n);
}

/* Returns { lines, problems }. Lines without a readable time get the server's,
   so a phone with a wrong clock still sorts; one with a sane clock keeps its
   own, because the phone's time is when the TV actually said it. */
function shape(raw, now) {
  const at0 = now || Date.now();
  const list = Array.isArray(raw) ? raw.slice(-MAX_LINES_PER_BATCH) : [];
  const lines = [];
  let problems = 0;
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const line = clip(r.line, MAX_LINE);
    if (!line) continue;
    let at = Number(r.at);
    /* More than a day off the server's clock is a broken clock, not a log. */
    if (!Number.isFinite(at) || Math.abs(at - at0) > 86400000) at = at0;
    const e = { at: Math.round(at), line };
    const detail = clip(r.detail, MAX_DETAIL);
    if (detail) e.detail = detail;
    if (r.pos !== undefined && Number.isFinite(Number(r.pos))) e.pos = Math.round(Number(r.pos));
    if (isProblem(e)) problems++;
    lines.push(e);
  }
  return { lines, problems };
}

module.exports = { shape, isProblem, validSession, clip, MAX_LINES_PER_BATCH };
