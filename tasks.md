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
