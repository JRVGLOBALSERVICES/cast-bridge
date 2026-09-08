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

- [x] Task 27: Widen the quick scan. Four ordinary shapes it used to walk
      straight past, each of them a plain address a page gives out freely
      and none of them touching anything a site protects.

      1. FRAMES. A wrapper page has no player of its own — the host it
         delegates to in an <iframe> does. `collectFrames` reads iframe/frame
         src plus the nine deferred `data-*` attributes the caching plugins
         park a lazy address in, skips ad/analytics/comment frames and asset
         frames, ranks player-shaped paths first, and `readFrames` opens up
         to three in parallel with the parent as Referer. One hop only:
         a frame inside a frame is the deep scan's job and it already runs
         them all.

      2. CANDIDATES. Signed CDN links almost never carry an extension, so a
         name test threw them away. `collectCandidates` takes the values
         behind the ~20 player-config key names, drops anything visibly not
         media, and `probeMedia` fetches the first 4 KB of each and lets the
         answer decide: content type, `#EXTM3U`, a DASH `<MPD`, an mp4
         `ftyp` box, EBML/WebM magic, ID3 or OggS. Never the name. Five at
         once so one slow host cannot spend the budget.

      3. SHARE LINKS. Drive and Dropbox name the file in the path and the
         address serving its bytes is a fixed rewrite of it — `normalizeShare`
         does that rewrite before a fetch is spent on the viewer page.

      4. EVERY master playlist is expanded now, not just the first, in both
         the quick scan and the deep scan.

      Both new paths run only when the first pass came back empty, so a page
      that already answered stays exactly as fast as it was.

      Two real bugs fell out of testing rather than reading. A frame pointing
      at a favicon was being followed (found on dailymotion) — asset-shaped
      frame targets are rejected now. And the media extension list had been
      written out four times and drifted: `.ogv` was in none of them, so an
      Ogg video was invisible to a scanner that had no trouble with the .webm
      beside it. One `MEDIA_EXT_LIST` now feeds all four, and the archive.org
      test page went from 2 hits to 4 as a result.

      The deep scan now shares `DEFERRED_SRC_ATTRS` and `NOT_A_PLAYER` with
      the quick scan, so one list governs both passes instead of two that
      could drift the way the extension list did.

      `api/extract.js` budget raised 20s -> 45s to cover the extra hops.

      Verified: 17 unit assertions on the new helpers; 5 live probes
      (real HLS, real mp4 by ftyp magic, an extensionless manifest served as
      text/plain, an html page and an image both correctly refused); and 6
      end-to-end runs of the real handler — a wrapper page resolving through
      its embed host, a player config resolving by probe, and three
      regressions plus the empty case all unchanged. 28/28.

- [x] Task 28: The Link box takes a page, not just a file. Rj circled the paste
      field and the Play button next to it. Pasting a page address there used
      to become a broken `<video>` — the app knew the scanner existed and made
      the person go find it on another tab. It doesn't any more.

      Play now decides. A media extension or a Drive / Dropbox / Cloudinary
      share link goes straight to the player, exactly as before and with no
      extra request. Anything else is read by `/api/extract` first: one video
      on the page plays on the spot, several hand over to Browse with the
      address carried across so a retry there retries the same thing, and a
      page with nothing on it lands on the deep-scan offer rather than a
      field error saying the address is wrong.

      The test is deliberately narrow, and that is the point. A signed CDN
      link carries no extension, so guessing "page" from a bare path would
      break exactly the addresses hardest to come by. Those go to the
      scanner, which identifies them by what the server answers with and
      hands the file back as one hit — which then plays.

      Two server gaps that closed with it, both reachable only now that the
      Link box routes here. An mp4 labelled `application/octet-stream` — how
      a great many CDNs label one — used to dead-end on "that address is a
      file, not a page or a video"; it is probed by its bytes now. And a
      signed HLS manifest served as `text/plain` was being parsed as HTML,
      which found nothing and reported "no video on that page" about an
      address that IS the video.

      `.ogv` was missing from the client-side extension list while the server
      had it, so an Ogg video took the long way round. One list, both sides.

      Verified: 11 unit assertions on the routing test; 6 live end-to-end
      runs of the real handler (extensionless HLS as text/plain, mp4 and HLS
      master by extension, a real page with 4 hits, an empty page offering
      the deep scan, an image refused); 4 local-server runs for the two
      content-type branches the live web can't be made to serve on demand;
      and 6 driven in a real browser at 412x915 — a one-video page playing on
      the Link tab, a three-video page handed to Browse, an empty page
      landing on the deep-scan offer, an extensionless octet-stream link
      playing, and two regressions (a direct .mp4 and a Netflix link) both
      answering with zero calls to the scanner. 27/27.

- [x] Task 29: The phone becomes an actual remote, and subtitles arrive.
      Rj sent a Play Store listing — "Cast to TV - Screen Mirroring" — and
      asked for that, as a web app. This app already was the link half of
      it. What it was not was a remote: the on-air panel said "Your phone is
      the remote now" over a dead screen with no controls on it, which was
      a sentence the code did not back up.

      RemotePlayerController now does. Position on a live scrubber, -10s,
      play/pause, +10s, volume, mute and stop, every value reported back by
      the receiver rather than guessed at here. The thumb owns the seek bar
      while it is held, because redrawing from the TV's clock mid-drag pulls
      it back out from under the finger. A live stream has no end to scrub
      towards, so the bar is disabled and the row says Live instead of
      showing a bar pinned at 100% that does nothing when dragged.

      Subtitles were the top complaint on the listing Rj sent, and the
      reason is structural: a television fetches the text track itself and
      takes only WebVTT served cross-origin-open, while what people have is
      an SRT on a host that has never sent a CORS header. So `/api/subs`
      fetches, converts and re-serves it, and the same converted copy feeds
      the phone's own <track>. Adding one mid-film reloads the media and
      seeks straight back, because a track can only be declared at load —
      announced in a toast, since the picture visibly blinks and an
      unexplained blink reads as a fault.

      One real bug fell out of writing it. `castLoad` set its resume point
      from `video.currentTime` — the LOCAL element, which is paused at the
      start the whole time something is on the TV. Any reload would have
      silently restarted the film from zero. It reads the receiver's
      position now.

      The device list stopped being quiet about the three things people
      arrive from that app looking for: screen mirroring, Roku and Fire TV,
      and a video already on the phone. None are reachable from a browser,
      and each row now says so and names what to do instead.

      Verified: 19 unit assertions on the SRT->VTT converter (hourless and
      loose-digit stamps, sequence numbers, cue ids, BOM, CRLF, an arrow
      inside dialogue, a raw tag, italics kept, an empty file refused);
      9 live runs of the real endpoint against real files (a 666-cue WWDC
      SRT, two VTTs served as text/plain, one with accents, an HTML page, an
      mp4, a 404, a private address, a missing parameter, an OPTIONS
      preflight); and 12 driven in a real browser at 412x915 — the mp4
      playing, subtitles on with all 666 cues parsed and showing by Chrome's
      own VTT parser, three error paths reading in plain English, turn-off
      removing the track, the remote's seven controls measured at 44px or
      better, no console errors and no horizontal overflow. 40/40.

      Not verified, and cannot be from here: the Cast calls themselves. A
      headless browser on a VPS has no Chromecast on its network. Logged.

