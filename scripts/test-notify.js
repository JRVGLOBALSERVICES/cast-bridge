#!/usr/bin/env node
/* Proof for the notification path: assets/js/artwork.js and sw.js.
 *
 * Both halves of "the buttons do nothing" live in files that never touch a
 * DOM: which picture to show, and what to do with a tap when the page that
 * has to perform it is frozen or was never running. So both are driven
 * here, from the real shipped files, with the browser's side stubbed.
 *
 *   node scripts/test-notify.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
const failures = [];
const queue = [];

function check(name, fn) {
  queue.push(async () => {
    try {
      await fn();
      passed += 1;
      console.log('  ok   ' + name);
    } catch (err) {
      failures.push(name + ' — ' + err.message);
      console.log('  FAIL ' + name + ' — ' + err.message);
    }
  });
}
function group(name) { queue.push(async () => console.log('\n' + name)); }

/* ------------------------------------------------------------------ *
 * assets/js/artwork.js — which picture, and when there is none
 * ------------------------------------------------------------------ */

const CBArtwork = require('../assets/js/artwork.js');

/* An <img> that succeeds, fails or never answers, chosen by the url. */
function fakeImage(rules) {
  return function FakeImage() {
    const self = this;
    this.naturalWidth = 0;
    Object.defineProperty(this, 'src', {
      set(v) {
        const verdict = rules[v] || 'error';
        if (verdict === 'silent') return;                 // never answers
        setTimeout(() => {
          if (verdict === 'ok') { self.naturalWidth = 640; self.onload && self.onload(); }
          else self.onerror && self.onerror();
        }, 1);
      }
    });
  };
}

/* A <canvas> that either yields a frame or throws SecurityError, which is
   what a real one does over a cross-origin stream. */
function fakeDoc(opts) {
  return {
    createElement() {
      return {
        width: 0, height: 0,
        getContext: () => ({ drawImage() {} }),
        toDataURL() {
          if (opts.tainted) { const e = new Error('tainted canvas'); e.name = 'SecurityError'; throw e; }
          return 'data:image/jpeg;base64,AAAA';
        }
      };
    }
  };
}

const READY = { readyState: 2, videoWidth: 1280, videoHeight: 720 };

function art(opts) {
  opts = opts || {};
  return CBArtwork.create({
    document: fakeDoc({ tainted: Boolean(opts.tainted) }),
    Image: fakeImage(opts.rules || {}),
    setTimeout: (fn, ms) => setTimeout(fn, opts.probeMs || ms),
    probeMs: opts.probeMs || 40,
    video: 'video' in opts ? opts.video : READY,
    proxy: opts.proxy || ((u) => 'https://app.test/api/img?u=' + encodeURIComponent(u))
  });
}

/* What the app's own server would be asked for, given a poster address. */
const viaUs = (u) => 'https://app.test/api/img?u=' + encodeURIComponent(u);

group('artwork — the cover, and what to do without one');

check('a cover that loads is used', async () => {
  const a = art({ rules: { 'https://x.test/cover.jpg': 'ok' } });
  await a.set('https://x.test/cover.jpg');
  assert.strictEqual(a.current(), 'https://x.test/cover.jpg');
  assert.strictEqual(a.source(), 'poster');
});

check('a cover that 403s is fetched again through our own server', async () => {
  /* The whole reason the shade showed a grey app mark over a film with a
     perfectly good cover: hotlink protection refuses the phone, and one
     refusal was being read as "there is no picture". */
  const url = 'https://x.test/hotlink.jpg';
  const a = art({ rules: { [url]: 'error', [viaUs(url)]: 'ok' } });
  await a.set(url);
  assert.strictEqual(a.current(), viaUs(url));
  assert.strictEqual(a.source(), 'poster');
});

check('a cover that fails BOTH ways is dropped, not shown broken', async () => {
  const url = 'https://x.test/gone.jpg';
  const a = art({ rules: { [url]: 'error', [viaUs(url)]: 'error' } });
  await a.set(url);
  assert.strictEqual(a.current(), '');
});

