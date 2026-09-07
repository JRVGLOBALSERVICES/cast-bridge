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