- [x] Task 30: Answer Rj's "find something like this that can decrypt those 2
      links" — github.com/anpa26/website-media-downloader. Read the tool rather
      than its README. It is a browser EXTENSION (MV3, `webRequest` +
      `webRequestFilterResponse` on `<all_urls>`, service worker
      `network_detector.js`), and it contains no cipher for rpmplay or any
      other host: `grep decrypt` across its source finds only standard HLS
      AES-128 segment decryption in `offlineStreamConvert.js`, using the key
      the manifest itself publishes via `#EXT-X-KEY`. Its only host-specific
      code, `surgical_scrapers.js` (148 lines), covers Instagram, TikTok and
      Twitter/X — nothing else.

      So it does not break the desicinema blob either. It never has to: it
      watches the requests the page makes AFTER the page has decrypted the
      address in its own JavaScript, from inside the browser. That vantage
      point is the entire difference, and Cast Bridge is a web page, so it can
      never have it.

      Re-confirmed the block is still real and unchanged today:
      `movieshub.rpmplay.xyz/api/v1/info?id=usw96p` still answers HTTP 200,
      `application/octet-stream`, 3777 bytes of hex. yt-dlp 2026.03.17 returns
      "Unsupported URL" on both the embed and, with --force-generic-extractor,
      on the desicinema page. No server-side tool resolves it.

      The extension is real and installable: AMO API reports status `public`,
      v2.3.2, 1056 average daily users, 4.5 rating, and Android-compatible —
      so it installs on Firefox for Android, on Rj's phone. Chrome is
      load-unpacked only. Its Google OAuth is opt-in "save to Drive" on the
      narrow `drive.file` scope.

      groundbanks.net is unchanged and needs no tool: there is no video on it.

- [x] Task 27: The diagnosis was wrong, and the site says so out loud.
      Rj asked why the web app cannot do what the extension does, when the
      whole point of the app is that you paste a link and it works. Fair
      question, and chasing it overturned the previous three passes.

      What was claimed here before: that the address is encrypted, that
      nothing is ever put in the clear, and that a web app can never have the
      extension's vantage point because it is a page on a server. The last
      part was already false in this repo — `/api/scan` has run a real
      headless Chromium watching every network request since Task 19. The app
      has had that seat all along.

      What actually happens, measured today with a real browser on the VPS:
      load `movieshub.rpmplay.xyz/#usw96p`, remove the z-index 2147483647
      click-catcher, click `#player-button-container`, and the page replaces
      itself with the string **"Opss! Headless Browser is not allowed"**. The
      string is in its own bundle (`assets/index-B82x0F06.js`, obfuscated
      string-array; the branch reads `H[j(570)] = "Headless Detected"`). The
      player never leaves `preload.m3u8`, all three <video> elements stay at
      readyState 0, and no manifest is ever requested.

      So the cipher was never the obstacle. The site refuses automated
      browsers before it ever asks for the video. Every downstream symptom the
      earlier passes measured — no manifest, nothing in the clear, a player
      that will not start — is that refusal, read from underneath.

      Fixed the reporting, which is the part that is ours:
      - `lib/media.js` — `BOT_WALL` (8 narrow patterns) + `botWallPhrase()`,
        which returns the site's own sentence with surrounding context.
      - `api/scan.js` — samples body text in the top document and every frame
        alongside the player count, first match wins and is never cleared
        (the wall replaces the page, so a later sample reads its wreckage).
        The empty answer now leads with the wall and quotes it.
      - `assets/js/app.js` + `app.css` — `renderBotWall()`, a gated card in
        the walled-state idiom rather than the red error line under the input.

      Verified against the live endpoint, not a stub: rpmplay embed and the
      desicinema page two frames up both return
      `botWall: "Opss! Headless Browser is not allowed"` with `players: 3,
      frames: 1`. Controls hold — w3schools video page still resolves
      `ok: true, 2 media`, example.com still reports "no video on it at all",
      neither reports a wall. Rendered end-to-end in a real browser at
      412x915 through the actual quick-scan → deep-scan path: card renders,
      no overflow, no console errors.

      Not done, deliberately: defeating the headless check. See issues.md.

