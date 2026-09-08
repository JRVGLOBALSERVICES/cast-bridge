#!/usr/bin/env node
/* Proof that the nudge which starts a player does not leave the page.
 *
 * The failure: api/scan.js poked the FIRST match of a selector containing
 * a bare `button`, and on tamildude.net the first button is the search
 * field's submit. Every scan of that site navigated the top document to
 * /?s= before the embed had built its player, so a film that was sitting
 * right there reported as "no video on this page" — for a whole day, while
 * the cause was looked for in the CDN.
 *
 * Written against a real browser and the real exported function, because
 * the thing that was wrong was which element got clicked. A test that
 * restates the rule in its own words would have passed against the broken
 * code too.
 *
 *   node scripts/test-poke.js
 */

const assert = require('assert');
const fs = require('fs');

const CHROME = (function () {
  const named = String(process.env.CHROME_EXECUTABLE_PATH || '').trim();
  const tried = named ? [named] : ['/usr/bin/google-chrome', '/usr/bin/chromium'];
  for (const c of tried) { try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (e) { /* next */ } }
  return null;
})();

/* A page shaped like the one that broke it: a search form whose submit
   button carries a play-ish class, a display-classed link (because
   "display" contains "play"), and the actual player below both. */
const PAGE = 'data:text/html,' + encodeURIComponent(`<!doctype html><html><body>
  <form action="/?s=" id="searchform">
    <input name="s"><button type="submit" class="search-play-btn">Go</button>
  </form>
  <a href="/elsewhere" class="post-display-link"><span class="display-thumb">Next</span></a>
  <div class="player-wrap"><button id="play-real">Play</button></div>
  <video id="v"></video>
  <script>
    window.__clicked = [];
    document.querySelectorAll('button,a,span,video').forEach(function (el) {
      el.addEventListener('click', function () {
        window.__clicked.push(el.id || el.className || el.tagName);
      });
    });
    document.getElementById('searchform').addEventListener('submit', function (e) {
      e.preventDefault();               // a real page would navigate here
      window.__submitted = true;
    });
  </script>
</body></html>`);

(async () => {
  if (!CHROME) {
    console.log('  FAIL no browser — this suite proves a click, so it cannot be');
    console.log('       satisfied without one. Set CHROME_EXECUTABLE_PATH.');
    process.exit(1);
  }

  const puppeteer = require('puppeteer-core');
  const { poke } = require('../api/scan.js');
  assert.strictEqual(typeof poke, 'function', 'api/scan.js stopped exporting poke');

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  const failures = [];
  let passed = 0;
  const check = (name, fn) => {
    try { fn(); passed += 1; console.log('  ok   ' + name); }
    catch (err) { failures.push(name + ' — ' + err.message); console.log('  FAIL ' + name + ' — ' + err.message); }
  };

  try {
    const page = await browser.newPage();
    await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
    await page.evaluate(poke);

    const seen = await page.evaluate(() => ({
      clicked: window.__clicked,
      submitted: Boolean(window.__submitted)
    }));

    check('the search form is never submitted', () => {
      assert.strictEqual(seen.submitted, false,
        'poke submitted a form — every scan of that site loses its own page');
    });

    check('nothing inside a form or a link is clicked', () => {
      const bad = seen.clicked.filter((c) => /search-play-btn|display/.test(c));
      assert.deepStrictEqual(bad, [],
        'clicked something that navigates: ' + bad.join(', '));
    });

    check('the real play control still gets its click', () => {
      assert.ok(seen.clicked.includes('play-real'),
        'poked nothing at all — clicked: ' + JSON.stringify(seen.clicked));
    });
  } finally {
    await browser.close().catch(() => {});
  }

  console.log('');
  if (failures.length) {
    console.log(failures.length + ' failed, ' + passed + ' passed');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log(passed + ' passed');
})().catch((err) => {
  console.log('  FAIL the suite could not run — ' + err.message);
  process.exit(1);
});
