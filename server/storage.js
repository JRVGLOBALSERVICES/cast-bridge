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

/* Uploads are a delivery mechanism, not a library. They go after a day
   unless something says otherwise, and a half-finished one goes in an hour. */
const FILE_TTL_MS = (Number(process.env.CAST_FILE_TTL_HOURS) || 24) * 3600 * 1000;
const TMP_TTL_MS = 60 * 60 * 1000;

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
        const meta = {
          id: id,
          name: cleanName(o.name),
          ext: ext,
          type: typeOf(ext),
          bytes: bytes,
          uploader: o.uploader || null,
          added: new Date().toISOString()
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
    out.push(Object.assign({}, meta, { bytes: onDisk, missing: onDisk === 0 }));
  }
  out.sort((a, b) => String(b.added).localeCompare(String(a.added)));
  return out;
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
    file_ttl_hours: Math.round(FILE_TTL_MS / 3600000)
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
async function clear(what) {
  switch (what) {
    case 'tmp':
      return { tmp: await clearDir(TMP, 0) };
    case 'expired':
      return { files: await clearDir(FILES, FILE_TTL_MS), tmp: await clearDir(TMP, TMP_TTL_MS) };
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
  ensure, newId, isId, extOf, typeOf, cleanName, freeBytes,
  receive, metaOf, pathOf, list, usage, clear, sweep, removeOne
};