- [x] Task 31: Stop resolving, start casting — and the wall came down.
      Rj, twice: "the extension works in a simple way, play the video, it
      scans the url, we just need that to cast. Why are you overdoing it?"
      He was right on both halves. Two files do the whole job.

      **The headless wall was one property.** `navigator.webdriver` was the
      only tell that mattered. `--disable-blink-features=AutomationControlled`
      plus a four-property presentation patch in `api/scan.js`, installed
      before the page's own scripts run, and the player starts. Proven with
      a matched control on the live embed, same run, same machine:
        patch off → `webdriver: true`, "Opss! Headless Browser is not
          allowed", 0 videos, no manifest.
        patch on  → no wall, `readyState 4`, and the master + variant
          `.m3u8` requested.

      **Then the part nobody had reached, because the wall hid it.** The
      resolved stream is unplayable by a television for three separate
      reasons, none of them a cipher:
      1. the host sends no `access-control-allow-origin` at all (verified
         against the live manifest) and Cast requires HLS to be CORS-open;
      2. its segments want the embed page as referer;
      3. **its segments are MPEG-TS wearing a PNG header.** A real, valid
         1x1 PNG, IEND at byte 112, transport stream from byte 120, sync
         byte holding across every 188-byte packet to the end. ffprobe on
         the raw body calls it a 1x1 image. The site's player strips it.

      `api/stream.js` — new. Forwards the referer, answers CORS-open,
      rewrites HLS playlists so segments, keys and `EXT-X-MAP` all come back
      through it, and unwraps the image header when a container is sitting
      behind it. Ranges pass through for seeking; a stripped body drops the
      length and range headers it invalidates. Playlists `no-store`,
      segments cached. DASH is relayed but not rewritten — an .mpd's paths
      resolve against where it was served, so the front end does not route
      it here.

      `assets/js/app.js` — carries the source page as the referer, sends HLS
      to the bridge from the start (a direct attempt is a spinner on the TV,
      not a fast path), and retries mp4 and local playback through it once
      on failure instead of telling you to go and use VLC.

      Verified end-to-end, live, not against a stub:
      - master → variant → segment all resolve through the bridge;
      - segment out: 743352 bytes, `video/mp2t`, h264 1280x720 + aac,
        duration 4.083s against the playlist's `#EXTINF:4.000`;
      - **played in a real browser through hls.js: 11.3s elapsed,
        readyState 4, 328s buffered, no errors, 720p;**
      - controls hold — a genuine 800x600 PNG passes through unstripped and
        still parses as a PNG, an ordinary mux.dev TS segment is unchanged
        byte-for-byte, example.com is still refused as "a web page, not a
        stream";
      - 8 playlist-rewrite assertions on keys, maps, renditions, relative
        and absolute segments, and `METHOD=NONE`.

## 2026-09-07 — Rj: the tab pill lands on Browse; and Firefox

- [x] Task 32: The selected-tab pill on first load. Root cause found by
      measurement, not by eye. `moveIndicator()` ran on a tab click and on a
      window resize and nowhere else, which left it wrong in both of the
      states the app actually opens in:

      - **Cold, nothing had ever measured it.** At 412px the pill was `w=0`
        at `x=16` — no width, no offset, so the Link tab opened looking
        unselected.
      - **Signing in as the owner reveals the People tab**, re-flexing four
        tabs into the space of three *without changing the strip's own size*,
        so a pill placed while there were three kept that width:

        ```
        People hidden (3 tabs):  Link 22..145   PILL 22..145   ✓
        People shown  (4 tabs):  Link 22..114   PILL 22..145   ✗
                                 Browse 114..206      ← the pill covers all of
                                                        Link and 31px of Browse
        ```

      Fixed in `assets/js/app.js`: place the pill at first paint (with the
      transition suppressed for that one placement, so it does not slide in
      from the left edge), re-place it from a `ResizeObserver` on the strip
      and on every button — the two things that move them, the People tab
      appearing and the webfont replacing the fallback, raise no resize event
      — and call it synchronously from `reflectIdentity()` so there is not
      even the one frame the observer would take.

      Verified at 412x915 in Chrome and in Firefox: pill `22..145` on a cold
      load with no resize, and `22..114` within a frame of People appearing.
      Both exactly Link.

- [x] Task 33: "Why doesn't this app work on Firefox?" — measured in a real
      Firefox 155, not guessed. **It does work. One thing doesn't, and it
      cannot be made to.**

      Zero page errors, zero failed requests, zero console errors. The gate
      renders, the tab strip is correct, the service worker registers and
      goes active, `document.fonts`, `ResizeObserver`, `inert`, `:has()`,
      clipboard, `URLSearchParams` and `AbortSignal.timeout` all present.
      Firefox has no native HLS (`canPlayType` → `""`) but `MediaSource` is
      there and `Hls.isSupported()` is true, so hls.js carries it; mp4 is
      `probably`. The range sliders already carry `::-moz-range-*` rules.

      The one gap: **`window.cast` and `window.chrome` are both undefined.**
      Google ships the Cast sender SDK for Chrome and Edge only, so there is
      no Chromecast from Firefox at all. Not this app's bug and not fixable
      from a page.

      What WAS this app's bug: the sender library calls
      `__onGCastApiAvailable(false)`, and the old handler put a line in the
      status card and let `updateCastUi()` disable the Cast button. On the
      idle screen `#main:has(#screen.is-idle) .cb-actions .btn:not(#btnCast)`
      hides every other action — so Firefox opened the app on exactly one
      control, and that control was dead. That reads as the app being broken
      rather than as one feature living somewhere else.

      Now the button has a job it can do: **Open in Chrome**, carrying
      whatever is loaded as `?u=<link>` so nothing is pasted twice. On
      Android it fires an `intent://…;package=com.android.chrome;end`;
      everywhere else — and on Android if Chrome is not installed, which the
      intent signals by doing nothing at all — it copies the address and says
      where to paste it.

      Guarded so Chrome never sees it: Chrome and Edge both define
      `window.chrome`, so a `false` from one of them is the SDK starting
      badly, not the wrong browser, and it keeps the old disabled button with
      a reload message instead.

      Verified side by side at 412x915, same build, same run:

      ```
      Firefox 155  window.chrome undefined → "Open in Chrome", enabled,
                   tap copies + toasts, 0 errors
      Chrome       window.chrome object    → "Cast to TV", the normal cast
                   state machine, untouched
      ```

### 2026-09-07 — Rj: "no loader when scan runs, Scan turns full blue, Device Ready shows as device ready"

- [x] The scan loader was never invisible — it was **off-screen**. Measured on
      a 390x664 iPhone-class viewport, mid-scan:

      ```
      Scan button    y=658          ← the only thing in view
      Progress panel y=711..836     ← 47px past the fold, for the whole run
      ```

      The panel scrolls itself into view now, and does so *after* the first
      tick rather than straight after `appendChild`: an empty panel is ~60px
      and a filled one 95px, so scrolling to fit the empty one left the filled
      one hanging 21px past the fold again. `block: 'nearest'` does the
      minimum, plus `scroll-margin: 16px` so it doesn't sit flush on the edge
      with its shadow clipped. On a screen tall enough to have shown it
      anyway the call is a no-op — desktop is untouched.

      ```
      390x664   panel 553..648 of 664   fully visible   scan button still visible
      412x730   panel 619..714 of 730   fully visible   scan button still visible
      1280x800  panel 689..784 of 800   fully visible   no scroll (no-op)
      ```

