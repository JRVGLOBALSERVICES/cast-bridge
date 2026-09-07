# Cast Bridge — tasks

## 2026-09-07 — Rj: neumorphism UI + history storage + in-app browser

- [x] Task 1: Update the UI to our design specs, using the Themesberg Neumorphism UI Kit (Bootstrap) for all components
- [x] Task 2: Add a history storage
- [x] Task 3: Add in-app browser support that detects media for streaming and casting

### 2026-09-07 — verification pass (this session)

- [x] `/api/extract` verified end to end on the dev server: direct mp4
      (`direct:true`), HLS master expanded to 5 real quality variants
      (184p-1080p), HTML page yielding both `<source>` tags, and the SSRF
      guard refusing `127.0.0.1` and `169.254.169.254`.
- [x] Walled-service guard added. Netflix previously returned `ok:true` with a
      marketing trailer mp4 off its own page — a wrong answer, not a missing
      one. Now refuses before the fetch, with `drm` and `app` treated as the
      different problems they are.
- [x] Double-audio bug fixed: loading a new link while already CONNECTED
      played on the phone and the TV at once.
- [x] Idle state collapses the 4-button action row to Cast alone, moving the
      paste box 54px up a 390px viewport.
- [x] robots.txt, llms.txt, favicon.ico added; service-worker BUILD bumped to
      2026-09-07.4 so installed copies actually update.
- [x] hallmark audit: 0 critical, exit 0.

## Round 3 — 2026-09-07 (Rj: "no changes, doesn't scan, no login")

- [x] Task 8: Password gate — signed HttpOnly cookie, constant-time compare,
      per-IP throttle. `/api/extract` and `/api/scan` refuse an unauthenticated
      caller. Gate makes the shell `inert`, not merely covered.
- [x] Task 9: Deep scan (`/api/scan`) — headless Chromium runs the page's
      JavaScript and watches the network for playable media. This is what the
      Android app does behind its "in-app browser".
- [x] Task 10: Honest empty result — a page with no findable player returns
      `ok:false, empty:true, canDeepScan:true` and says why, instead of the
      `ok:true, media:[]` that made a blind scan look like a working one.
- [x] Task 11: Build stamp read from the running service worker + a reload
      prompt, and BUILD stamped from the commit at deploy time so an installed
      copy can never silently keep serving an old shell.

## Round 4 — 2026-09-07 (Rj: login broken, multi-user, dull login, PWA, pull-to-refresh, video test)

- [x] Task 12: Login for `rjnflix1` fixed. Root cause was NOT the hash or the
      code: the Vercel project carried only the dead v1 vars (`CAST_PASSWORD`,
      `CAST_SECRET`) and none of the four the v2 auth path reads, so
      `db.configured()` was false and `/api/auth` answered 503 before it ever
      compared a password. Set `CAST_SUPABASE_URL`, `CAST_SUPABASE_SERVICE_KEY`,
      `CAST_ADMIN_USER`, `CAST_ADMIN_PASSWORD` on all three environments.
      Verified end to end: correct password signs in, wrong password refused,
      cookie issued, session reads back.
- [x] Task 13: Auth hole found and closed. `byUsername()` queried PostgREST with
      `ilike.`, where `%` and `_` are wildcards, and the username pattern is only
      enforced on CREATE, never on sign-in — so `rjnfli%` plus the owner's
      password signed the caller in AS the owner. Proved against a running
      server before the fix and again after. Now `eq.` on a normalised
      lowercase value, with a unique index on `lower(username)` and a CHECK
      constraint so no other write path can reintroduce a second spelling.
- [x] Task 14: Multi-user isolation verified live on 9 vectors — own-history-only,
      `scope=all` refused, `?user=<other id>` refused, cross-user DELETE refused,
      `/api/users` refused, privilege escalation refused, forged `user_id` in the
      POST body ignored (the row landed under the caller), admin sees all with
      names, no-cookie refused.
- [x] Task 15: Schema committed to the repo as `db/001_castbridge_schema.sql`.
      It previously existed ONLY in the database — applied by hand, recorded
      nowhere, so no fresh environment could reach a working state.
- [x] Task 16: Login screen rebuilt. The old one tripped three named anti-slop
      signals at once: centred-everything symmetry, an indigo/violet accent, and
      a decorative arc that read as nothing. Now asymmetric and left-anchored,
      ember accent, an 18-bar signal meter occupying what was dead space, type
      scale carrying the identity. Contrast measured on the rendered DOM, not
      from the token table: mark 18.34:1, ember 7.09:1, button ink 6.69:1,
      inputs 16.52:1 at 16px so iOS cannot zoom the viewport on focus.
- [x] Task 17: PWA verified installable in-browser rather than assumed from the
      manifest: manifest 200, `standalone`, root scope, all five icons resolve
      200 including maskable 192 + 512, service worker registered AND active.
      Splash and theme colour moved off the dead navy `#0d1120` to `#08070a` so
      the launch screen matches the first surface painted. Removed a duplicated
      `/manifest.json` from the precache list — `addAll()` rejects atomically,
      so a duplicate is a needless way for the whole install to fail.
- [x] Task 18: Pull-to-refresh audited against RJ-Design-Skill
      §navigation-and-feedback §6 and left alone — it already satisfies all six
      rules and guards double-fire. Working code was not rewritten.
