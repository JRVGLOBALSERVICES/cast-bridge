/* The one folder.
 *
 * A television cannot reach a file on a phone: it fetches over the network
 * and the phone is not a server. The way across is to put the file
 * somewhere the television CAN fetch, which is this box, which is already
 * serving the stream proxy over https a few milliseconds away.
 *
 * That makes disk a thing the app now spends, so everything it spends is
 * under one root and every gram of it is countable and clearable:
 *
 *   <root>/files/  <id>.<ext>       what the television fetches
 *          files/  <id>.meta.json   original name, type, size, who, when
 *          tmp/    <id>.part        an upload still arriving
 *
 * Nothing else is ever written here, nothing is written outside it, and an
 * id is 32 hex characters because /f/<id> is fetched by a television that
 * cannot present a ticket — the address is the capability, so it has to be
 * one nobody can guess.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const ROOT = process.env.CAST_FILES_DIR || '/var/lib/cast-stream/media';
const FILES = path.join(ROOT, 'files');
const TMP = path.join(ROOT, 'tmp');

/* A phone's 4K clip is a couple of gigabytes; a downloaded film is more.
   The cap exists so a runaway or a hostile upload cannot fill the disk, not
   because any honest file is expected to reach it. */
const MAX_BYTES = Number(process.env.CAST_MAX_UPLOAD_BYTES) || 8 * 1024 * 1024 * 1024;

/* Never take the last of the disk. The box runs other things. */
const KEEP_FREE_BYTES = Number(process.env.CAST_KEEP_FREE_BYTES) || 20 * 1024 * 1024 * 1024;

/* How long an upload lives. A day by default, because most uploads are a
   delivery mechanism — but the uploader chooses at the point of sending,
   and "keep until I delete it" is one of the choices, because a file you
   mean to share a link to is not a file that should quietly vanish
   overnight.

   The ceiling is real disk on a box that runs other things. Thirty days is
   not a policy about what you may keep, it is the longest this app will
   hold something without you touching it again. */
const FILE_TTL_MS = (Number(process.env.CAST_FILE_TTL_HOURS) || 24) * 3600 * 1000;
const MAX_KEEP_HOURS = Number(process.env.CAST_MAX_KEEP_HOURS) || 24 * 30;
const TMP_TTL_MS = 60 * 60 * 1000;

/* 0 means keep until deleted by hand. Anything else is clamped into
   [1, MAX_KEEP_HOURS]; a missing or unreadable value falls back to the
   default day rather than to forever, because failing open on retention is
   how a disk fills. */
function keepHoursOf(v) {
  if (v === 0 || v === '0') return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return Math.round(FILE_TTL_MS / 3600000);
  return Math.min(Math.max(Math.round(n), 1), MAX_KEEP_HOURS);
}

/* The one place an expiry is computed, so stored metas and re-dated ones
   can never disagree about what "3 days" means. */
function expiryFrom(fromMs, keepHours) {
  return keepHours === 0 ? null : new Date(fromMs + keepHours * 3600000).toISOString();
}

/* A meta written before retention existed has no `expires`. It is not
   forever — it is the old blanket day, measured from when it landed. */
function expiryOf(meta) {
  if (!meta) return null;
  if (Object.prototype.hasOwnProperty.call(meta, 'expires')) return meta.expires;
  const added = Date.parse(meta.added || '') || 0;
  return added ? new Date(added + FILE_TTL_MS).toISOString() : null;
}

/* Extensions a television has any chance with, and the type to serve them
   as. An upload whose name is not on this list keeps its bytes and loses
   its extension — it is still fetchable, it just gets a generic type. */
const TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.opus': 'audio/opus',
  '.ogg': 'audio/ogg',
  '.srt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8'
};

function ensure() {
  fs.mkdirSync(FILES, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });
}

function newId() {
  return crypto.randomBytes(16).toString('hex');
}