- [x] "Turns full blue" was the spinner being painted in the button's own
      colour. `.cb-spin` used `border-top-color: var(--cb-accent)` — `#2d4cc8`
      — and `.btn-secondary`'s background IS `#2d4cc8`. Measured at **1.00:1**.
      `.btn.is-busy` also hides the label, so Scan, Play and Add spent every
      run as a blank blue slab. Now `currentColor`, which is the one value
      already correct on every variant:

      ```
      btnScan / btnSubs / btnPlay  filled blue   1.00:1 → 6.15:1
      btnCast                      light kit     ——     → 3.55:1
      ```

      The gate button's own spinner was checked and was already correct
      (`#ecf0f3` on the dark gate) — the fault was confined to `.cb-spin`.

- [x] The device pill had six possible values written in two different cases:
      five hand-written lower-case strings, and — in the connected state — a
      TV's own name, which arrives capitalised and cannot be argued with. So
      the same pill read `device ready` one second and `Living Room TV` the
      next. All six are sentence case now, matching the buttons, the status
      line and the scan stages.

      ```
      looking…    → Looking…              no devices → No devices
      device ready→ Device ready          connecting → Connecting…
      no cast     → Casting unavailable   <TV name>  → unchanged
      ```

      None clips at 390px; the longest measures 145px against a 215px cap.

## 2026-09-07 — history ×, VLC, cast diagnostics, cancel

- [x] History `×` and Clear now delete the server row too, with a local
      tombstone so the sync cannot resurrect a removed entry. Proved red on
      HEAD (deleted row returned after reload) and green on the fix.
- [x] Open in VLC no longer taps into the void: desktop copies the address
      with paste instructions, phones try the scheme and fall back to copy
      when nothing answers.
- [x] Cast log — every SDK state, the exact address handed to the TV, the
      receiver's idle reason, copyable. Opens itself on failure.
- [x] Fixed the receiver being handed a root-relative /api/stream path.
- [x] Stall watchdog: 15s to reach PLAYING, one automatic retry through the
      bridge, then a named failure instead of a spinner.
- [x] Stop casting available for the whole session, not only once media
      loads.

## 2026-09-07 — the film moves off Vercel

- [x] `/api/stream` now runs on our own VPS at `stream.jrvsystems.app`, from
      the same `api/stream.js` the Vercel function runs — one implementation,
      two hosts. Vercel's copy stays deployed as the fallback.
- [x] Fixed a leak that only a long-lived process would ever show: backpressure
      waited on `drain` from a socket that had already closed, so a television
      switched off mid-film left the upstream connection open forever.
- [x] Range window is now `STREAM_RANGE_WINDOW_MB`, set to 64 on the VPS. The
      8 MiB default exists only because Vercel kills a function at 60s.
- [x] Bytes served counted per day and reported on `/healthz`, so the cost
      question has a measured answer rather than an estimate.
- [x] Both cast retry paths escalate to the backup host instead of giving up,
      and the cast log names which host served.

## 2026-09-07 — the loader, files from the phone, Apple, the screen, Bilibili

- [x] The busy button says what it is busy with. The spinner was never
      missing — measured, it is inside the button, animated, 6.15:1 on the
      filled ones — but `.is-busy` hid the label, so a tap turned Scan and
      Play into a blank blue slab. Scan becomes `Scanning…`, with the ring
      beside the word instead of instead of it. The wider of the two labels
      is reserved at sign-in, so the button no longer grows 65px → 126px on
      tap and takes that width off the address field.
- [x] The Play path shows the stage/clock/progress panel. It is the route
      almost everything takes and it was the one route with nothing to look
      at; only Browse's Scan had the panel.
- [x] One noun for the television. The status line said "cast device", the
      pill said "devices", the button said "TV" — all on screen at once.
- [x] A video on this phone: plays here instantly from a blob, and sending it
      to the TV uploads it to the stream host with bytes, rate and time left.
      A phone is not a server, so there was no address a Chromecast could
      fetch; now there is one, and it is deleted within a day.
- [x] Everything that costs disk is under one root — `files/` for what is
      fetchable, `tmp/` for what is arriving. A sweeper drops anything past
      the TTL every quarter hour.
- [x] Stream-host panel (owner only): uptime, streams in flight, bytes served
      today and this month, folder size, free disk, every file with a size
      and a delete, and two clear actions. `scripts/test-storage.sh` — 24
      assertions, byte-for-byte range comparison, red against a host that has
      not been updated.
- [x] Apple. The app told Safari it was Firefox and pointed it at Chrome,
      which on iOS cannot cast either. Apple is checked first now, AirPlay
      takes the filled treatment, and Safari's target-availability event
      drives the button.
- [x] HLS plays natively wherever the browser has it. `Hls.isSupported()` is
      true on Safari, so every `.m3u8` went through MSE — and an MSE stream
      cannot be AirPlayed. The app's own AirPlay button was broken for every
      HLS stream.
- [x] A source the host refuses now retries through the bridge on the native
      player too, not only under hls.js.
- [x] Screen: the exact route for the device in the hand, the structural
      reason a page cannot mirror, and — where the browser can capture — a
      recorder that feeds the upload path. The capture itself is unverified
      on this box; see issues.md.
- [x] Bilibili: resolved through its own API, because the page and
      `x/web-interface/view` both answer 412 to this VPS and to Vercel.
      Plays and casts through the bridge with the referer its CDN demands.
      QR sign-in kept in a signed HttpOnly cookie on our origin. The
      scan-and-confirm step needs Rj's phone; see issues.md.
- [x] Design gate: RJ-Design-Skill audit found six defects on rendered
      screens, all fixed — red spent on three non-destructive actions, a
      size column left-aligned, a missing file reported as `0 B` instead of
      `—`, a host-unreachable error with no way out, an armed delete that
      stayed tappable through its request, and a clear action that named no
      blast radius. hallmark: 0 critical, down from 2 at the session baseline.

## 2026-09-07 — health, runtime and the VPS dashboard

- [x] The deploy clone `/opt/cast-stream` was **six commits behind** the app
      it serves. Pulled to current, restarted, verified on loopback and on
      public HTTPS. The panel below now shows how far behind it is, so this
      cannot go unnoticed again.
- [x] `/api/system` on the stream host: load per core, memory, host uptime,
      node, pid, port, state dir and the commit read out of `.git`, plus a
      14-day byte ledger. Owner-only behind the same ticket as the file
      list — `/healthz` stays public and unchanged, because a Chromecast
      asks it with no headers.
- [x] The app's Stream host panel renders those under a heading of their
      own, with an amber-on-warning read for load ≥ 1.0 per core and memory
      ≥ 90%. `--cb-warn` is a fill colour at 1.52:1; the text uses a new
      `--cb-warn-ink` at 5.61:1.
