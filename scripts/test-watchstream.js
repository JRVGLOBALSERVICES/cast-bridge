#!/usr/bin/env node
/* Proof for the external watchdog — the one part of this system whose whole
 * job is to be believed when it speaks.
 *
 * It was shipped untested, and it cost two false alarms on 2026-09-08:
 * "stream.jrvsystems.app is back, it was down for 1h 25m", then fourteen
 * minutes later "back, down for 1h 38m", for a host that had been serving
 * continuously the entire time. Two separate defects had to line up:
 *
 *   1. Rehearsals wrote to production. Four probes against 127.0.0.1, fired
 *      by hand to prove the wedged/stale/no_heartbeat branches, opened four
 *      real issues on the real repository.
 *   2. Recovery drained ONE issue per run. The job's memory is the open
 *      issue, so N leftovers meant N runs, each announcing its own recovery
 *      with a duration measured from a different issue's creation.
 *
 * A watchdog that cries during rehearsal is muted within a week, and then it
 * is not there for the fault it exists for. So it is tested from the outside,
 * as a process, against a stub that stands in for GitHub, the WhatsApp hook
 * and the host — the same three surfaces the real run touches.
 *
 *   node scripts/test-watchstream.js
 */

const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const SCRIPT = process.env.CB_WATCH_SCRIPT || path.join(__dirname, 'watch-stream.mjs');

let passed = 0;
const failures = [];

function group(name) { console.log('\n' + name); }
async function check(name, fn) {
  try { await fn(); passed += 1; console.log('  ok   ' + name); }
  catch (err) { failures.push(name + ' — ' + err.message); console.log('  FAIL ' + name + ' — ' + err.message); }
}

/* ---- the stub: GitHub, the hook, and the host being watched -------- */

function minutesAgo(m) { return new Date(Date.now() - m * 60000).toISOString(); }

function stub({ health, issues }) {
  const seen = { hook: [], created: [], closed: [], comments: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      const send = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj === undefined ? {} : obj));
      };
      const url = req.url.split('?')[0];

      if (url === '/healthz') return send(health.status || 200, health.body);
      if (url === '/hook') { seen.hook.push(body && body.text); return send(200, { ok: true }); }

      /* GitHub, only the four calls the watchdog makes. */
      if (/\/issues$/.test(url) && req.method === 'GET') return send(200, issues);
      if (/\/issues$/.test(url) && req.method === 'POST') {
        seen.created.push(body);
        return send(201, { number: 99 });
      }
      const comment = url.match(/\/issues\/(\d+)\/comments$/);
      if (comment && req.method === 'POST') { seen.comments.push(Number(comment[1])); return send(201, {}); }
      const patch = url.match(/\/issues\/(\d+)$/);
      if (patch && req.method === 'PATCH') { seen.closed.push(Number(patch[1])); return send(200, {}); }

      send(404, { message: 'stub has no route for ' + req.method + ' ' + url });
    });
  });
  return { server, seen };
}

function run({ health, issues = [], allowSideEffects = true, target }) {
  const { server, seen } = stub({ health, issues });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const base = 'http://127.0.0.1:' + server.address().port;
      const env = {
        ...process.env,
        WATCH_TARGET: target || (base + '/healthz'),
        WATCH_GH_API: base,
        CAST_WATCH_HOOK: base + '/hook',
        GITHUB_TOKEN: 'stub-token',
        GITHUB_REPOSITORY: 'JRVGLOBALSERVICES/cast-bridge',
        WATCH_SECOND_LOOK_MS: '0'
      };
      if (allowSideEffects) env.WATCH_ALLOW_SIDE_EFFECTS = '1';
      else delete env.WATCH_ALLOW_SIDE_EFFECTS;

      /* spawn, never spawnSync: the stub lives in THIS process, and a
         synchronous child blocks the event loop that would answer it — every
         probe then times out and the suite proves nothing but its own
         deadlock. */
      const child = spawn(process.execPath, [SCRIPT], { env });
      let out = '';
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { out += c; });
      const kill = setTimeout(() => child.kill('SIGKILL'), 30000);
      child.on('close', (code) => {
        clearTimeout(kill);
        server.close(() => resolve({ seen, stdout: out, code }));
      });
    });
    server.on('error', reject);
  });
}

const HEALTHY = { body: { ok: true, self_update: { state: 'up_to_date', age_s: 120, stale: false } } };
const WEDGED = { body: { ok: true, self_update: { state: 'blocked', age_s: 120, stale: false } } };

function complaint(number, ageMin, whatsapp) {
  return {
    number,
    created_at: minutesAgo(ageMin),
    body: '🔴 something\n\n| | |\n|---|---|\n| WhatsApp | ' + (whatsapp || 'sent') + ' |'
  };
}

