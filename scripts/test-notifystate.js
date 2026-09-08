#!/usr/bin/env node
/* Proof for the half of the notification path that decides whether anything
 * is ever SEEN: the `notify` module in assets/js/app.js.
 *
 * sw.js was already under test — it is the courier, and it was the half that
 * had been debugged, because a button that does nothing is loud. The half
 * that had never been driven is the one that decides whether a notification
 * is drawn at all, and how: permission, the pref, the visible/hidden
 * reconciler, and `silent`. That last one is why background notifications
 * appeared not to work at all. A silent notification is delivered and filed
 * out of sight — Android puts it under "Silent", below the fold, with no
 * heads-up banner; iOS gives it no banner and no lock screen. Nothing is
 * broken and nothing is visible, which is the worst shape a bug can take.
 *
 * The module is lifted out of the real shipped file rather than copied here.
 * A test that reads a second copy of the logic proves the copy agrees with
 * itself.
 *
 *   node scripts/test-notifystate.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
const failures = [];

function check(name, fn) {
  try { fn(); passed += 1; console.log('  ok   ' + name); }
  catch (err) { failures.push(name + ' — ' + err.message); console.log('  FAIL ' + name + ' — ' + err.message); }
}
function group(name) { console.log('\n' + name); }

/* ---- lift the module out of app.js -------------------------------- */

/* Overridable so the suite can be pointed at an OLDER copy of app.js and
   watched to fail. A checker that has only ever been seen green is not
   evidence that it checks anything. */
const APP_PATH = process.env.CB_APP_JS || path.join(__dirname, '..', 'assets', 'js', 'app.js');
const APP = fs.readFileSync(APP_PATH, 'utf8');
const START = '  var notify = (function () {';
const startAt = APP.indexOf(START);
assert.notStrictEqual(startAt, -1, 'could not find the notify module in app.js');
const endAt = APP.indexOf('\n  })();\n', startAt);
assert.notStrictEqual(endAt, -1, 'could not find the end of the notify module');
const SOURCE = APP.slice(startAt, endAt + '\n  })();'.length);

/* ---- a browser, as much of one as this module touches -------------- */

function makeEnv(opts) {
  opts = opts || {};
  const posts = [];
  const listeners = {};        // document/window events the module registers
  const store = Object.assign({}, opts.storage);

  const worker = { postMessage: (m) => posts.push(m) };

  /* Enough of a registration for pushSync to get past readiness. It reports
     no existing subscription, which is the state a fresh install is in. */
  const registration = {
    active: worker,
    pushManager: { getSubscription: () => Promise.resolve(null) }
  };

  const navigator = {
    userAgent: opts.userAgent || 'Mozilla/5.0 (Linux; Android 14) Chrome/120',
    platform: opts.platform || 'Linux armv8l',
    maxTouchPoints: opts.maxTouchPoints || 5,
    standalone: opts.iosStandalone,
    serviceWorker: opts.noServiceWorker ? undefined : {
      controller: worker,
      addEventListener: () => {},
      /* A worker that never activates is the case the real code used to hang
         on: `ready` is specified to WAIT, not to reject, so a worker script
         that 404s or is answered with HTML by a proxy leaves the promise
         pending for the life of the page. */
      ready: opts.swNeverReady ? new Promise(() => {}) : Promise.resolve(registration)
    }
  };
  if (opts.noServiceWorker) delete navigator.serviceWorker;

  const document = {
    hidden: false,
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); }
  };

  const sandbox = {
    navigator,
    document,
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    matchMedia: () => ({ matches: Boolean(opts.displayModeStandalone) }),
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    MessageChannel: function () { this.port1 = {}; this.port2 = {}; },
    /* `pushSupported()` asks for this by name. Without it every pushSync
       test answers 'unsupported' and proves nothing about the code under it. */
    PushManager: function () {},
    /* The guard is twelve seconds in a browser, which is right there and
       useless here. Firing timers at once lets the suite drive the timeout
       branch without the suite taking twelve seconds to say so. */
    setTimeout: opts.instantTimers ? ((fn) => { Promise.resolve().then(fn); return 0; }) : setTimeout,
    clearTimeout: opts.instantTimers ? (() => {}) : clearTimeout,
    Promise, console
  };
  if (!opts.noNotification) {
    sandbox.Notification = {
      permission: opts.permission || 'default',
      requestPermission: () => Promise.resolve(opts.grants || 'granted')
    };
  }
  /* `window` has to BE the sandbox, not an object beside it: support()
     asks `'Notification' in window`, and a stub where the global and the
     window are two different objects answers no to every question the
     module actually asks. */
  sandbox.self = sandbox;
  sandbox.window = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(SOURCE + '\n;globalThis.__notify = notify;', sandbox);

  const notify = sandbox.__notify;
  notify.setReg({ active: worker });

  return {
    notify,
    posts,
    /* Press home / come back — the real trigger for every draw. */
    background() { document.hidden = true; fire('visibilitychange'); },
    foreground() { document.hidden = false; fire('visibilitychange'); },
    shows: () => posts.filter((p) => p.type === 'NOTIFY_SHOW'),
    last: () => posts.filter((p) => p.type === 'NOTIFY_SHOW').slice(-1)[0],
    reset: () => { posts.length = 0; }
  };

  function fire(type) { (listeners[type] || []).forEach((fn) => fn({})); }
}