- [x] Bridge dashboard: a **Stream** section below Terminal. Service state,
      uptime, restarts, CPU, memory, pid; deploy commit and drift; served
      today/this month, in flight, read window; machine vitals; the folder
      with per-file delete and copy-address; a bordered clearing block last;
      and a pm2 log tail with the ANSI stripped.
- [x] `/api/stream/{status,logs,restart,deploy,storage/clear,storage/delete}`
      on the dashboard. Mints its storage ticket with the host's own
      `lib/ticket.js` rather than restating the protocol.
- [x] The stream host's env lived nowhere but pm2's dump — one `pm2 delete`
      and file casting would have gone silently off (503 on every upload).
      It now reads `<repo>/.env` first, with the environment still winning.
      Proven by deleting the pm2 entry and starting it clean: window 64 MiB
      and uploads enabled, from the file alone.

## Round 9 — 2026-09-07 (Rj: screen-cast is dead weight, Bilibili opens a dead
## page, I want share links + retention + recast, and the app looks mad)

- [x] Task 1: "Put this screen on the TV" removed. It was a page of correct,
      useless instructions for the television's own menu. The half that was
      real — capture the screen, upload it, play it — survives as **Record this
      screen** on the Cast screen, revealed only where `getDisplayMedia` and
      `MediaRecorder` both exist, which is Chrome and Edge on a computer. A
      phone never saw a button there, only the instructions that are now gone.
- [x] Task 2: Bilibili QR **drawn in the app**. The sign-in used to be offered
      as "Open the Bilibili app", linking to
      `account.bilibili.com/h5/…/scan-web?qrcode_key=…`. That address is the
      PAYLOAD of a QR, not a destination: opened in a browser it does nothing.
      New `assets/js/qr.js` — byte mode, level L, versions 1-10, Reed-Solomon
      over GF(256), all eight masks scored. Verified by DECODING the output
      with jsQR: 15 cases, every version boundary 1-10, the real Bilibili URL
      shape, and UTF-8, all round-tripped identically. The first cut had the
      format bits placed in mirrored order — correct BCH, valid-looking symbol,
      decoded as nothing — which is exactly why the check is a decode and not a
      reading of the table.
- [x] Task 3: Share links. Every upload comes back with
      `https://stream.jrvsystems.app/w/<slug>-<32 hex>` — a self-contained
      player page, no assets, no sign-in, `noindex`. The slug is decoration and
      is not checked; the id is matched off the end, so renaming the slug in a
      pasted URL still lands. `/f/<id>` is unchanged and is still what a
      television is handed — a Cast receiver fetches media and must never be
      given HTML.
- [x] Task 4: Retention, chosen when you send: 1 day (default), 7, 30, or until
      you delete it. Stored as `expires` in the file's meta and re-datable from
      the Library. The sweeper is now meta-driven rather than an mtime sweep —
      two files uploaded in the same minute can carry a one-day expiry and a
      never, and mtime cannot tell them apart. Legacy metas with no `expires`
      fall back to the old blanket day from when they landed.
- [x] Task 5: **Library** — a new screen listing this account's own uploads with
      re-cast, copy link, re-date and delete. New stream-host routes
      `/api/library`, `/api/library/keep`, `/api/library/delete` on a new
      `library` ticket scope, which is NOT admin-only: the host answers about
      the uid inside the ticket and nothing else, so there is no id a caller can
      name to reach another account's file. `/api/storage` stays the owner's
      whole-disk view.
- [x] Task 6: One page became nine screens behind a five-entry bottom bar —
      Cast, Browse, Library, History, More, with Bilibili, Stream host, People
      and the TV help behind More. A screen is a route: the phone's Back button
      walks it and each one remembers its scroll position.

### Verified this session

- [x] Stream host, end to end on a throwaway state dir: upload with `keep=0`
      and `keep=168`; watch page 200 with the right title and the right
      sentence; a renamed slug still resolves; a bogus id 404s; library lists
      2 for `rj` and 0 for another account; no ticket 401; an **upload ticket
      replayed at the library 401**; re-date to 720 h; 99999 h clamped to 720;
      another account refused on both re-date and delete.
- [x] Sweeper: an expired file, a legacy meta three days old and an orphaned
      media file with no meta were all removed; the `keep until deleted` file
      survived. 3 removed, 1 left.
- [x] Range serving unchanged: `bytes=0-1023` → 206 `0-1023/200000`;
      `bytes=-500` → 206 `199500-199999/200000`.
- [x] Browser at 390x844 and 1280x900: Cast, More, Bilibili with a real drawn
      QR, Library rows including the armed-delete state, and the public watch
      page.
- [x] `hallmark` vibe-check: **0 critical**, and the multiple-H1 finding is
      pre-existing (2 at HEAD, 2 now — the gate mark and the wordmark).

## 2026-09-07 — "Bilibili shows invalid qr code, sign in url has nowhere to be pasted"

- [x] Proved the drawn code is not the fault. `assets/js/qr.js` was compared
      module-for-module against the `qrcode` reference library on Bilibili's own
      sign-in URL: **0 differences in 1681 modules**, and jsQR reads both. Then
      the stronger test — a **screenshot of the real app at 390x844 was decoded**
      and gave back `…scan-web?…qrcode_key=08c62038…&from=`, the exact address
      the server had just been handed.
- [x] Found what does go wrong: the key expires. A key generated here still
      polled `86101 未扫码` at ten minutes and came back `86038 二维码已失效` by
      fifteen. The panel gave up at **three** and painted "That sign-in code
      expired", so a code could be gone from the screen while Bilibili still
      wanted it — and a code held past its life reads as invalid at the scanner.
      Bilibili is now the only thing that decides; a lapsed code is replaced in
      place, up to three times, with a line saying so. Proven by making one poll
      answer `expired`: the note appeared and the drawn code changed.
- [x] Stopped the panel repainting every two seconds. It re-rendered on every
      poll, which redrew the QR forty times a minute and would have wiped
      anything half-typed below it. Painting is now on state change: text typed
      into the paste box survived seven seconds of polling.
- [x] **Save this code** — the same modules to a canvas, shared where a share
      sheet exists and downloaded where it does not. The blob the real button
      produced was captured out of the page and decoded: **588x588, 11.8 KB, the
      live key**. That is the one-phone route.