check('a cover that loads direct is not fetched through us twice', async () => {
  const url = 'https://x.test/cover.jpg';
  const asked = [];
  const a = art({
    rules: { [url]: 'ok', [viaUs(url)]: 'ok' },
    proxy: (u) => { asked.push(u); return viaUs(u); }
  });
  await a.set(url);
  assert.strictEqual(a.current(), url);
  assert.deepStrictEqual(asked, [], 'the direct address worked; nothing to retry');
});

check('a host that never answers gives up rather than waiting forever', async () => {
  const a = art({ rules: { 'https://x.test/slow.jpg': 'silent' }, probeMs: 30 });
  await a.set('https://x.test/slow.jpg');
  assert.strictEqual(a.current(), '');
});

check('no cover: a frame of the film is used', () => {
  const a = art();
  a.tryFrame();
  assert.ok(a.current().startsWith('data:image/jpeg'));
  assert.strictEqual(a.source(), 'frame');
});

check('a cross-origin stream taints the canvas and yields nothing', () => {
  const a = art({ tainted: true });
  assert.strictEqual(a.tryFrame(), '');
  assert.strictEqual(a.current(), '');
});

check('a frame is not taken before there are pixels', () => {
  const a = art({ video: { readyState: 0, videoWidth: 0, videoHeight: 0 } });
  assert.strictEqual(a.tryFrame(), '');
});

check('a frame never overwrites the page\'s own cover', async () => {
  const a = art({ rules: { 'https://x.test/cover.jpg': 'ok' } });
  await a.set('https://x.test/cover.jpg');
  a.tryFrame();
  assert.strictEqual(a.current(), 'https://x.test/cover.jpg');
});

check('a captured frame is never offered to the television', () => {
  const a = art();
  a.tryFrame();
  assert.ok(a.current());
  assert.strictEqual(a.remote(), '', 'a data: URL is useless to a Chromecast');
});

check('a real cover reaches the television through our own server', async () => {
  /* Even when the phone loaded it direct. The receiver is a separate
     client with its own referer and no session, and ours is the only copy
     carrying the cross-origin header a Chromecast needs. */
  const url = 'https://x.test/cover.jpg';
  const a = art({ rules: { [url]: 'ok' } });
  await a.set(url);
  assert.strictEqual(a.remote(), viaUs(url));
});