const granted = (extra) => makeEnv(Object.assign({ permission: 'granted' }, extra));

/* ------------------------------------------------------------------ *
 * The reconciler — nothing on screen while you are looking at it
 * ------------------------------------------------------------------ */

group('what gets drawn, and when');

check('nothing is drawn while the app is in front of you', () => {
  const env = granted();
  env.notify.show('cast', { title: 'Playing', body: 'A film' });
  assert.strictEqual(env.shows().length, 0, 'drew a notification over the page that is open');
});

check('backgrounding the app draws what is outstanding', () => {
  const env = granted();
  env.notify.show('cast', { title: 'Playing', body: 'A film' });
  env.background();
  assert.strictEqual(env.shows().length, 1, 'the film did not reach the shade at all');
  assert.strictEqual(env.last().title, 'Playing');
});

check('coming back to the app takes it down again', () => {
  const env = granted();
  env.notify.show('cast', { title: 'Playing' });
  env.background();
  env.reset();
  env.foreground();
  assert.ok(env.posts.some((p) => p.type === 'NOTIFY_CLOSE'), 'left it in the shade');
});

/* ------------------------------------------------------------------ *
 * silent — the whole of "I never see them"
 * ------------------------------------------------------------------ */

group('whether it can actually be seen');

check('the first draw of a subject alerts', () => {
  const env = granted();
  env.notify.show('cast', { title: 'Playing', body: 'A film', ongoing: true });
  env.background();
  assert.strictEqual(env.last().options.silent, false,
    'drawn silent: Android files this under "Silent" with no banner and iOS gives it no ' +
    'lock screen — it is delivered and invisible, which reads as notifications being broken');
});

check('an update to the same subject stays quiet', () => {
  const env = granted();
  env.notify.show('cast', { title: 'Playing', ongoing: true });
  env.background();
  env.notify.update('cast', { body: '12%' });
  assert.strictEqual(env.last().options.silent, true, 'buzzed on an update');
  assert.strictEqual(env.last().options.renotify, false, 'renotify would re-alert on replace');
});

check('twenty progress ticks make one sound between them', () => {
  const env = granted();
  env.notify.show('upload', { title: 'Sending — 0%', ongoing: true });
  env.background();
  for (let i = 1; i <= 20; i++) env.notify.update('upload', { title: 'Sending — ' + i * 5 + '%' });
  const loud = env.shows().filter((p) => p.options.silent === false);
  assert.strictEqual(loud.length, 1, 'made ' + loud.length + ' sounds for one upload');
});

check('glancing at your phone and leaving again does not re-alert', () => {
  const env = granted();
  env.notify.show('cast', { title: 'Playing', ongoing: true });
  env.background();
  env.foreground();
  env.reset();
  env.background();
  assert.strictEqual(env.last().options.silent, true,
    'buzzes every time you switch away from the app during one film');
});

check('the next film alerts again', () => {
  const env = granted();
  env.notify.show('cast', { title: 'Film one', ongoing: true });
  env.background();
  env.foreground();
  env.notify.close('cast');
  env.notify.show('cast', { title: 'Film two', ongoing: true });
  env.reset();
  env.background();
  assert.strictEqual(env.last().options.silent, false, 'a new film arrived in silence');
});

check('a failure is audible even as a replacement', () => {
  const env = granted();
  env.notify.show('cast', { title: 'Playing', ongoing: true });
  env.background();
  env.notify.show('cast', { title: 'The television stopped answering', urgent: true });
  assert.strictEqual(env.last().options.silent, false, 'a failure went out silent');
});

/* ------------------------------------------------------------------ *
 * The states that mean nothing will ever be drawn
 * ------------------------------------------------------------------ */

group('the states where silence is the honest answer');

check('permission never asked: nothing is drawn, and the state says so', () => {
  const env = makeEnv({ permission: 'default' });
  assert.strictEqual(env.notify.state(), 'ask');
  env.notify.show('cast', { title: 'Playing' });
  env.background();
  assert.strictEqual(env.shows().length, 0, 'drew without permission');
});

check('permission refused reads as blocked, not off', () => {
  const env = makeEnv({ permission: 'denied' });
  assert.strictEqual(env.notify.state(), 'blocked',
    'off can be undone in the app; blocked can only be undone in browser settings, and ' +
    'telling someone to flip a switch that will not help is worse than saying nothing');
});

check('an iPhone in a Safari tab is asked to install, not to allow', () => {
  const env = makeEnv({
    noNotification: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Version/17.5 Mobile Safari',
    iosStandalone: false
  });
  assert.strictEqual(env.notify.state(), 'needs-install',
    'iOS has no Notification outside an installed copy — "allow notifications" is advice ' +
    'that cannot be followed there');
});