- [x] **Paste a sign-in instead** — `POST /api/bilibili?action=paste`.
      `parseCookieText` reads SESSDATA, bili_jct and DedeUserID out of anything
      that contains them (a `document.cookie` dump, one pair, three lines, or a
      bare SESSDATA) and drops the rest. The server asks Bilibili who it belongs
      to before keeping any of it. 9 handler assertions pass, including: a dead
      session is refused **and not stored**, the jar seals and unseals, a
      tampered jar is thrown away, and nothing outside the three names survives.
- [x] Deleted the false instruction. "Copy the address and open it in Bilibili"
      sent people to a dead end — the Bilibili app has no address bar, which is
      exactly what Rj hit.
- [x] RJ-Design-Skill §input-and-forms §1-2 on the new field: submit disabled
      while empty, checked on blur, and live only **after** it has errored, with
      the correction confirmed rather than met with silence. Verified in the
      browser: disabled → enabled → `alert` on blur → `status: That looks like a
      session.` → disabled again when cleared.
- [x] `hallmark` vibe-check: **0 critical**. No new finding on the two files
      touched — the em-dash gate reports README, index.html, issues.md and
      tasks.md at exactly the counts they had at HEAD.


## Round 6 — 2026-09-07 (Rj: a link with video that will not play or cast; subdomain)

- [x] Task 21: `articleweb.xyz/vid/vkprime.php?id=…` diagnosed. Two causes, both
      general. (a) The wrapper page frames `vkprime.com/embed-…`, and that
      embed's three mp4 addresses live inside a Dean Edwards packed script —
      the words of the URL are split into a dictionary, so no pattern over the
      delivered HTML can see them. (b) `sys.vkcdn5.com` signs an address to the
      network that asked for it: a link issued to this server still played eight
      minutes later, and the same link issued elsewhere answered 200 with
      fourteen bytes of HTML. Measured, not assumed.
- [x] Task 22: Packed player scripts unpacked before parsing, by substitution
      and never by running them (`lib/media.js` `deobfuscate`). Applies to the
      page and to every frame it opens, so it covers the whole class of free
      embed hosts, not one site. 21 assertions in `scripts/test-unpack.js`.
- [x] Task 23: Player quality lists read as `sources:[{file,label}]`, so three
      renditions that share the filename `v.mp4` arrive as 720p / 360p / 192p
      instead of three identical choices.
- [x] Task 24: `/api/stream` re-issues a refused address from the page it came
      from (`lib/reissue.js`), with the embed's referer rather than the
      wrapper's, same host only, memoised so a seek does not re-scan. 11
      assertions in `scripts/test-reissue.js`.
- [x] Task 25: `cast.jrvsystems.app` added to the Vercel project and verified.
- [x] Task 26: Vercel project renamed `cast-bridge` → `cast-bridge-new`, so
      production serves `cast-bridge-new.vercel.app`.
- [x] Task 27: The stream host's CORS allowlist widened to the new origins —
      without it, upload and Library would have broken the moment the app moved
      to its own domain.


## Round 7 — 2026-09-07 (Rj: background notifications, media control, SRT upload, a crawler, series history)

- [x] Task 28: Background notifications. Local notifications drawn by the
      service worker, never by the page, because a backgrounded page is
      exactly when they matter and because Android's action buttons only
      exist on a worker registration. Three rules govern the whole module:
      nothing is drawn while the app is on screen, one tag per subject so the
      upload is one notification that changes rather than twenty-four, and a
      control button is only attached when there is something running to act
      on. Covers cast state, upload percentage, deep-scan results and
      failures.
- [x] Task 29: A real Notifications switch in More, telling five states
      apart: asked, on, off, blocked by the browser, and an iPhone in a Safari
      tab where the feature does not exist until the app is on the Home
      Screen. `blocked` is the one that matters — this app cannot undo a
      refusal, and the row says where the setting actually lives instead of
      offering a switch that silently does nothing.
- [x] Task 30: Media Session. Lock-screen title, artwork, scrubber and
      transport keys, routed to the television while a session is live.
      Documented boundary: the OS widget only exists while this tab is
      producing audio, so once a film is on the TV the local element is
      paused on purpose and the widget goes away. That case is what the
      cast notification's Pause/Stop buttons are for. Two surfaces, one per
      situation, neither pretending to cover the other.
- [x] Task 31: `.srt` upload. A file on the phone has no address, and a
      television can only be handed one — so "paste the address of your
      subtitles" was an instruction most subtitle files can never satisfy.
      The file is converted to WebVTT and kept at an address of its own
      (`POST /api/subs`, `GET /api/subs?id=`). Encoding is detected rather
      than assumed: strict UTF-8 first, Windows-1252 on the throw, because a
      Malay or Spanish .srt is very often the latter and decoding it as UTF-8
      replaces every accented character with a diamond.
- [x] Task 32: The crawler (`lib/crawl.js`, `api/crawl.js`). Three signals,
      all true of pages in general rather than of one theme: the words in the
      address and the link text, the SHAPE of the address with its digits
      removed, and name kinship with the page it was found on. Kinship is the
      one that earns its place — on the real page it cut seventeen candidate
      "seasons", sixteen of them other programmes from a sidebar rail, down
      to the one that belonged.
- [x] Task 33: The one hop. Rj's exact URL carries no episode links at all;
      it links to a season page, and THAT page carries them. So a page that
      yields no episodes but a small number of seasons named after it has
      those read too — at most three, because a series with twenty seasons is
      twenty fetches inside one request a phone is waiting on, and the right
      answer there is to hand back the twenty and let a person point at one.
- [x] Task 34: Series history (`api/series.js`, castbridge.series). One row
      per person per address, upserted, so a second look at the same season
      is the same row rather than a fourth copy of the same show. The episode
      list is stored, so opening it tomorrow paints in one frame and
      re-crawls behind the list already on screen.
- [x] Task 35: `scripts/test-all.js` replaced the `&&` test chain. A
      fail-fast chain stops at the first red and hides every suite after it;
      the number that matters is how many suites are red, and a chain cannot
      report it. Proven by breaking two suites at once: the runner named
      both, the chain would have named one.
- [x] Task 36: A 403 that reached production, found by checking the live route
      rather than trusting the deploy. `permission denied for table subtitles` —
      creating the tables through the management API, as `postgres`, left
      `service_role` with no privilege on them, while `users` and `history`
      have had it all along. RLS being deny-all and the service_role GRANT are
      different mechanisms and only one of them was in the migration. Granted,
      written into `db/002`, and re-verified live: the id route now answers a
      clean 404 for an unknown uuid, with no session, which is what a
      television needs.