check('the television is given an absolute address', async () => {
  const url = 'https://x.test/cover.jpg';
  const a = art({ rules: { [url]: 'ok' } });
  await a.set(url);
  assert.ok(/^https:\/\//.test(a.remote()), 'a receiver has nothing to resolve a slash against');
});

check('a slow first film cannot overwrite a fast second one', async () => {
  /* The old guard compared the argument to itself and could never fire. */
  const slow = 'https://x.test/slow.jpg';
  const fast = 'https://x.test/fast.jpg';
  const a = art({
    rules: { [slow]: 'ok', [fast]: 'ok' },
    proxy: viaUs
  });
  const first = a.set(slow);
  const second = a.set(fast);
  await Promise.all([first, second]);
  assert.strictEqual(a.current(), fast, 'the film actually loaded wins');
});

check('a new film drops the last one\'s cover in the same tick', async () => {
  const a = art({ rules: { 'https://x.test/cover.jpg': 'ok' } });
  await a.set('https://x.test/cover.jpg');
  a.set('https://x.test/second.jpg');            // deliberately not awaited
  assert.strictEqual(a.current(), '', 'the wrong picture is worse than none');
});

check('listeners hear every change', async () => {
  const a = art({ rules: { 'https://x.test/cover.jpg': 'ok' } });
  const seen = [];
  a.onChange((v) => seen.push(v));
  await a.set('https://x.test/cover.jpg');
  assert.deepStrictEqual(seen, ['', 'https://x.test/cover.jpg']);
});

check('one throwing listener does not stop the rest', async () => {
  const a = art({ rules: { 'https://x.test/cover.jpg': 'ok' } });
  let reached = false;
  a.onChange(() => { throw new Error('bad listener'); });
  a.onChange(() => { reached = true; });
  await a.set('https://x.test/cover.jpg');
  assert.ok(reached);
});

/* ------------------------------------------------------------------ *
 * sw.js — a tap, and who performs it
 * ------------------------------------------------------------------ */

function channel() {
  const p1 = { onmessage: null, postMessage(d) { setTimeout(() => p2.onmessage && p2.onmessage({ data: d }), 0); } };
  const p2 = { onmessage: null, postMessage(d) { setTimeout(() => p1.onmessage && p1.onmessage({ data: d }), 0); } };
  return { port1: p1, port2: p2 };
}

function loadWorker() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  const listeners = {};
  const store = new Map();               // one in-memory Cache Storage
  const log = { shown: [], closed: [], openWindow: [], focused: [] };

  class Res {
    constructor(body) { this.body = body; }
    async json() { return JSON.parse(this.body); }
  }
  const keyOf = (r) => (typeof r === 'string' ? r : r.url);

  const cache = {
    async put(req, res) { store.set(keyOf(req), res); },
    async match(req) { return store.get(keyOf(req)) || undefined; },
    async delete(req) { return store.delete(keyOf(req)); },
    async addAll() {}
  };

  const clients = [];
  const sandbox = {
    self: {
      addEventListener: (t, fn) => { listeners[t] = fn; },
      skipWaiting() {},
      clients: {
        matchAll: async () => clients.slice(),
        claim: async () => {},
        openWindow: async (url) => { log.openWindow.push(url); return { id: 'new' }; }
      },
      registration: {
        showNotification: (title, opts) => {
          const n = {
            title, tag: (opts || {}).tag, opts: opts || {}, closed: false,
            close() { this.closed = true; }
          };
          log.shown.push(n);
          return Promise.resolve();
        },
        /* Chrome's own filtering: a tag narrows it, no filter is the lot. */
        getNotifications: async (filter) => log.shown.filter(
          (n) => !n.closed && (!filter || !filter.tag || n.tag === filter.tag))
      }
    },
    caches: {
      open: async () => cache,
      keys: async () => [],
      delete: async () => true,
      match: async () => undefined
    },
    Request: class { constructor(url) { this.url = url; } },
    Response: Res,
    MessageChannel: function () { return channel(); },
    location: { origin: 'https://cast.example' },
    setTimeout, clearTimeout, Promise, console, URL, JSON, Date
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'sw.js' });

  return {
    listeners, log, clients, store,
    /* A window the worker can see. `answers` decides whether it behaves
       like a live page, a frozen one, or one that is being torn down. */
    addClient(answers) {
      const c = {
        url: 'https://cast.example/',
        heard: [],
        async focus() {
          if (answers === 'refuses-focus') throw new Error('gone');
          log.focused.push(c);
          return c;
        },
        postMessage(msg, ports) {
          c.heard.push(msg);
          if (answers !== 'live' || !ports || !ports[0]) return;      // frozen: queued, never answered
          ports[0].postMessage({ type: 'NOTIFY_ACTION_ACK', id: msg.id });
        }
      };
      clients.push(c);
      return c;
    },
    click(opts) {
      const waits = [];
      const notification = {
        tag: opts.tag || 'cast',
        data: opts.data || { url: '/', tag: opts.tag || 'cast' },
        closed: false,
        close() { this.closed = true; log.closed.push(this.tag); }
      };
      listeners.notificationclick({
        notification,
        action: opts.action || '',
        waitUntil: (p) => waits.push(p)
      });
      return { notification, settled: Promise.all(waits) };
    },
    async send(msg) {
      const ch = channel();
      const replies = [];
      ch.port1.onmessage = (e) => replies.push(e.data);
      listeners.message({ data: msg, ports: [ch.port2], source: null, waitUntil: (p) => p });
      await new Promise((r) => setTimeout(r, 20));
      return replies;
    },
    pending() {
      const hit = store.get('/__pending-action');
      return hit ? JSON.parse(hit.body) : null;
    }
  };
}

group('sw — a tap on the notification itself');