function isId(s) {
  return typeof s === 'string' && /^[0-9a-f]{32}$/.test(s);
}

/* The only thing taken from a name the client sent. Everything else about
   the stored file — its id, its path — is generated here, so a name like
   ../../etc/passwd loses the whole path and keeps at most ".passwd", which
   is then not in TYPES and is dropped. */
function extOf(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  return Object.prototype.hasOwnProperty.call(TYPES, ext) ? ext : '';
}

function typeOf(ext) {
  return TYPES[ext] || 'application/octet-stream';
}

/* A display name that is safe to put in JSON and back in a UI. Not used as
   a path, ever. */
function cleanName(name) {
  return String(name || 'video')
    .replace(/[\u0000-\u001f\u007f]/g, '')   /* control characters */
    .replace(/[\\/]/g, ' ')                   /* never a path, only a label */
    .trim()
    .slice(0, 160) || 'video';
}

/* The readable half of a share link. It carries no authority — the 32 hex
   characters after it are the whole credential — so it can be anything, and
   what it is for is a person glancing at a pasted URL and knowing what it
   is before they tap it. */
function slugOf(name) {
  return String(name || '')
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'video';
}

function freeBytes() {
  try {
    const s = fs.statfsSync(ROOT);
    return s.bavail * s.bsize;
  } catch (e) {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Receiving
 * ------------------------------------------------------------------ */

/* Streams the request body to disk. Deliberately NOT multipart: the client
   sends the file as the raw body with its name in the query, because
   multipart on a 4 GB upload means either a parser dependency or holding
   the thing in memory, and both are worse than one query parameter.
   Resolves { id, bytes, name, type, url }. Rejects with a .status. */
function receive(req, opts) {
  ensure();
  const o = opts || {};
  const id = newId();
  const ext = extOf(o.name);
  const tmpPath = path.join(TMP, id + '.part');
  const finalPath = path.join(FILES, id + ext);

  const declared = Number(o.declaredBytes) || 0;
  const free = freeBytes();
  if (free !== null && declared && declared + KEEP_FREE_BYTES > free) {
    const err = new Error('Not enough room on the stream host for that file.');
    err.status = 507;
    return Promise.reject(err);
  }
  if (declared && declared > MAX_BYTES) {
    const err = new Error('That file is larger than this host accepts.');
    err.status = 413;
    return Promise.reject(err);
  }

  return new Promise((resolve, reject) => {
    let bytes = 0;
    let settled = false;
    const out = fs.createWriteStream(tmpPath);

    const fail = (status, message) => {
      if (settled) return;
      settled = true;
      req.unpipe(out);
      out.destroy();
      fs.promises.unlink(tmpPath).catch(() => {});
      const err = new Error(message);
      err.status = status;
      reject(err);
    };

    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) fail(413, 'That file is larger than this host accepts.');
    });
    req.on('error', () => fail(400, 'The upload stopped before it finished.'));
    out.on('error', () => fail(500, 'That file could not be written.'));

    out.on('finish', async () => {
      if (settled) return;
      settled = true;
      if (!bytes) {
        await fsp.unlink(tmpPath).catch(() => {});
        const err = new Error('That upload arrived empty.');
        err.status = 400;
        return reject(err);
      }
      try {
        /* Rename, not copy: same filesystem, so the file appears in files/
           whole or not at all. A half-written upload is never fetchable. */
        await fsp.rename(tmpPath, finalPath);
        const now = Date.now();
        const keepHours = keepHoursOf(o.keepHours);
        const meta = {
          id: id,
          name: cleanName(o.name),
          ext: ext,
          type: typeOf(ext),
          bytes: bytes,
          uploader: o.uploader || null,
          added: new Date(now).toISOString(),
          keepHours: keepHours,
          expires: expiryFrom(now, keepHours)
        };
        await fsp.writeFile(path.join(FILES, id + '.meta.json'), JSON.stringify(meta));
        resolve(meta);
      } catch (e) {
        await fsp.unlink(tmpPath).catch(() => {});
        const err = new Error('That file could not be stored.');
        err.status = 500;
        reject(err);
      }
    });

    req.pipe(out);
  });
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