- [x] Task 37: The session that survives the app being closed
      (`db/003_castbridge_now_playing.sql`, `lib/nowplaying.js`,
      `api/now-playing.js`). Rj: "can't really see stream history back even
      when it's still streaming from the app just because close the app."
      That was not a history bug. A Cast session lives in the SDK, which
      lives in the page, and everything the app knew ABOUT it — the film,
      its name, where it had got to — lived in `current` and `currentTitle`,
      two page-scoped variables. Closing the app threw them away while the
      television carried on playing. The SDK even rejoined the session on
      the next open, and `showSending()` ran with nothing to say, so the
      panel came back over a film it could not name. The identity now lives
      in a table, heartbeat every 15s, and the last beat goes out over
      sendBeacon because a fetch started in `pagehide` does not survive the
      teardown.
- [x] Task 38: Three answers, not a boolean (`lib/nowplaying.js` freshness).
      This app cannot poll the television. All it knows is when the app last
      spoke, and an app that stopped speaking is a phone in a pocket, not a
      film that stopped. So: `live` (beating now, say it plainly), `maybe`
      (offer to look, do not assert) and `ended`. The banner copy is written
      twice and never merged — "Still playing on <TV>" against "You were
      watching this" — because only one of the two is a fact.
- [x] Task 39: The class-name collision, caught in the browser and not in
      review. `.cb-resume` already existed as the resume marker on a history
      row (`app.js`), and the new banner took the same name. The old rule
      won `display`, so the banner computed `inline-flex` and ran 634px wide
      inside a 358px column; worse, the new background, padding and shadow
      were landing on every history chip. Renamed to `.cb-session`.
- [x] Task 40: The button lost the width argument. Inline beside the text it
      took 114px, and on a 390px phone that rendered "Bigg Boss 20 — Epi…" —
      truncating away the episode number and the position, the two facts the
      banner exists to carry, to protect a button whose label is guessable
      from context. It is on its own row now, and the text is clamped to two
      lines rather than one.
- [x] Task 41: The cover, which the app was already being handed and threw
      away. `/api/scan` and `/api/extract` both return the page's
      `<video poster>` / `og:image` as `poster`, and nothing on the client
      ever read it — which is why every notification was a grey app icon
      over a film with a perfectly good cover. `assets/js/artwork.js` now
      owns the chain: the page's cover if it PROVES it loads (a hotlinked
      poster that 403s for our referer is a broken-image glyph on a lock
      screen and there is no second chance), a frame of the film if the
      pixels are ours to read, the app icon last. It reaches the
      notification's `icon` and `image`, the Media Session artwork, and the
      Chromecast's own metadata — that one only when it is an address the
      television can fetch for itself, because a captured frame is a data:
      URL and would be a broken image on the wall.
- [x] Task 42: Pause and Stop that did nothing. The worker treated "a window
      client exists" as "a page is listening". Neither half holds on a
      phone: the app is usually not running at all when the notification
      matters — the old code opened it and dropped the tap on the floor —
      and Android freezes a backgrounded PWA within minutes, so postMessage
      to it is QUEUED, not delivered, and the film carries on playing while
      the shade says it was paused. A tap is now delivered, waited on for an
      acknowledgement, and if none comes it is written to the cache and the
      app is opened to perform it on wake. Every tap carries an id and no id
      runs twice, because the frozen page thaws and processes its copy too.
- [x] Task 43: A replayed tap must not act on the phone. It arrives before
      the Cast SDK has rejoined, so `castState` is not CONNECTED and the old
      branch fell through to the local element — tapping Pause in the shade
      would have started the film playing out loud in your pocket. It waits
      up to eight seconds for the session and says so if it never comes.
- [x] Task 44: A tap on the notification itself. It called `navigate()` on
      the open window before focusing it: navigating reloads the page, which
      drops the Cast sender the notification is reporting on, and per spec
      spends the client reference so the `focus()` after it can reject —
      leaving a closed notification and no window, which is exactly "it just
      disappears". Focus is the whole job for a window that exists.
- [x] Task 45: The lock screen read the wrong player. `playbackState` came
      from the local `<video>`, which is deliberately paused while a film is
      on the television, so the widget drew a Play button over a film that
      was playing on the wall. It follows the television when there is one,
      and `playbackRate` is 1 there rather than this element's.
- [x] Task 46: A notification outliving the page that drew it. Opening the
      app from a tap left the old one in the shade, reporting on the screen
      now in front of you — the fresh page has no record of it and cannot
      name its tag. Coming to the front now sends a registration-wide close.
- [x] Task 47: Pause and Stop still did nothing, and last turn's fix was only
      half of it. The worker's fallback — write the tap down, bring the app
      up — was right; the app asked for the written-down tap exactly once, at
      boot. But the ordinary case on a phone is an app that is ALREADY
      running and merely frozen: the worker gets no acknowledgement, writes
      the tap down and focuses the page, which thaws, never boots again, and
      so never asks. The tap sat in the cache until it went stale. Every road
      back to the foreground asks now, not just the first one.
- [x] Task 48: Still no cover. The address was being found, returned and
      thrown away at the last inch — a hotlinked poster is exactly what a
      site refuses, it answers 403 to a Referer that is not its own, the
      <img> never fires onload and one refusal was being read as "there is no
      picture". `GET /api/img?u=` fetches it again from our own server, with
      the poster's own origin as the referer, and hands back a copy on our
      origin that a Chromecast can fetch too.
- [x] Task 49: The stale-cover guard could never fire. `mine !== poster`
      compared the argument to itself, so a slow first film could still
      overwrite a fast second one. It is a token now.
- [x] Task 50: The Send button and the Play button below it were touching at
      exactly 434px, and the Play button's neumorphic highlight — 3px offsets
      under a 6px blur — reached 9px above its own box and landed on the Send
      button. Two different groups with no gap between them, and a soft edge
      inside somebody else's 46px touch target. 1.75rem, which is the step
      this sheet already uses for a group boundary.
- [x] Task 52: The buttons acted on the wrong device. The `cast` notification
      is only ever drawn about a television — reportCast() has four callers
      and all four are cast events — but its toggle fell back to this phone's
      hidden `<video>` whenever the Cast session was not ready at the instant
      of the tap, and `withCast` let an ordinary (non-replayed) tap straight
      past the guard. `castReady()` is false for a moment on every thaw, which
      is exactly when a shade tap arrives. Now `assets/js/castaction.js`: wait
      for the remote, or give up and say so, never a third thing.