check('focuses the window that is already open', async () => {
  const w = loadWorker();
  const c = w.addClient('live');
  const hit = w.click({});
  await hit.settled;
  assert.strictEqual(w.log.focused.length, 1, 'the open app should be focused');
  assert.strictEqual(w.log.openWindow.length, 0, 'and not a second copy opened');
  assert.ok(hit.notification.closed);
  assert.strictEqual(c.heard.length, 0, 'a plain tap performs nothing');
});

check('does NOT navigate the open window', async () => {
  /* The regression this exists for: navigate() reloads the page, which
     drops the Cast sender the notification is reporting on, and spends the
     client reference so the focus() after it can reject — a tap that closed
     the notification and did nothing else. */
  const w = loadWorker();
  const c = w.addClient('live');
  const navigated = [];
  c.navigate = async (u) => { navigated.push(u); return c; };
  await w.click({ data: { url: '/' } }).settled;
  assert.deepStrictEqual(navigated, [], 'an open window is focused, never reloaded');
  assert.strictEqual(w.log.focused.length, 1);
});

check('opens the app when nothing is running', async () => {
  const w = loadWorker();
  await w.click({ data: { url: '/?tab=history' } }).settled;
  assert.deepStrictEqual(w.log.openWindow, ['/?tab=history']);
});

check('a window that cannot be focused falls through to opening one', async () => {
  const w = loadWorker();
  w.addClient('refuses-focus');
  await w.click({}).settled;
  assert.strictEqual(w.log.openWindow.length, 1);
});

group('sw — a tap on Pause or Stop');

check('a live page performs it, and nothing else happens', async () => {
  const w = loadWorker();
  const c = w.addClient('live');
  await w.click({ action: 'toggle' }).settled;
  assert.strictEqual(c.heard.length, 1);
  assert.strictEqual(c.heard[0].type, 'NOTIFY_ACTION');
  assert.strictEqual(c.heard[0].action, 'toggle');
  assert.ok(c.heard[0].id, 'every tap carries an id');
  assert.strictEqual(w.pending(), null, 'a performed tap is not written down');
  assert.strictEqual(w.log.focused.length, 0, 'and does not yank the app to the front');
});

check('a frozen page: the tap is written down and the app is brought up', async () => {
  const w = loadWorker();
  const c = w.addClient('frozen');
  await w.click({ action: 'stop' }).settled;
  const job = w.pending();
  assert.ok(job, 'a tap nobody answered must survive');
  assert.strictEqual(job.action, 'stop');
  assert.strictEqual(job.id, c.heard[0].id, 'the same tap, not a second one');
  assert.strictEqual(w.log.focused.length, 1);
});

check('no page at all: written down, and the app opened', async () => {
  const w = loadWorker();
  await w.click({ action: 'toggle' }).settled;
  assert.strictEqual(w.pending().action, 'toggle');
  assert.strictEqual(w.log.openWindow.length, 1);
});

check('the notification stays up while the button is acted on', async () => {
  const w = loadWorker();
  w.addClient('live');
  const hit = w.click({ action: 'toggle' });
  await hit.settled;
  assert.strictEqual(hit.notification.closed, false,
    'closing it means the new state can only arrive as a second notification');
});

group('sw — the written-down tap');

check('is handed over once, and only once', async () => {
  const w = loadWorker();
  await w.click({ action: 'toggle' }).settled;
  const first = await w.send({ type: 'GET_PENDING_ACTION' });
  assert.strictEqual(first[0].job.action, 'toggle');
  const second = await w.send({ type: 'GET_PENDING_ACTION' });
  assert.strictEqual(second[0].job, null, 'a replayed tap must not fire twice');
});

check('is dropped when it is older than the person\'s patience', async () => {
  const w = loadWorker();
  await w.click({ action: 'toggle' }).settled;
  const job = w.pending();
  job.at = Date.now() - 120000;
  w.store.set('/__pending-action', { body: JSON.stringify(job), json: async () => job });
  const out = await w.send({ type: 'GET_PENDING_ACTION' });
  assert.strictEqual(out[0].job, null);
});