- [x] Task 19: Video extraction run against Rj's two test links, both of them,
      no substitutes. Quick scan: empty on both. Deep scan on the code as it
      stood: empty on both, with a message blaming a sign-in. Only one of those
      two answers was right, and it was right for the wrong reason.
      desicinema.org ships its player as `<iframe src="about:blank">` with the
      real address in `data-litespeed-src`; the scan watched a blank frame for
      its whole budget. It now promotes deferred iframe addresses, scrolls to
      trip the lazy-loader, and pokes the play control inside every frame,
      twice, because an embed builds its inner frame after it boots. The frame
      is now found and opened (`saw.frames: 1`, previously nothing) — but no
      stream is captured from that host even so; see issues.md.
      groundbanks.net has no video on it at all: zero media elements, and its
      only iframe is a zero-pixel tag-manager pixel. An empty deep scan now
      reports whether a player was on the page, so "there is nothing here" and
      "there is a player here that gave us nothing" stopped sounding alike.

- [x] Task 20: Followed up on the two test links after Rj said go. Three real
      defects found and fixed, each general rather than one site's quirk:
      (a) media elements were read from the top document ONLY, so a player
      inside an iframe — which is nearly every embedding site — was invisible;
      (b) the same for the evidence count, which reported `players: 0` for a
      page carrying three video elements two frames down; (c) the scan clicked
      before it counted, and these embeds sell the first click
      (`download-page-link.js`), so clicking navigated the player frame away
      and destroyed the very thing being measured. Sampling now happens before
      each round of pokes and only ever rises. Added a trusted CDP gesture for
      players that test `isTrusted`, kept OUT of the top document because a
      real click on desicinema's own 1138x573 play-classed wrapper tears down
      the player frames. Replaced the two fixed poke passes with a watch loop —
      the fixed gap was a coin flip that reported 3 players on one run and 0 on
      the next. Verified: desicinema now reports `players: 3, frames: 1` on
      three consecutive runs (was 0/1, non-deterministic), groundbanks still
      correctly reports no video, and a page that does carry a stream still
      resolves it. desicinema still yields no castable address, and issues.md
      now records exactly why rather than guessing.

- [x] Task 21: Login screen rebuilt in the app's own design system. It was a
      dark ember screen — deliberately, on the theory that "the door is not the
      app" — and Rj's read was that it made the app look like it started
      somewhere else. Every value on the gate is now a token off `:root`: the
      Neumorphism surface `#e6e7ee`, the pressed inset field matched against
      the computed style of `#url` on the Link tab, the accent `#2d4cc8`, the
      kit radius, and the same focus ring the app puts on everything. What
      keeps it from being a centred grey card is the composition, not the
      palette: left-anchored, bottom-weighted, with the signal meter holding
      the top half. Measured on the live DOM at 390px — mark 7.23:1, accent
      word 5.72:1, labels and footnote 5.80:1, field ink 7.23:1, button ink on
      accent 6.15:1, all AA. theme-color and the manifest splash moved off the
      dead navy to the surface the app actually paints, so the browser chrome
      no longer changes colour on sign-in.

- [x] Task 22: Mobile horizontal overflow fixed. The device pill carried
      `flex: none`, written when it only ever said "no devices" — a real TV
      announces itself as "Living Room Samsung QLED (Chromecast built-in)" and
      ran 77px past the right edge of a 390px phone. `body { overflow-x:
      hidden }` swallowed that in Chrome, which is why it measured clean here
      while the phone panned sideways. The pill now shrinks and the name
      truncates, with the full name on `title` so it stays reachable. Verified
      at 390/360/320: pill capped at 215px, right edge 374 on a 390 screen,
      nothing else on the page overflows in any tab or at any width.
      Worth knowing for the next verification: the first read of this fix came
      back clean because the SERVICE WORKER was still serving the old
      stylesheet. Clear the SW and its caches before trusting a local check.

- [x] Task 23: Deep scan now reads what a page hands its own player, not only
      what crosses the wire. Hooks are installed in every frame before its
      scripts run — media-element `src`, `setAttribute`, `fetch` and `XHR`
      response bodies, `JSON.parse` and `atob` — so an address that only ever
      exists inside a response body is captured. Proven, not assumed: on a page
      that receives its address in JSON and then stalls without requesting it,
      the old path sees nothing and the new one returns it. No regression — a
      page that does carry a stream still resolves two sources, and groundbanks
      still correctly reports no video at all.
      desicinema still yields nothing, and now for a proven reason rather than
      a guess: see issues.md.

- [x] Task 24: The pill fix was real and invisible. Source measures clean at
      390/360/320 — pill capped at 215px, right edge 374, document scrollWidth
      exactly 390, nothing overflowing. What Rj sees on his phone is the
      SERVICE WORKER: shell assets were cache-first with a background refresh,
      while navigations are network-first. Every deploy therefore paired a
      FRESH index.html with the PREVIOUS build's app.css and app.js on the
      first launch. Not merely stale — mismatched, which is how a shipped
      layout fix stays invisible on the phone and measures clean everywhere
      else. This is the same fault that made an earlier local check pass
      falsely, so it has now cost two verifications. Shell assets are
      network-first; the cache is the offline fallback only.

- [x] Task 25: Pull to reload works on the login screen. Two independent
      reasons it could not: the listeners were bound to `.cb-shell`, which
      carries `inert` while the gate is up so no touch inside it dispatched;
      and touchstart bailed outright on `body.is-gated`. Bound to the document
      instead, with a scrolled-ancestor guard so a pull that starts inside a
      list scrolled down is still read as a scroll. The ring was also painted
      at z-index 60 under a gate at 90 — raised to 95. On the gate there is no
      data to re-read, so the pull means what it says: ask the worker for an
      update, then reload. Verified with a real CDP touch drag on the gate —
      ring reaches full opacity, arms at the threshold, page reloads on
      release. Threshold, resistance, handoff, haptic, overshoot and a live
      list are all unchanged.

- [ ] Task 26: desicinema. Not done, and not going to be by this route —
      see issues.md. The scanner is unchanged; the answer is a decision.
