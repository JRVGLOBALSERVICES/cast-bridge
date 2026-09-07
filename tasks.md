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