check('an acknowledgement from a thawed page cancels it', async () => {
  /* The double-apply: a frozen page thaws, finds the queued tap and
     performs it. The written-down copy must not then pause it again. */
  const w = loadWorker();
  const c = w.addClient('frozen');
  await w.click({ action: 'toggle' }).settled;
  assert.ok(w.pending());
  await w.send({ type: 'NOTIFY_ACTION_ACK', id: c.heard[0].id });
  assert.strictEqual(w.pending(), null);
});

check('an acknowledgement of a different tap leaves it alone', async () => {
  const w = loadWorker();
  w.addClient('frozen');
  await w.click({ action: 'toggle' }).settled;
  await w.send({ type: 'NOTIFY_ACTION_ACK', id: 'some-other-tap' });
  assert.ok(w.pending(), 'still owed');
});

group('sw — what the page asks it to draw');

check('draws exactly the options it is given, cover included', async () => {
  const w = loadWorker();
  await w.send({
    type: 'NOTIFY_SHOW',
    title: 'Playing on Living Room TV',
    options: { tag: 'cast', image: 'https://x.test/cover.jpg', icon: 'https://x.test/cover.jpg' }
  });
  assert.strictEqual(w.log.shown.length, 1);
  assert.strictEqual(w.log.shown[0].title, 'Playing on Living Room TV');
  assert.strictEqual(w.log.shown[0].opts.image, 'https://x.test/cover.jpg');
  assert.strictEqual(w.log.shown[0].opts.icon, 'https://x.test/cover.jpg');
});

check('a tagged close takes down that one and leaves the rest', async () => {
  const w = loadWorker();
  await w.send({ type: 'NOTIFY_SHOW', title: 'Casting', options: { tag: 'cast' } });
  await w.send({ type: 'NOTIFY_SHOW', title: 'Sending — 40%', options: { tag: 'upload' } });
  await w.send({ type: 'NOTIFY_CLOSE', tag: 'upload' });
  const up = w.log.shown.filter((n) => !n.closed).map((n) => n.tag);
  assert.deepStrictEqual(up, ['cast']);
});

check('a tagless close clears the shade, including a dead page\'s notification', async () => {
  /* The one a previous instance of the app drew. The fresh page has no
     record of it and cannot name its tag, so it must be able to say "all
     of mine" — otherwise the shade reports on the screen you are looking
     at, which is exactly the state this app promises never to be in. */
  const w = loadWorker();
  await w.send({ type: 'NOTIFY_SHOW', title: 'Playing on the TV', options: { tag: 'cast' } });
  await w.send({ type: 'NOTIFY_SHOW', title: 'Found 3 streams', options: { tag: 'scan' } });
  await w.send({ type: 'NOTIFY_CLOSE' });
  assert.deepStrictEqual(w.log.shown.filter((n) => !n.closed), []);
});

check('still answers what build is installed', async () => {
  const w = loadWorker();
  const out = await w.send({ type: 'GET_BUILD' });
  assert.ok(out[0] && out[0].build, 'the footer reads this');
});

/* ------------------------------------------------------------------ *
 * assets/js/castaction.js — what a shade button is allowed to act on
 *
 * The fault this file exists for: the `cast` notification is only ever
 * drawn about a television, and its buttons used to fall back to this
 * phone's own <video> whenever the Cast session was not ready at the
 * instant of the tap. That element is hidden, empty and already paused
 * while a film is on the television, so the tap was silent, the shade
 * never changed its word, and it read as a dead button.
 * ------------------------------------------------------------------ */

const CBCastAction = require('../assets/js/castaction.js');

/* A clock this test drives by hand, so an 8-second budget costs no
   wall-clock seconds and the assertions are about the rule, not timing. */
function fakeClock() {
  let now = 0;
  const timers = [];
  return {
    setInterval(fn, ms) { const t = { fn, ms, next: now + ms, live: true }; timers.push(t); return t; },
    clearInterval(t) { if (t) t.live = false; },
    advance(ms) {
      const until = now + ms;
      let guard = 0;
      while (now < until && guard++ < 10000) {
        const due = timers.filter((t) => t.live && t.next <= until)
          .sort((a, b) => a.next - b.next)[0];
        if (!due) break;
        now = due.next;
        due.next = now + due.ms;
        due.fn();
      }
      now = until;
    }
  };
}

