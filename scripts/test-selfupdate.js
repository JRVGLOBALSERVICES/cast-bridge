#!/usr/bin/env node
/* The auto-updater has to be able to prove it is alive, not merely quiet.
 *
 * A cron line with nothing to do and a cron line that stopped firing produce
 * exactly the same evidence: an unchanged log. That is how this box spent a
 * day eight commits behind Vercel without anybody, human or agent, noticing.
 * So the contract under test is narrow and specific: EVERY tick stamps a
 * heartbeat, including — especially — the boring one that changes nothing.
 *
 * The script is driven for real against throwaway clones. Nothing here
 * re-implements its decisions; a test that retypes the predicate only ever
 * proves the test agrees with itself.
 *
 *   node scripts/test-selfupdate.js
 *   SELF_UPDATE_SCRIPT=/tmp/old.sh node scripts/test-selfupdate.js   # see it red
 */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = process.env.SELF_UPDATE_SCRIPT || path.join(__dirname, 'self-update.sh');

let failures = 0;
function check(name, cond, detail) {
  if (cond) return console.log('  ok   ' + name);
  failures++;
  console.log('  FAIL ' + name + (detail ? '\n         ' + detail : ''));
}

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/* An origin with two commits and a clone parked on the first, so a test can
   choose whether the clone is current simply by how far it has pulled. */
function stage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selfupd-'));
  const origin = path.join(root, 'origin');
  fs.mkdirSync(origin);
  git(origin, 'init', '-q', '-b', 'main');
  git(origin, 'config', 'user.email', 'test@example.com');
  git(origin, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(origin, 'app.js'), 'one\n');
  git(origin, 'add', '-A');
  git(origin, 'commit', '-q', '-m', 'one');
  const first = git(origin, 'rev-parse', 'HEAD');

  const clone = path.join(root, 'clone');
  git(root, 'clone', '-q', origin, clone);

  fs.writeFileSync(path.join(origin, 'app.js'), 'two\n');
  git(origin, 'commit', '-q', '-am', 'two');

  git(clone, 'config', 'user.email', 'test@example.com');
  git(clone, 'config', 'user.name', 'test');
  return { root, origin, clone, first };
}

/* CAST_UPDATE_NOTIFY=off keeps a test off WhatsApp. CAST_HEALTH_URL points at
   a closed port so "in flight" reads 0 without a stub server. */
function run(clone, env = {}) {
  return spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, CAST_REPO: clone, CAST_UPDATE_NOTIFY: 'off',
           CAST_HEALTH_URL: 'http://127.0.0.1:9/healthz', ...env }
  });
}

const beatOf = (clone) => {
  const f = path.join(clone, 'data', 'self-update-heartbeat.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return { unparseable: true }; }
};
const logOf = (clone) => {
  const f = path.join(clone, 'data', 'self-update.log');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
};

console.log('self-update heartbeat');

/* 1. The boring tick. This is the whole point: nothing to do, nothing worth
      logging, and still a stamp — otherwise a dead cron looks like this too. */
{
  const { origin, clone } = stage();
  git(clone, 'pull', '-q', '--ff-only', 'origin', 'main');   // current with origin
  const r = run(clone);
  const beat = beatOf(clone);
  check('a tick with nothing to do still stamps a heartbeat', beat !== null,
    'no data/self-update-heartbeat.json — a silent cron is indistinguishable from a stopped one');
  check('the stamp says why it did nothing', beat && beat.state === 'up_to_date',
    'state=' + (beat && beat.state));
  check('the stamp carries the commit it is parked on',
    beat && /^[0-9a-f]{7,}$/.test(String(beat.head || '')), 'head=' + (beat && beat.head));
  check('the stamp is fresh',
    beat && Math.abs(Date.now() - Date.parse(beat.ts)) < 60_000, 'ts=' + (beat && beat.ts));
  check('the quiet tick stays out of the log', logOf(clone).trim() === '',
    'log got: ' + JSON.stringify(logOf(clone)));
  check('exit 0', r.status === 0, 'status=' + r.status);
  void origin;
}

/* 2. A real update stamps too, and says so. */
{
  const { clone } = stage();
  const r = run(clone);
  const beat = beatOf(clone);
  check('an applied update stamps', beat && beat.state === 'updated',
    'state=' + (beat && beat.state) + ' stderr=' + (r.stderr || '').slice(0, 200));
  check('the update moved HEAD', git(clone, 'rev-parse', 'HEAD') === git(clone, 'rev-parse', 'origin/main'));
}

/* 3. Refusing to touch someone's work is a decision, not an absence of one —
      it has to be as visible as the update it declined to make. */
{
  const { clone, first } = stage();
  fs.writeFileSync(path.join(clone, 'app.js'), 'local edit\n');  // tracked, modified
  const r = run(clone);
  const beat = beatOf(clone);
  check('a blocked tick stamps its refusal', beat && beat.state === 'blocked',
    'state=' + (beat && beat.state));
  check('the refusal carries the gap', beat && beat.behind === 1, 'behind=' + (beat && beat.behind));
  check('HEAD was left where the local work is', git(clone, 'rev-parse', 'HEAD') === first,
    'HEAD moved to ' + git(clone, 'rev-parse', 'HEAD'));
  check('the local edit survived', fs.readFileSync(path.join(clone, 'app.js'), 'utf8') === 'local edit\n');
  check('the refusal is logged as well as stamped', /BLOCKED/.test(logOf(clone)));
  void r;
}

/* 4. An untracked runtime file is not work in progress. data/ is written by
      the service itself on every request; counting it made an earlier version
      of this guard refuse every update forever while logging what read like a
      considered decision. */
{
  const { clone } = stage();
  fs.mkdirSync(path.join(clone, 'data'), { recursive: true });
  fs.writeFileSync(path.join(clone, 'data', 'usage.json'), '{}');
  fs.writeFileSync(path.join(clone, 'stray.tmp'), 'x');
  run(clone);
  const beat = beatOf(clone);
  check('untracked files do not block an update', beat && beat.state === 'updated',
    'state=' + (beat && beat.state));
}

console.log('');
if (failures) { console.log(failures + ' assertion(s) failed'); process.exit(1); }
console.log('all assertions passed');
