/* Restart and update this box from the phone.
 *
 *   GET  /api/system/git       is this checkout behind GitHub, and by what
 *   POST /api/system/restart   { force }  pm2 restart cast-stream
 *   POST /api/system/update    { force }  fast-forward to origin/main, then restart
 *
 * Rj: "Add a button in vps stream page to pm2 restart cast-stream direct and
 * pull changes to vps if not the same." Until this, both meant a terminal.
 *
 * The same guards as scripts/self-update.sh, because the same things go wrong:
 *   * fast-forward only. A checkout with local commits or edited tracked files
 *     is someone mid-work, and a button must not be the thing that clobbers it.
 *   * a film streaming right now is cut off by a restart. The TV goes quiet
 *     for minutes between reads (7.5 min measured on 2026-09-15), so "nothing
 *     in flight" is not "nobody watching" — a stream in the last 20 minutes
 *     counts as busy too. Busy is not refused, it is answered with 409 and the
 *     numbers, and the phone has to send `force` to go ahead. The person
 *     pressing the button may well be the person watching.
 *
 * The restart is run detached and after the response is written: the command
 * kills this process, so it cannot wait for its own answer. setsid puts it in
 * its own session, so pm2's tree-kill of this process does not take the
 * restart command down with it.
 */

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = process.env.CAST_REPO || path.join(__dirname, '..');
const LOG = path.join(REPO, 'data', 'self-update.log');
const BUSY_S = Number(process.env.CAST_IDLE_MIN_S) || 1200;

function restartCmd() {
  return process.env.CAST_RESTART_CMD || 'pm2 restart cast-stream --update-env';
}

function log(line) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, '[' + new Date().toISOString().replace(/\.\d+Z$/, 'Z') + '] ' + line + '\n');
  } catch (e) { /* a log that cannot be written must not stop the button */ }
}

function git(args, timeout) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', REPO].concat(args), { timeout: timeout || 20000, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message || 'git failed').trim().slice(0, 300)));
        resolve(String(stdout).trim());
      });
  });
}

async function status({ fetch = true } = {}) {
  let fetched = false;
  let fetchError = null;
  if (fetch) {
    try { await git(['fetch', '-q', 'origin', 'main'], 30000); fetched = true; }
    catch (e) { fetchError = e.message; }
  }
  const head = await git(['rev-parse', '--short', 'HEAD']);
  const remote = await git(['rev-parse', '--short', 'origin/main']).catch(() => null);
  const behind = remote ? Number(await git(['rev-list', '--count', 'HEAD..origin/main'])) : null;
  const ahead = remote ? Number(await git(['rev-list', '--count', 'origin/main..HEAD'])) : null;
  /* Untracked files do not count: a fast-forward cannot touch them, and the
     box writes runtime files into its own checkout. */
  const dirty = (await git(['status', '--porcelain', '--untracked-files=no'])).length > 0;
  let commits = [];
  if (behind) {
    const out = await git(['log', '--format=%h%x09%s', '-n', '20', 'HEAD..origin/main']);
    commits = out ? out.split('\n').map((l) => {
      const i = l.indexOf('\t');
      return { sha: l.slice(0, i), subject: l.slice(i + 1) };
    }) : [];
  }
  return { head, remote, behind, ahead, dirty, fetched, fetch_error: fetchError, commits };
}

function busy(stats) {
  const inFlight = stats.inFlight || 0;
  const idle = stats.idleS;          // null = nothing streamed since boot
  return {
    busy: inFlight > 0 || (idle !== null && idle < BUSY_S),
    in_flight: inFlight,
    idle_s: idle,
    busy_window_s: BUSY_S
  };
}

/* Fire and forget, after `delayS`. Returns the child only for tests. */
function scheduleRestart(delayS) {
  const cmd = 'sleep ' + (delayS || 1) + '; ' + restartCmd();
  const child = spawn('setsid', ['sh', '-c', cmd], {
    cwd: REPO, detached: true, stdio: 'ignore', env: process.env
  });
  child.on('error', () => {
    /* No setsid on this box: a plain detached shell still survives in most
       pm2 setups, and a restart that might not happen beats one that cannot. */
    spawn('sh', ['-c', cmd], { cwd: REPO, detached: true, stdio: 'ignore', env: process.env }).unref();
  });
  child.unref();
  return child;
}

async function update() {
  const before = await status({ fetch: true });
  if (before.fetch_error) {
    return { status: 502, body: { ok: false, error: 'Could not reach GitHub from the box: ' + before.fetch_error } };
  }
  if (!before.behind) {
    return { status: 200, body: { ok: true, up_to_date: true, head: before.head } };
  }
  if (before.ahead || before.dirty) {
    log('BUTTON BLOCKED: behind ' + before.behind + ' but ahead ' + before.ahead + ' / dirty ' + before.dirty);
    return { status: 409, body: { ok: false, blocked: true, ahead: before.ahead, dirty: before.dirty,
      error: 'The box has local changes (' + (before.ahead ? before.ahead + ' commit(s) not on GitHub' : 'edited files') +
        '). Not pulling over them — that needs a terminal.' } };
  }
  const lockBefore = await git(['rev-parse', 'HEAD:package-lock.json']).catch(() => 'none');
  try {
    await git(['pull', '-q', '--ff-only', 'origin', 'main'], 60000);
  } catch (e) {
    log('BUTTON pull failed: ' + e.message);
    return { status: 502, body: { ok: false, error: 'git pull failed: ' + e.message } };
  }
  const head = await git(['rev-parse', '--short', 'HEAD']);
  const lockAfter = await git(['rev-parse', 'HEAD:package-lock.json']).catch(() => 'none');
  let deps = false;
  if (lockBefore !== lockAfter) {
    deps = true;
    const ok = await new Promise((resolve) => {
      execFile('npm', ['ci', '--omit=dev'], { cwd: REPO, timeout: 240000, maxBuffer: 8 << 20 },
        (err) => resolve(!err));
    });
    if (!ok) {
      log('BUTTON npm ci failed at ' + head);
      return { status: 502, body: { ok: false, error: 'Pulled ' + head + ' but npm ci failed. Not restarting onto missing packages.' } };
    }
  }
  log('BUTTON updated ' + before.head + ' -> ' + head + ' (' + before.behind + ' commit(s))' + (deps ? ' + npm ci' : ''));
  return { status: 200, body: { ok: true, from: before.head, to: head, pulled: before.behind, deps, commits: before.commits } };
}

module.exports = { status, busy, update, scheduleRestart, restartCmd, log, BUSY_S };