function waiter(clock) {
  return CBCastAction.create({
    setInterval: clock.setInterval, clearInterval: clock.clearInterval
  });
}

group('castaction — a tap waits for the television, and nothing else');

check('acts at once when the remote is already there', () => {
  const clock = fakeClock();
  const seen = [];
  waiter(clock).wait({ replayed: false }, () => true,
    () => seen.push('act'), () => seen.push('gave-up'));
  assert.deepStrictEqual(seen, ['act']);
});

check('an ordinary tap with no session WAITS — it does not act', () => {
  /* The regression. The old rule was `if (!replayed) act()`, which took the
     ordinary live-page tap straight past the guard to the wrong device —
     and `ready()` is false for a moment on every thaw, which is exactly
     when a shade tap arrives. */
  const clock = fakeClock();
  const seen = [];
  waiter(clock).wait({ replayed: false }, () => false,
    () => seen.push('act'), () => seen.push('gave-up'));
  assert.deepStrictEqual(seen, [], 'nothing may happen while the remote is missing');
});

check('acts as soon as the session turns up', () => {
  const clock = fakeClock();
  const seen = [];
  let ready = false;
  waiter(clock).wait({ replayed: false }, () => ready,
    () => seen.push('act'), () => seen.push('gave-up'));
  clock.advance(500);
  assert.deepStrictEqual(seen, [], 'still nothing at half a second');
  ready = true;
  clock.advance(250);
  assert.deepStrictEqual(seen, ['act']);
});

check('gives up after the live budget, and says so instead of acting', () => {
  const clock = fakeClock();
  const seen = [];
  waiter(clock).wait({ replayed: false }, () => false,
    () => seen.push('act'), () => seen.push('gave-up'));
  clock.advance(CBCastAction.LIVE - CBCastAction.STEP);
  assert.deepStrictEqual(seen, [], 'not before the budget is spent');
  clock.advance(CBCastAction.STEP);
  assert.deepStrictEqual(seen, ['gave-up']);
});

check('a replayed tap is given longer, because it is waiting on a rejoin', () => {
  const clock = fakeClock();
  const seen = [];
  waiter(clock).wait({ replayed: true }, () => false,
    () => seen.push('act'), () => seen.push('gave-up'));
  clock.advance(CBCastAction.LIVE + CBCastAction.STEP);
  assert.deepStrictEqual(seen, [], 'the live budget must not end a rejoin');
  clock.advance(CBCastAction.REJOIN);
  assert.deepStrictEqual(seen, ['gave-up']);
});

check('never both, and never twice', () => {
  const clock = fakeClock();
  const seen = [];
  let ready = false;
  waiter(clock).wait({ replayed: false }, () => ready,
    () => seen.push('act'), () => seen.push('gave-up'));
  ready = true;
  clock.advance(CBCastAction.LIVE * 4);
  assert.deepStrictEqual(seen, ['act'], 'one tap is one outcome');
});

check('the timer is stopped, not left running', () => {
  const clock = fakeClock();
  let asked = 0;
  let ready = false;
  waiter(clock).wait({ replayed: false }, () => { asked += 1; return ready; },
    () => {}, () => {});
  ready = true;
  clock.advance(CBCastAction.STEP);
  const settled = asked;
  clock.advance(CBCastAction.LIVE * 4);
  assert.strictEqual(asked, settled, 'a finished wait must stop asking');
});

group('sw — what became of the last tap');

check('a tap a page performed is written down as such', async () => {
  const w = loadWorker();
  w.addClient('live');
  await w.click({ action: 'toggle' }).settled;
  const log = (await w.send({ type: 'GET_ACTION_LOG' }))[0].list;
  assert.strictEqual(log.length, 1);
  assert.strictEqual(log[0].action, 'toggle');
  assert.strictEqual(log[0].route, 'page');
  assert.ok(log[0].at, 'without a time it cannot be said how long ago');
});