(async () => {
  group('a healthy probe with nothing outstanding says nothing');
  await check('no message, no writes', async () => {
    const r = await run({ health: HEALTHY, issues: [] });
    assert.strictEqual(r.code, 0, 'watchdog exited ' + r.code + '\n' + r.stdout);
    assert.deepStrictEqual(r.seen.hook, [], 'a healthy host with no complaint open must be silent');
    assert.deepStrictEqual(r.seen.closed, []);
  });

  group('recovery speaks ONCE, however many complaints are outstanding');
  await check('four leftovers produce one message, not four runs of one each', async () => {
    const r = await run({
      health: HEALTHY,
      issues: [complaint(5, 85), complaint(4, 85), complaint(3, 86), complaint(2, 86)]
    });
    assert.strictEqual(r.seen.hook.length, 1,
      'sent ' + r.seen.hook.length + ' recovery messages for one recovery — this is the 8.39pm/8.53pm bug');
    assert.deepStrictEqual(r.seen.closed.sort((a, b) => a - b), [2, 3, 4, 5],
      'every open complaint must be closed by the run that announces the recovery, or the next run announces it again');
  });

  await check('the duration is measured from the OLDEST complaint', async () => {
    const r = await run({ health: HEALTHY, issues: [complaint(9, 20), complaint(8, 200)] });
    assert.strictEqual(r.seen.hook.length, 1);
    assert.ok(/3h 20m/.test(r.seen.hook[0]),
      'expected the outage to run from the first complaint, got: ' + r.seen.hook[0]);
  });

  await check('one complaint still reads the same as it always did', async () => {
    const r = await run({ health: HEALTHY, issues: [complaint(7, 12)] });
    assert.strictEqual(r.seen.hook.length, 1);
    assert.ok(/is back/.test(r.seen.hook[0]) && /12 min/.test(r.seen.hook[0]), r.seen.hook[0]);
    assert.deepStrictEqual(r.seen.closed, [7]);
    assert.deepStrictEqual(r.seen.comments, [7], 'the issue carries the duration too — it is the record');
  });

  group('a fault still alerts, and still only once');
  await check('an unheralded fault opens exactly one issue and sends one message', async () => {
    const r = await run({ health: WEDGED, issues: [] });
    assert.strictEqual(r.seen.hook.length, 1, 'a real fault must reach WhatsApp');
    assert.ok(/cannot update itself/.test(r.seen.hook[0]), r.seen.hook[0]);
    assert.strictEqual(r.seen.created.length, 1, 'and leave exactly one issue behind as its memory');
  });

  await check('a fault already complained about is silent', async () => {
    const r = await run({ health: WEDGED, issues: [complaint(6, 30, 'sent')] });
    assert.deepStrictEqual(r.seen.hook, [], 'repeating every ten minutes is how a channel gets muted');
    assert.deepStrictEqual(r.seen.created, [], 'and how an issue tracker becomes noise');
  });

  await check('an alert that never reached WhatsApp is delivered late, once', async () => {
    const r = await run({ health: WEDGED, issues: [complaint(6, 30, 'unreachable')] });
    assert.strictEqual(r.seen.hook.length, 1,
      'the whole point of the issue channel is the box being off — the message he reads still has to arrive');
    assert.deepStrictEqual(r.seen.created, [], 'late delivery is not a new complaint');
  });

  group('a rehearsal cannot touch production');
  await check('a probe at a non-default target writes nothing and sends nothing', async () => {
    const r = await run({ health: WEDGED, issues: [], allowSideEffects: false });
    assert.strictEqual(r.code, 0, 'the guard must not crash the run\n' + r.stdout);
    assert.deepStrictEqual(r.seen.hook, [],
      'this is the defect that put two false alarms on his phone — a rehearsal must not buzz');
    assert.deepStrictEqual(r.seen.created, [],
      'four rehearsal issues became four fake recoveries; the guard is what stops it recurring');
    assert.ok(/rehearsal/.test(r.stdout), 'and it has to SAY it suppressed something, or it looks broken');
  });

  await check('a rehearsal against a healthy host closes nothing', async () => {
    const r = await run({ health: HEALTHY, issues: [complaint(3, 60)], allowSideEffects: false });
    assert.deepStrictEqual(r.seen.closed, [], 'a rehearsal must not close a real complaint either');
    assert.deepStrictEqual(r.seen.hook, []);
  });

  group('the probe still classifies what it always classified');
  await check('a stale updater is stale, an ok:false is unhealthy', async () => {
    const stale = await run({
      health: { body: { ok: true, self_update: { state: 'up_to_date', age_s: 5400, stale: true } } },
      issues: []
    });
    assert.ok(/stopped ticking/.test(stale.seen.hook[0] || ''), stale.stdout);
    const bad = await run({ health: { body: { ok: false } }, issues: [] });
    assert.ok(/reporting itself unhealthy/.test(bad.seen.hook[0] || ''), bad.stdout);
  });

  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})();
