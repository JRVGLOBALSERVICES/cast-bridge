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