- [x] Task 53: A failure said nothing to anyone. A throw from `playOrPause` was
      swallowed by the listener loop, and the give-up path raised a toast into
      a page nobody is looking at. Both now rewrite the notification in place,
      which is the surface the person is actually on.
- [x] Task 54: The ack budget was 1500ms before the app could be brought up.
      Chrome allows a notificationclick a limited window in which a worker may
      focus or open one; that is now 600ms, gated by a test that fails if the
      whole delivery takes a second.
- [x] Task 55: Three turns of guessing at a dead button, so the app now says
      what became of the last tap. The worker writes down the road each tap
      took, the page writes down what it managed to do, and one sentence under
      the Notifications switch names which of the three places it died in.

## Round 8 — 2026-09-07 (Rj: "still can't scan", resume card shown while casting)

- [x] Task 55: The banner never offers to restart a film that is playing.
      `assets/js/resume.js` owns the precedence lib/nowplaying.js already
      states in a comment — a live Cast session outranks the stored row —
      and `renderResume()` asks it on EVERY render instead of once at boot
      and once on a single SESSION_RESUMED. CAST_STATE_CHANGED re-decides it
      too, because that is the event every rejoin fires whatever the session
      event calls itself. Seen red on the shipped rule: 5 assertions.
- [x] Task 56: Recognising a running film cannot re-send it. The session
      handler reads `current` into `hadTarget` BEFORE anything can adopt,
      and `askedForSession` keeps a session this page requested from being
      mistaken for a rejoin.
- [x] Task 57: One clock, in resume.js. The inherited one rendered the
      string "NaN:NaN" for a non-finite input — reachable, because a <video>
      reports currentTime and duration as NaN until it has metadata and this
      formatter has twelve callers on that side.
- [x] Task 58: The empty-scan verdict distinguishes an embed it could not
      reach from a page with no video. `lib/media.js emptyVerdict()`, four
      answers, tested without a browser. The old rule counted VISIBLE frames
      only, so a player in a collapsed panel (0x0 box) read as "no embed,
      check the address" — a specific instruction to do the wrong thing.
- [x] Task 59: A tap replayed into a COLD app is no longer dropped.
      `drainPending()` returned when there was no active worker and no
      controller, which is the state of a page the worker just opened; and
      because the tap opened the app, the visibilitychange retry never fires.
      It waits on `navigator.serviceWorker.ready` and asks again.

## Round 9 — 2026-09-08 (Rj: "the purpose of vps is to cut Vercel cost")

- [x] Task 60: The redirect to Vercel is gone from api/stream.js, not switched
      off. It repaired a refusal by sending the film back through the meter
      the VPS exists to escape — a cost fix whose failure mode is the cost.
      `scripts/test-deepreissue.js` runs the real handler against a refusing
      origin with CAST_FALLBACK_ORIGIN set and fails on any 3xx. Seen red
      against HEAD: "answered 302 — a television was pointed at another host".
- [x] Task 61: The address is minted where it will be fetched. api/scan.js
      exports its browser half (`launch`, `collect`); lib/reissue.js gains
      `deepReissue`, which runs the deep scan on this box when re-reading the
      page's HTML finds nothing — which is every page whose player builds its
      source in JavaScript, i.e. the ones this app is for. Off unless
      CHROME_EXECUTABLE_PATH names a browser, so the serverless deploy never
      pays for a Chromium it has no use for.
- [x] Task 62: A film costs one browser, not one per segment. A refused HLS
      playlist puts every segment into the retry at once; the scans are
      single-flighted by page and the answer memoised, including when the
      answer is no.
- [x] Task 63: THE CAUSE, and it was not the CDN. The synthetic poke took the
      FIRST match of a selector containing a bare `button`, and the first
      button on tamildude.net is the search field's submit — every scan
      navigated the page to /?s= before the vidmoly embed built its player, so
      a film sitting right there reported as "no video on this page". Nothing
      inside a form or a link is clicked now, a real control is preferred over
      a wrapper that merely sounds like one, and `scripts/test-poke.js` proves
      it in a browser against the exported function. Yesterday's poke on the
      same fixture: submitted: true, clicked: ["search-play-btn"].
- [x] Task 64: A rotating CDN edge is the same site. The replacement arrived on
      prx-1559-ant.vmpx.online where the refusal was prx-1317-ant.vmpx.online,
      and a same-HOST guard threw it away — a repair that could never once
      succeed. `sameSite()` allows one differing leftmost label over at least
      two agreeing ones, and still refuses a.co.uk against b.co.uk.
- [x] Task 65: A box that cannot re-scan says so. `/healthz` reports
      `deep_reissue {configured, executable, ok}`, checked at the path rather
      than trusted from the variable, and the service names it at boot.
      README carries the `npm ci --omit=dev` a `git pull` does not do.
- [x] Task 66: The third row was a PIECE of the second. tvlogy.to names its
      HLS segments `01852-000.juicycodes` and serves them as `video/mp2t`,
      and the deep scan watches the network, so six seconds of the episode
      was offered beside the episode. Naming cannot settle it — the site is
      free to call a segment anything — so `lib/media.js offerable()` asks,
      in order: did a playlist we read list this address, is the body a
      transport stream, is the name a segment extension, is the kind one a
      player opens. `api/scan.js` reads every `.m3u8` the page fetches and
      remembers what it named. A master's URIs survive; a media playlist's
      do not. The quick scan is gated at the same rule, so a segment cannot
      arrive by the other door.
- [x] Task 67: Picking one stream keeps the rest. `assets/js/sources.js` owns
      the set, what has been tried and where to go next; app.js owns the
      strip under the status line and the loading. A stream that will not
      play moves the app on by itself, twice at most, and says so; the
      picker goes anywhere including back to the first; the set is written
      to the history row, so a film reopened next week still has somewhere
      to go. `scripts/test-sources.js` proves both, in a real browser
      against the shipped page, on both player paths.

## Cast notification showed a black square instead of a cover (2026-09-08)
- [x] artwork.js — measure a captured frame before trusting it; refuse a blank one
- [x] app.js — keep looking for a real frame instead of taking the one at `loadeddata`
- [x] test-notify.js — 5 new checks, 7 deliberate breaks all seen red