check('a tap nobody answered records that the app had to be woken', async () => {
  const w = loadWorker();
  w.addClient('frozen');
  await w.click({ action: 'stop' }).settled;
  const log = (await w.send({ type: 'GET_ACTION_LOG' }))[0].list;
  assert.strictEqual(log[0].route, 'written-down');
  assert.strictEqual(log[0].woke, true);
  assert.strictEqual(log[0].id, w.pending().id, 'one tap, one line');
});

check('nothing to wake is recorded differently from something woken', async () => {
  const w = loadWorker();
  await w.click({ action: 'toggle' }).settled;   // no clients at all
  const log = (await w.send({ type: 'GET_ACTION_LOG' }))[0].list;
  assert.strictEqual(log[0].route, 'written-down');
  assert.strictEqual(log[0].woke, true, 'openWindow answered, so something came up');
});

check('the page\'s answer lands on the same line, matched by id', async () => {
  const w = loadWorker();
  w.addClient('live');
  await w.click({ action: 'toggle' }).settled;
  const id = (await w.send({ type: 'GET_ACTION_LOG' }))[0].list[0].id;
  await w.send({ type: 'NOTIFY_ACTION_RESULT', id, outcome: 'performed' });
  const log = (await w.send({ type: 'GET_ACTION_LOG' }))[0].list;
  assert.strictEqual(log.length, 1, 'an answer is not a second tap');
  assert.strictEqual(log[0].outcome, 'performed');
});

check('the first answer wins — a replay does not overwrite it', async () => {
  /* A frozen page thaws and performs its queued copy as well as the
     written-down one. Both report. The tap had one outcome. */
  const w = loadWorker();
  w.addClient('live');
  await w.click({ action: 'toggle' }).settled;
  const id = (await w.send({ type: 'GET_ACTION_LOG' }))[0].list[0].id;
  await w.send({ type: 'NOTIFY_ACTION_RESULT', id, outcome: 'no-session' });
  await w.send({ type: 'NOTIFY_ACTION_RESULT', id, outcome: 'performed' });
  const log = (await w.send({ type: 'GET_ACTION_LOG' }))[0].list;
  assert.strictEqual(log[0].outcome, 'no-session');
});

check('an answer to a tap that is not there changes nothing', async () => {
  const w = loadWorker();
  await w.send({ type: 'NOTIFY_ACTION_RESULT', id: 'never-happened', outcome: 'performed' });
  const log = (await w.send({ type: 'GET_ACTION_LOG' }))[0].list;
  assert.strictEqual(log.length, 0);
});

check('newest first, and it does not grow forever', async () => {
  const w = loadWorker();
  for (let i = 0; i < 15; i++) await w.click({ action: 'toggle' }).settled;
  const log = (await w.send({ type: 'GET_ACTION_LOG' }))[0].list;
  assert.strictEqual(log.length, 12, 'a phone does not need a fortnight of these');
  assert.ok(log[0].at >= log[log.length - 1].at, 'the last tap is the one being asked about');
});

check('asking before there has been a tap answers with nothing', async () => {
  const w = loadWorker();
  const out = await w.send({ type: 'GET_ACTION_LOG' });
  assert.strictEqual(out[0].list.length, 0);
});

check('a frozen page is given up on quickly enough to still open a window', async () => {
  /* Chrome allows a notificationclick a limited window in which a worker
     may focus or open one, and every millisecond spent waiting on a page
     that will never answer is spent out of it. */
  const w = loadWorker();
  w.addClient('frozen');
  const t0 = Date.now();
  await w.click({ action: 'toggle' }).settled;
  const spent = Date.now() - t0;
  assert.ok(spent < 1000, 'waited ' + spent + 'ms before bringing the app up');
  assert.strictEqual(w.log.focused.length, 1);
});

(async () => {
  console.log('\nnotify — the cover, the tap, and who performs it');
  for (const step of queue) await step();
  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) { failures.forEach((f) => console.log('  · ' + f)); process.exit(1); }
})();