async function metaOf(id) {
  if (!isId(id)) return null;
  try {
    const raw = await fsp.readFile(path.join(FILES, id + '.meta.json'), 'utf8');
    const m = JSON.parse(raw);
    return m && m.id === id ? m : null;
  } catch (e) {
    return null;
  }
}

function pathOf(meta) {
  return path.join(FILES, meta.id + (meta.ext || ''));
}

async function list() {
  ensure();
  let names;
  try {
    names = await fsp.readdir(FILES);
  } catch (e) {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.meta.json')) continue;
    const meta = await metaOf(n.slice(0, -'.meta.json'.length));
    if (!meta) continue;
    /* The meta is a claim; the file on disk is the fact. A meta whose file
       has gone is a dangling row and is reported as zero rather than as the
       size it used to be. */
    let onDisk = 0;
    try {
      onDisk = (await fsp.stat(pathOf(meta))).size;
    } catch (e) {
      onDisk = 0;
    }
    out.push(Object.assign({}, meta, {
      bytes: onDisk,
      missing: onDisk === 0,
      expires: expiryOf(meta),
      slug: slugOf(meta.name)
    }));
  }
  out.sort((a, b) => String(b.added).localeCompare(String(a.added)));
  return out;
}

/* One person's own uploads. The stream host has no idea who is an owner and
   no user table to ask, so it answers about the uid in the ticket and
   nothing else — /api/storage stays the owner's whole-disk view, minted
   from the Vercel side where roles actually live. */
async function listFor(uid) {
  if (!uid) return [];
  return (await list()).filter((f) => f.uploader === uid);
}

/* Re-date a file that is already here. Returns the new meta, or null if it
   is not there or is not the caller's. */
async function setExpiry(id, keepHours, uid) {
  const meta = await metaOf(id);
  if (!meta) return null;
  if (uid && meta.uploader && meta.uploader !== uid) return null;
  const keep = keepHoursOf(keepHours);
  /* Measured from now, not from when it landed. "Keep another week" said on
     day six has to mean a week, or the button lies. */
  const next = Object.assign({}, meta, {
    keepHours: keep,
    expires: expiryFrom(Date.now(), keep)
  });
  await fsp.writeFile(path.join(FILES, id + '.meta.json'), JSON.stringify(next));
  return next;
}

async function dirBytes(dir) {
  let total = 0;
  let count = 0;
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch (e) {
    return { bytes: 0, count: 0 };
  }
  for (const n of names) {
    try {
      const st = await fsp.stat(path.join(dir, n));
      if (st.isFile()) { total += st.size; count++; }
    } catch (e) { /* vanished mid-walk; it is not there, so it is not size */ }
  }
  return { bytes: total, count: count };
}

async function usage() {
  ensure();
  const files = await dirBytes(FILES);
  const tmp = await dirBytes(TMP);
  return {
    root: ROOT,
    files: files,
    tmp: tmp,
    total_bytes: files.bytes + tmp.bytes,
    free_bytes: freeBytes(),
    max_upload_bytes: MAX_BYTES,
    keep_free_bytes: KEEP_FREE_BYTES,
    file_ttl_hours: Math.round(FILE_TTL_MS / 3600000),
    max_keep_hours: MAX_KEEP_HOURS
  };
}

/* ------------------------------------------------------------------ *
 * Clearing
 * ------------------------------------------------------------------ */

async function removeOne(id) {
  if (!isId(id)) return false;
  const meta = await metaOf(id);
  let gone = false;
  if (meta) {
    await fsp.unlink(pathOf(meta)).then(() => { gone = true; }).catch(() => {});
    await fsp.unlink(path.join(FILES, id + '.meta.json')).catch(() => {});
  }
  return gone || Boolean(meta);
}