check('an installed iPhone copy is a normal one', () => {
  const env = makeEnv({
    permission: 'granted',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Version/17.5 Mobile Safari',
    iosStandalone: true
  });
  assert.strictEqual(env.notify.state(), 'on');
});

check('turned off in the app draws nothing', () => {
  const env = granted({ storage: { 'cb.notify': '0' } });
  assert.strictEqual(env.notify.state(), 'off');
  env.notify.show('cast', { title: 'Playing' });
  env.background();
  assert.strictEqual(env.shows().length, 0, 'drew while switched off');
});

check('granted with no stored pref is on — a granted permission is a yes', () => {
  const env = granted();
  assert.strictEqual(env.notify.state(), 'on');
});

/* ------------------------------------------------------------------ *
 * The one-time offer, which is the difference between a feature that is
 * off and a feature that appears not to exist
 * ------------------------------------------------------------------ */

group('the app says something about its own silence');

check('a cast offers to turn notifications on when they have never been asked for', () => {
  const src = APP;
  assert.ok(/function offerNotifications\(\)/.test(src), 'no offer exists');
  const body = src.slice(src.indexOf('function offerNotifications()'),
                         src.indexOf('function reportCast'));
  assert.ok(/state !== 'ask' && state !== 'needs-install'/.test(body),
    'the offer must be silent once the question has an answer either way');
  assert.ok(/localStorage/.test(body), 'an offer that repeats is nagging, not an offer');
  assert.ok(/Add to Home Screen/.test(body),
    'iOS needs the install sentence — asking for permission there is a dead end');
  assert.ok(/if \(!opts\.urgent\) offerNotifications\(\);/.test(src),
    'the offer belongs on a cast starting, not on a failure report');
});

/* ------------------------------------------------------------------ *
 * The worker that never starts
 *
 * `navigator.serviceWorker.ready` is a promise that waits. It does not
 * reject when the worker script cannot be fetched — a 404, or a bot wall
 * answering /sw.js with an HTML challenge page, both leave it pending
 * forever. Awaiting it bare means every `.catch` downstream is unreachable
 * and the settings row keeps whatever it last painted.
 *
 * That is the same failure shape as the silent notification this suite was
 * written for: the code is running, nothing is drawn, and there is nothing
 * anywhere to contradict "it doesn't work". Losing the race has to be an
 * answer the person can read.
 * ------------------------------------------------------------------ */

async function checkAsync(name, fn) {
  try { await fn(); passed += 1; console.log('  ok   ' + name); }
  catch (err) { failures.push(name + ' — ' + err.message); console.log('  FAIL ' + name + ' — ' + err.message); }
}

(async function () {
  group('a service worker that never starts is said out loud, not waited on');

  await checkAsync('pushSync gives up rather than hanging forever', async () => {
    const env = makeEnv({ permission: 'granted', swNeverReady: true, instantTimers: true });
    const verdict = await Promise.race([
      env.notify.pushSync(),
      new Promise((r) => setTimeout(() => r('HUNG'), 2000))
    ]);
    assert.notStrictEqual(verdict, 'HUNG',
      'pushSync waited on serviceWorker.ready with no timeout — it can never report');
    assert.strictEqual(verdict, 'error', 'a worker that never starts is an error state');
  });

  await checkAsync('and it says which failure it was, in words a phone can act on', async () => {
    const env = makeEnv({ permission: 'granted', swNeverReady: true, instantTimers: true });
    /* Raced, not awaited. Against a build without the guard this call never
       settles, and an un-raced await would hang the whole suite instead of
       failing it — a suite that cannot finish reports nothing. */
    const verdict = await Promise.race([
      env.notify.pushSync(),
      new Promise((r) => setTimeout(() => r('HUNG'), 2000))
    ]);
    assert.notStrictEqual(verdict, 'HUNG', 'pushSync never settled');
    const why = env.notify.pushWhy();
    assert.ok(why && why.length > 20, 'a silent failure state is the bug, not the fix');
    assert.ok(/background worker/i.test(why),
      'the note must name the worker — "not ready yet" reads as a wait, and this is not one');
    assert.ok(/reopen/i.test(why), 'a diagnosis with nothing to do about it is half an answer');
  });

  await checkAsync('a ready worker still reaches the server, not the timeout', async () => {
    /* Real timers on purpose. Instant ones would settle the guard before the
       already-resolved `ready` gets its turn on the microtask queue, and the
       test would then be measuring the stub's ordering rather than the code.
       The worker here is ready immediately, so this still costs nothing.

       No fetch in this sandbox, so pushConfig's own catch returns null and
       pushSync reports the config failure. The point is only that it got
       PAST readiness — the guard must not fire on a healthy worker. */
    const env = makeEnv({ permission: 'granted' });
    const env2 = env;
    let verdict;
    try { verdict = await env2.notify.pushSync(); } catch (e) { verdict = 'threw:' + e.message; }
    assert.strictEqual(verdict, 'error');
    assert.ok(!/background worker/i.test(env2.notify.pushWhy()),
      'the timeout branch fired on a worker that was ready — the guard is mis-wired');
  });

  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})();
