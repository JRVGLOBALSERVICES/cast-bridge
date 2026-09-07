/* Subtitle normalisation.
 *
 * A television is not a browser. The Cast receiver fetches a text track
 * itself, from its own address on the network, and it accepts exactly one
 * format: WebVTT, served cross-origin-open, over https. Almost every
 * subtitle file in circulation is an SRT on a host that has never heard of
 * CORS — which is why "load a subtitle" is the single most complained-about
 * missing feature in the apps that do this for a living.
 *
 * So the conversion happens here and the file is re-served by us. This
 * module is the pure half: text in, text out, no network.
 */

const MAX_CUES = 20000;

/* SRT allows a bare mm:ss,mmm and a sloppy number of digits; VTT does not.
   Everything is widened to hh:mm:ss.mmm so the receiver never has to guess. */
function normalizeStamp(raw) {
  const m = String(raw).trim().match(/^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?$/);
  if (!m) return null;

  const h = m[1] === undefined ? 0 : parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const s = parseInt(m[3], 10);
  if (min > 59 || s > 59) return null;

  const ms = (m[4] === undefined ? '000' : m[4]).padEnd(3, '0').slice(0, 3);
  return String(h).padStart(2, '0') + ':' +
         String(min).padStart(2, '0') + ':' +
         String(s).padStart(2, '0') + '.' + ms;
}

/* A cue's timing line, in either dialect, with VTT's trailing settings
   (align, line, position) carried through untouched — they are already
   valid and a player that understands them should keep them. */
function convertTimingLine(line) {
  const m = line.match(/^\s*([\d:,.]+)\s*-->\s*([\d:,.]+)(\s+.*)?$/);
  if (!m) return null;

  const from = normalizeStamp(m[1]);
  const to = normalizeStamp(m[2]);
  if (!from || !to) return null;

  return from + ' --> ' + to + (m[3] ? ' ' + m[3].trim() : '');
}

/* Cue text is inserted into a document the receiver parses as VTT, where a
   bare "-->" on its own line would start a new cue and an unclosed tag can
   swallow the rest of the file. Neither belongs in dialogue. */
function sanitizeCueText(line) {
  return line
    .replace(/-->/g, '- - >')
    .replace(/<(?!\/?(?:b|i|u|v|c|ruby|rt|lang)\b)/gi, '&lt;');
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/* Recognises the shape, not the file name. A host that serves an SRT as
   text/plain (most of them) is the normal case, not the exception. */
function looksLikeSubtitles(text) {
  const head = String(text || '').slice(0, 4096);
  if (/^﻿?WEBVTT/.test(head)) return true;
  return /\d{1,3}:\d{1,2}:\d{1,2}[,.]\d{1,3}\s*-->/.test(head) ||
         /\d{1,2}:\d{1,2}[,.]\d{1,3}\s*-->/.test(head);
}

/* SRT (or a VTT that needs tidying) in, WebVTT out.
 *
 * Returns { vtt, cues }. Throws when nothing in the input is a cue — an
 * empty track that loads cleanly is worse than a refusal, because the
 * subtitle button lights up and then says nothing for two hours.
 */
function toVtt(input) {
  const text = stripBom(String(input || '')).replace(/\r\n?/g, '\n');
  const body = /^WEBVTT/.test(text) ? text.replace(/^WEBVTT[^\n]*\n?/, '') : text;

  const out = [];
  let cues = 0;

  for (const block of body.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;

    /* A leading sequence number is SRT bookkeeping and means nothing in
       VTT, but a non-numeric first line is a cue identifier and is kept. */
    let i = 0;
    let id = '';
    if (!/-->/.test(lines[0])) {
      if (!/^\d+$/.test(lines[0].trim())) id = lines[0].trim();
      i = 1;
    }
    if (i >= lines.length) continue;

    const timing = convertTimingLine(lines[i]);
    if (!timing) continue;

    const spoken = lines.slice(i + 1).map(sanitizeCueText);
    if (!spoken.length) continue;

    out.push((id ? id + '\n' : '') + timing + '\n' + spoken.join('\n'));
    if (++cues >= MAX_CUES) break;
  }

  if (!cues) throw new Error('That file has no subtitles in it.');

  return { vtt: 'WEBVTT\n\n' + out.join('\n\n') + '\n', cues };
}

module.exports = { toVtt, normalizeStamp, looksLikeSubtitles, MAX_CUES };