async function clearDir(dir, olderThanMs) {
  ensure();
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch (e) {
    return { removed: 0, bytes: 0 };
  }
  const cutoff = olderThanMs ? Date.now() - olderThanMs : null;
  let removed = 0;
  let bytes = 0;
  for (const n of names) {
    const p = path.join(dir, n);
    try {
      const st = await fsp.stat(p);
      if (!st.isFile()) continue;
      if (cutoff !== null && st.mtimeMs > cutoff) continue;
      bytes += st.size;
      await fsp.unlink(p);
      removed++;
    } catch (e) { /* already gone */ }
  }
  return { removed: removed, bytes: bytes };
}

/* `what`:
 *   tmp      — half-finished uploads only. Always safe.
 *   expired  — files past the TTL. What the sweeper runs on a timer.
 *   files    — everything uploaded, whatever its age.
 *   all      — both folders, emptied.
 */
/* What the sweeper actually runs. It cannot be a mtime sweep any more: two
   files uploaded in the same minute can now carry a one-day expiry and a
   never, and mtime cannot tell them apart. So the meta is the authority and
   the media file follows it.

   An orphan — bytes in files/ with no meta beside them — is swept on age,
   because there is nothing else to ask, and it can only exist if a meta was
   lost or a rename half-happened. */
async function clearExpired() {
  ensure();
  let names;
  try { names = await fsp.readdir(FILES); } catch (e) { return { removed: 0, bytes: 0 }; }
  const now = Date.now();
  const metas = names.filter((n) => n.endsWith('.meta.json'));
  const known = new Set();
  let removed = 0;
  let bytes = 0;

  for (const n of metas) {
    const id = n.slice(0, -'.meta.json'.length);
    const meta = await metaOf(id);
    if (!meta) continue;
    known.add(id + (meta.ext || ''));
    known.add(n);
    const exp = expiryOf(meta);
    if (!exp) continue;                    /* kept until deleted by hand */
    if (Date.parse(exp) > now) continue;   /* still in date */
    try { bytes += (await fsp.stat(pathOf(meta))).size; } catch (e) { /* already gone */ }
    if (await removeOne(id)) removed++;
  }

  for (const n of names) {
    if (known.has(n) || n.endsWith('.meta.json')) continue;
    const p = path.join(FILES, n);
    try {
      const st = await fsp.stat(p);
      if (!st.isFile() || st.mtimeMs > now - FILE_TTL_MS) continue;
      bytes += st.size;
      await fsp.unlink(p);
      removed++;
    } catch (e) { /* already gone */ }
  }

  return { removed: removed, bytes: bytes };
}

async function clear(what) {
  switch (what) {
    case 'tmp':
      return { tmp: await clearDir(TMP, 0) };
    case 'expired':
      return { files: await clearExpired(), tmp: await clearDir(TMP, TMP_TTL_MS) };
    case 'files':
      return { files: await clearDir(FILES, 0) };
    case 'all':
      return { files: await clearDir(FILES, 0), tmp: await clearDir(TMP, 0) };
    default: {
      const err = new Error('Say what to clear: tmp, expired, files or all.');
      err.status = 400;
      throw err;
    }
  }
}

/* Runs on a timer so the disk gets back to zero without anyone tapping
   anything. The manual buttons exist for the times you do not want to
   wait — they are not the only thing keeping the folder honest. */
async function sweep() {
  try {
    return await clear('expired');
  } catch (e) {
    return null;
  }
}

module.exports = {
  ROOT, FILES, TMP, MAX_BYTES, TYPES,
  MAX_KEEP_HOURS,
  ensure, newId, isId, extOf, typeOf, cleanName, slugOf, freeBytes,
  keepHoursOf, expiryOf,
  receive, metaOf, pathOf, list, listFor, setExpiry, usage, clear, sweep, removeOne
};
