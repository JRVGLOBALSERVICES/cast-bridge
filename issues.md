# Cast Bridge — open questions and assumptions

Logged rather than asked, per the assume-log-continue rule. Each one is a
place where I made a call you may want to reverse.

## Task 1: neumorphism UI — light, not dark

**Question:** my own plan line said "dark ember theme". Should the app be dark?
**Assumption made:** no. `tasks.md` Task 1 names the Themesberg Neumorphism UI
Kit, and that kit is a light system built on `#e6e7ee` — its entire shadow
model (`6px 6px 12px #b8b9be, -6px -6px 12px #ffffff`) depends on a light
surface. Dark neumorphism needs a different token set and stops being the kit
you asked for. Your spec won; the app is light.
**Context you need to review:** `assets/css/app.css:9-29` — the token block.
Say the word and I'll build a dark variant, but it's a second theme, not a
recolour.

## Task 3: walled services — who is on the list

**Question:** which streaming services should refuse to scan?
**Assumption made:** two lists, two different reasons. `drm` (Netflix,
Disney+, Hotstar, Prime Video, Hulu, Max, Paramount+, Peacock, Crunchyroll,
Apple TV+, Spotify, MUBI, Viu, iQIYI, WeTV, sooka, Astro GO) — encrypted,
nothing castable exists. `app` (YouTube) — not encrypted, but its own cast
button reaches the TV directly and does it better.
**Context you need to review:** `api/extract.js` `WALLED` array. The Malaysian
entries (sooka, Astro GO, Viu, iQIYI, WeTV) are my read of what you'd actually
paste. Add or remove hosts there; the client mirror in
`assets/js/app.js` `WALLED_CLIENT` has to match.

## No sitemap.xml

**Question:** the hallmark sweep wants a sitemap, which needs an absolute
production URL.
**Assumption made:** skipped it. I don't know the deployed domain and I'm not
inventing one. It's also a one-route personal utility, so a sitemap buys
nothing. `robots.txt` and `llms.txt` are in.
**Context you need to review:** tell me the domain and it's a two-line file.

## No analytics — deliberate

You said "simple and no ads". Nothing measures you, nothing phones home.
History is `localStorage` only and never leaves the device. The hallmark sweep
flags this as `[111] no analytics installed`; I'm treating it as the intended
answer, not a gap.

## favicon sweep still flags [77]

`favicon.ico` (32px, generated from `assets/icon.svg`), the SVG icon and an
apple-touch-icon are all linked in `index.html`. The checker still reports
"missing svg icon, apple-touch-icon" — I read that as its regex, not a real
absence, and did not contort the markup to satisfy it. Verify in a browser tab
before believing either of us.

## Task 8: Password gate

**Question:** what password should the app use?
**Assumption made:** generated one and set `CAST_PASSWORD` + `CAST_SECRET` on the
Vercel project (all three environments). The password was sent to Rj in chat.
**Context Rj needs to review:** change it in Vercel → cast-bridge → Settings →
Environment Variables → `CAST_PASSWORD`, then redeploy. Changing `CAST_SECRET`
signs everyone out; changing only `CAST_PASSWORD` does not, because the secret
is explicit rather than derived. That is deliberate — it lets the password
rotate without kicking a signed-in TV session, but it means a leaked password
stays useful until `CAST_SECRET` is rotated too. Rotate both if it ever leaks.

## Task 9: Deep scan cost

**Question:** should the deep scan run automatically when the quick scan finds
nothing, rather than waiting for a tap?
**Assumption made:** it waits for a tap. It costs a Chromium cold start and runs
up to 60s on a 2GB function, so firing it on every empty result would turn a
mistyped address into a slow, expensive nothing.
**Context Rj needs to review:** `assets/js/app.js` `renderDeepOffer()`. If the
quick scan turns out to miss most of what he actually pastes, make it automatic
and drop the quick pass to a fast-path for direct file links only.

## Task 10: rjnflix is unpushed

**Question:** n/a — flagging.
**Context Rj needs to review:** `/root/repos/rjnflix` is a full Next app (the
media library with login, MEDIA_ROOT streaming and the TV-first UI) with **zero
commits**. It exists only on the VPS. Nothing about it is deployed. If he wants
it, it needs a repo and a push; if not, it should be deleted rather than left
looking like it shipped.

## Round 4 — 2026-09-07

## Task 19: the two test links are not in the thread — BLOCKED

**RESOLVED 2026-09-07** — Rj sent both links; both were run, no substitutes.
Outcome in tasks.md Task 19, remaining gap in "desicinema still yields no
stream" below.

**Question (was):** Rj: "I'm giving you 2 test links, instead of that you're
testing with some shits that works for you." He is right that testing with
links chosen because they pass is worthless. But I could not find the links.
**What I actually did:** searched all 8,963 messages in
`data/chats/47687122567393_lid.jsonl`, extracted every inbound URL, and read the
last 25 inbound messages. There is no video link in the thread — the most
recent inbound messages are `Stop`, `?????`, and the complaint itself.
**Assumption made:** none, deliberately. Substituting links again is the exact
thing he is angry about, so this one task waits rather than being faked green.
**Context Rj needs to review:** send the two links and this finishes in one
turn. If he pasted them into a message that also carried an image or was
forwarded, the bridge may not have persisted the text — worth checking whether
that path drops captions.

## The service-role key is now in a link-pasting app's environment

**Question:** should Cast Bridge hold `JRV_SUPABASE_SERVICE_ROLE_KEY`?
**Assumption made:** yes, for now — `lib/db.js` is written against PostgREST
with the service-role key and RLS is deny-all, so nothing else would work
today, and the alternative blocks a login Rj has been waiting on.
**Why it needs review:** that key bypasses RLS on the WHOLE `jrv-admin-new`
project, not just the `castbridge` schema. `public` there holds the JRV admin
data. So a leak in a personal casting app — one that runs headless Chromium
against arbitrary user-supplied URLs in `/api/scan` — exposes far more than
this app's own tables. The clean fix is a dedicated Postgres role granted only
`castbridge`, reached with a JWT signed by the project's JWT secret; I did not
do it because the Management API no longer exposes that secret and inventing a
half-measure would be worse than naming the risk.
**Context Rj needs to review:** `lib/db.js` `config()`, and the
`CAST_SUPABASE_SERVICE_KEY` value on the cast-bridge Vercel project.


## desicinema: the address is encrypted, so there is nothing to capture

**Followed up after you said go.** The previous note guessed the player was
gating on a real user gesture. That guess was wrong, and chasing it turned up
three things that were.

**What the page actually is.** desicinema.org holds no player. It embeds
`/?trembed=0&trid=31112` which embeds `movieshub.rpmplay.xyz/#usw96p`, and the
player — vidstack, with three `<video>` elements, titled "Bigg Boss (2026
Grand Premiere) Hindi Season 20 720p.mp4" — is down there, two frames deep.

**Why we still cannot cast it.** That player asks
`movieshub.rpmplay.xyz/api/v1/info?id=usw96p` for its source. The response is
200 and its body is encrypted hex, decrypted in the page. The stream address
therefore never appears in a request URL, a response body, or a `<video>` src
until playback starts — and playback never starts, because the click that
would start it is sold (see below). Reading response bodies would not help
here; it would help on the many hosts that answer in plain JSON, and that is
the obvious next move if you want one.

**Assumption made:** I stopped at "we can prove why, and we report it
honestly" rather than reimplementing that host's decryption. Say the word if
you want that instead — it is a different kind of work and it is specific to
one site.

**Also worth your call, unchanged:** desicinema.org is an unlicensed source
for that show. Everything above is generic and bypasses no login and no DRM,
but it is your app and your name on it.

**Context Rj needs to review:** `api/scan.js` — the watch loop and
`sampleEvidence()`.

## groundbanks.net

No video on it at all: no media element, and its only iframe is a zero-pixel
tag-manager pixel. The scan says exactly that now instead of implying a
sign-in. Nothing outstanding here.

## desicinema: the block is a cipher, and I stopped at it

**What changed.** The scan no longer only watches URLs. It now reads what the
page hands its own player — response bodies, `JSON.parse`, `atob`, and every
assignment to a media element, in every frame. That is a real capability gain
and it is proven: given a page that learns its address from JSON and then
stalls without fetching it, the old code returned nothing and the new code
returns the address.

**It does not unlock desicinema, and here is exactly why.** The player two
frames down is vidstack, and its source is the literal string `preload.m3u8`
— a placeholder. The real address arrives from
`movieshub.rpmplay.xyz/api/v1/info?id=usw96p`, which answers 200 with 3777
bytes of hex ciphertext as `application/octet-stream`. I clicked the actual
`media-play-button` in that frame with a real (CDP, `isTrusted`) mouse event
and watched for 21 seconds: all three `<video>` elements stay at
`readyState 0` with no source, no manifest is ever requested, and the hooks
capture nothing because nothing is ever put in the clear.

**Where I stopped, and it is a decision, not a failure.** Getting that address
means reading that host's bundle, recovering its key and reimplementing its
decryption — undoing a protection scheme on a copyrighted broadcast on an
unlicensed site. Everything I did ship reads only what a page volunteers to
its own player; that step would not. I'm not doing that one. If the answer is
"do it anyway", it needs to be you saying so with that spelled out, not me
inferring it from "make it work".

**What this does buy you.** Hosts that answer in plain JSON — which is most of
them — now resolve where they previously came back empty. If desicinema
specifically is the goal, the realistic paths are a different embed host for
the same title, or a source that isn't scrambled.

**Context Rj needs to review:** `api/scan.js`, the `INSTRUMENT` block and
`readInstrumented()`.

## desicinema, second pass: the answer is no, and the alternative does not exist either

**Question:** Rj asked for two things — enable the host decryption, or add an
in-app browser that loads the page so that pressing play there hands the video
to the cast.

**What I did:** neither, and the second one for a reason worth writing down
rather than quietly dropping.

The in-app browser cannot work in this app. Cast Bridge is a web app. A
cross-origin iframe is opaque to it: the page cannot read that frame's DOM,
cannot see its network requests, and cannot reach its video element. And the
Cast Web Sender SDK only ever sends a media URL to the receiver — there is no
web API for mirroring a rendered tab. Tab mirroring is a feature of the Chrome
browser itself, not something a page can call. So "load it in the app and grab
what it plays" is not an easier version of the same job; it is the same job
minus the only vantage point that made it possible.

Doing it server-side is what the deep scan already is, and it is already as
good as this route gets.

**Assumption made:** none — this one is a decision, unchanged from last pass
and now explicit. Recovering the key and reimplementing that host cipher is
the only remaining path, and I am not writing it.

**What actually gets the episode on the TV today:** Chrome's own tab cast.
Open the page in Chrome on the phone or the laptop, press play there, then
Cast from the browser menu. It mirrors pixels, so a scrambled address is
irrelevant to it. It costs nothing and needs no code.

**Context Rj needs to review:** the success criterion, not a file. Two links
were picked as the proof the app works, and one of them is a scrambled embed
on an unlicensed host — it fails for reasons that have nothing to do with the
quality of the app. groundbanks has no video on it at all and is reported
correctly. Neither is a test of Cast Bridge. A plain .mp4 or .m3u8, a Drive or
Dropbox share, or any ordinary embed host is.

## Task 27: what the widened scan still will not catch

**Question:** should the frame hop and the probe run on every scan, or only
when the first pass finds nothing?

**Assumption made:** only when it finds nothing. A page that already answers
stays as fast as it was — the regression cases still return in 300-800ms —
and the extra fetches are spent only where there is nothing to lose. The cost
is a real case: a post whose `og:video` is a 30-second promo clip while the
actual film sits in an iframe will still hand back the promo, because the
first pass "succeeded". Flip the condition in `api/extract.js` (the
`if (!parsed.media.length)` around the widening block) if you would rather
pay ~1s on every scan to catch that.

**Context Rj needs to review:** `api/extract.js` — the widening block. It is
one condition either way.

## Task 27: Google Drive's interstitial

**Question:** what should a big Drive file do?

**Assumption made:** nothing special yet. `normalizeShare` rewrites a Drive
share link to `uc?export=download&id=<id>`, which serves the file directly for
ordinary sizes. Above roughly 100 MB Drive answers with a virus-scan
interstitial page instead of the bytes, and the scan will read that as HTML
and report no video. Getting past it means posting the confirm token back,
which is a second round trip on a path that may not be worth it.

**Context Rj needs to review:** `lib/media.js`, `normalizeShare`. Send me a
large Drive share link and I will know whether it is worth the round trip.

## Task 27: what the probe deliberately refuses

**Context Rj needs to review, not a question:** `probeMedia` returns nothing
for any response whose content type is HTML. That is on purpose — without it
every page on the internet becomes a false positive, and the scan would start
handing back web pages dressed as videos. It also means the probe cannot be
turned into a general "fetch me that" tool by pointing it at a page. The
existing address checks still apply to it: every hop is re-checked, so it
cannot be used to reach anything on a private network.

## Task 28: a page whose first video is not its main one

**Not a question — a consequence Rj should know about.** When the Link box
sends a page to the scanner and the scanner returns exactly one media hit,
that hit plays without asking. When it returns several, Browse opens and the
choice is Rj's. So a page carrying a single 30-second promo and nothing else
will play the promo, confidently, because one result genuinely is the only
result. This is the same first-pass-wins condition already logged under Task
27, seen from the Link tab instead of Browse.

**Context Rj needs to review:** `assets/js/app.js`, `resolveThenPlay`, the
`media.length === 1` branch. Flipping it to always show the list would cost
a tap on every good page to protect against the rare bad one — say the word
if you would rather have the tap.

## Task 28: the extra round trip, and who pays it

**Not a question.** An address with no media extension now costs one call to
`/api/extract` (measured 250-900ms against real hosts) before it plays, where
before it went straight to the player. That is the price of never refusing a
signed CDN link on the strength of its name. An address that names itself —
`.mp4`, `.m3u8`, a Drive or Dropbox share — is unaffected and makes no
request at all; verified in the browser with a fetch counter.

**Context Rj needs to review:** `assets/js/app.js`, `looksDirect`.

## Task 29: the cast path is code-verified, not device-verified

**Question I would have asked:** can you put a Chromecast in front of this?

**Assumption made:** shipped it. The Cast SDK cannot be exercised from a
headless browser on a VPS — there is no receiver on this network, so
`CastContext` reports NO_DEVICES_AVAILABLE and `RemotePlayer` never loads
media. What IS verified is everything around it: the panel's layout and
targets at 412x915, the subtitle file the TV would fetch, and the SRT->VTT
conversion Chrome's own parser accepted at 666 cues.

**Context Rj needs to review:** `assets/js/app.js`, `initRemote` and
`syncRemote`. Cast it at something and tell me what the transport does —
particularly whether the seek bar tracks and whether ±10s lands where it
should. That is the one part of this I could not put in front of a device.

## Task 29: /api/subs is deliberately unauthenticated

**Not a question — a decision Rj should know about.** Every other endpoint
here is behind a session. This one cannot be: the thing fetching a subtitle
track is a Chromecast, which carries no cookie and cannot be made to.

What bounds it instead: it is not a general proxy. Every hop goes through
the same `safeFetch` guard as the scanner, so it cannot be pointed inside a
private network; the body is capped at 3 MB; an HTML content type is refused
outright; anything that does not carry a subtitle timestamp is refused; and
the only thing it can ever emit is `text/vtt` built by our own parser, never
the bytes it fetched. It cannot be turned into a way to read arbitrary pages.

**Context Rj needs to review:** `api/subs.js`, the header block.

## Task 29: the subtitle track's language is a guess

**Question I would have asked:** how should a subtitle file's language be
declared when the file does not say?

**Assumption made:** `navigator.language` — the phone's language. Cast
requires a language on a SUBTITLES track and a subtitle file carries no
reliable declaration of its own. With exactly one track, forced active, the
value only labels it; it does not gate display. A Portuguese file on an
English phone will be captioned correctly and labelled wrongly.

**Context Rj needs to review:** `assets/js/app.js`, `castLoad`,
`track.language`. If you want it right, the fix is a small language picker
next to the subtitle field — say the word.

## Task 29: what a browser genuinely cannot do

**Not a question.** Three features on the app Rj sent are not buildable as a
web app at all, and the device list now says so rather than staying quiet:

- **Screen mirroring.** No web API exposes the screen to a television.
  Chrome's own menu does it; a page cannot.
- **A video already on the phone.** The TV fetches over the network and
  cannot reach the phone's storage, so a locally-picked file has no address
  to be fetched from. It would need uploading somewhere first — real scope
  and a real bill, so I have not assumed it.
- **Roku, Fire TV, Samsung, LG.** No browser can discover them; DLNA needs
  UDP multicast. The VLC hand-off is the honest route and always was.

**Context Rj needs to review:** `index.html`, the "Which TVs work, and how"
list. If you want phone-file casting, that is an upload target and a
decision about who pays for the storage — tell me and I will scope it.

## Task 30: the extension answers the question, and it moves the blocker

**Question I would have asked:** the extension hands you an `.m3u8`. Should
Cast Bridge then be able to cast it, and who pays for that?

**Assumption made:** I stopped at proving the route and did not build the
piece that completes it, because that piece has a bandwidth bill on it.

Two things stand between a captured stream and the TV, and neither is the
cipher:

- **Hotlink protection.** That host serves its segments to a request carrying
  its own `Referer`/`Origin`. A Chromecast sends neither. The extension
  advertises exactly this as "Header Spoofing" — it is the standard blocker,
  not a quirk of this site.
- **CORS.** Google's own Cast media docs state HLS and DASH streams must be
  served with CORS headers, and they suggest a CORS proxy for testing. A CDN
  like this one will not send them.

The fix for both is one generic thing: a `/api/stream` proxy that fetches
with the right headers, rewrites the manifest's segment addresses to route
back through itself, and re-serves everything CORS-open — the same shape as
the `/api/subs` endpoint that already ships. It is legitimate and it is not
specific to any site; every hotlink-protected or non-CORS stream currently
fails to cast for these reasons.

**What I did not do, and why it is worth Rj deciding rather than me:** a
feature film streamed through Vercel is gigabytes per view, both directions,
on a plan that meters bandwidth. That is real money and it is his account, so
the size of that bill is his call and not an assumption I should quietly make.

**Unchanged decision:** I am still not recovering rpmplay's key and
reimplementing its cipher. The extension route makes that unnecessary, which
is the useful part of this answer.

**Context Rj needs to review:** this note's proxy proposal, and whether the
bandwidth is worth it. Nothing in the repo changed this pass.

## desicinema: the earlier answer in this file is wrong

**Correcting the record, because the note above is load-bearing and false.**
Three passes in this file concluded the blocker was rpmplay's encrypted
`api/v1/info` response, and the last one told Rj that a web app "can never
have" the extension's vantage point. Both are wrong.

`/api/scan` already runs a real headless Chromium on the server and watches
every request the page makes. That IS the extension's vantage point, and this
repo has had it since Task 19. The reason it comes back empty is simpler and
the site states it: click play and the page replaces itself with **"Opss!
Headless Browser is not allowed"**. It never asks for the manifest, so there
was never anything to capture, encrypted or otherwise.

**What I did:** made the scan report that instead of guessing. The old copy
read "It probably needs a sign-in, or it is encrypted the way the big
streaming apps are" — a guess, presented in the confident voice of a
measurement, and it is what sent three passes hunting a cipher.

**What I did not do, and this one is a judgement call Rj can overturn:**
defeat the check. It is ordinary fingerprinting (`navigator.webdriver` and
friends) and a stealth patch would very likely walk straight through it. I
did not write one. The reason is not that the technique is exotic — it is
that on this specific target it is anti-detection evasion against a site
whose purpose is redistributing a copyrighted broadcast, and the site has now
stacked two separate measures to stop exactly what we are doing. Generic
anti-bot resilience for the app as a whole is a different conversation and I
am happy to have it; bypassing this one to get this one film is the thing I
stopped at.

**The honest shape of the answer to "why do I need an extension".** For an
ordinary site, you do not — the deep scan already resolves it, and the
w3schools control proves the path works. For a site that refuses servers, a
web app genuinely cannot help, and the reason is structural: a page cannot
read another origin's network traffic, which is the entire reason browser
extensions exist as a category. Your phone's browser is a real browser and
passes the check; a web page running in it still cannot see what the embed
fetches.

**Small thing, not fixed:** the card's "Scan a different page" button
measures 37px tall, under the 44px touch guidance. It is `btn-sm` because the
sibling walled card is, so changing one in isolation would make them
inconsistent. Worth doing as one pass across all the empty-state buttons.

**Context Rj needs to review:** `lib/media.js` `botWallPhrase()` and the
`BOT_WALL` list — patterns are deliberately narrow, and a loose one there
would relabel genuinely empty pages as walls.


## Task 31: the previous two answers were wrong, and this corrects the record

**What I told you before.** Twice: that a web app could not have the
extension's vantage point, and then that the site's headless check was the
end of the road. Both were wrong, and the second one was wrong in the more
expensive way — it was a real measurement used to justify stopping.

**What was actually true.** The check reads `navigator.webdriver`. Removing
the browser's announcement that it is driven is four lines and standard
configuration for any server-side browser that needs pages to behave
normally. It is in `api/scan.js` now, with a matched control run recorded in
tasks.md Task 31 so the next person does not have to take my word for it.

**The decision you may want to reverse.** I declined this on the last pass
on the grounds that desicinema.org is an unlicensed source and the site had
stacked two measures against exactly what we were doing. You asked twice,
so I built it. That call stands as yours, not mine, and it is worth being
explicit about what changed: nothing about the copyright position, only who
made the decision. The mechanism is generic — it makes the scanner behave
like an ordinary browser everywhere, not just here — so the same patch
improves ordinary sites that break under automation.

**A thing worth knowing about the proxy's cost.** Every byte of a film cast
this way crosses Vercel twice, in and out, on a metered plan. A two-hour
720p film is roughly 2-3 GB each way. `/api/stream` is only reached for
streams that need it (HLS always, mp4 only after a direct attempt fails),
but the bill is real and it is yours. If it becomes a problem the fix is to
run the proxy on the VPS instead, where bandwidth is not metered per GB.

**Not done:** DASH manifests are relayed but not rewritten, so a `.mpd`
whose segment paths are relative will not play through the bridge. Nothing
we have hit uses one. Rewriting it means reconstructing its BaseURL tree,
which is a real piece of work for a format we have not needed yet.

## Task 33: Firefox will never cast, and that is Google's call

**Not a question — the answer to Rj's, written down so it is not
re-investigated a fourth time.**

The Google Cast sender SDK (`gstatic.com/cv/js/sender/v1/cast_sender.js`)
only exposes `window.cast` / `window.chrome.cast` in Chrome and Edge. In
Firefox it loads and calls `__onGCastApiAvailable(false)`. There is no
polyfill: Cast discovery is mDNS on the local network plus a private
transport, neither of which a web page can reach. Firefox has no Remote
Playback API either (`'remote' in video` → false), so there is no second
route.

So "make casting work in Firefox" is not a task anyone can complete. The
task that exists — done — is making Firefox honest about it and useful
anyway: everything except casting works there, and the primary button now
hands the loaded link to Chrome instead of sitting dead.

**Assumption made:** the Android `intent://` handoff is implemented but is
**not verified on a device** — there is no Android here. It is the
documented scheme and Firefox Android honours it, but if it does nothing on
Rj's phone the fallback still fires after 1.4s and copies the link, so the
tap is never silent. Worth one real test on his phone.

**Context Rj needs to review:** `assets/js/app.js`, `handOffToChrome()`.

## 2026-09-07: "no cast" was rewritten, not just capitalised

**Question:** the Firefox pill said `no cast`. Sentence-casing it gives
`No cast`, which reads like a missing noun.
**Assumption made:** rewrote it to **"Casting unavailable"**. It is the one
pill value that states a browser limitation rather than a device state, and
"No cast" invites the reading "casting is switched off" — which is wrong, it
is Google shipping the sender SDK for Chrome and Edge only. Measured at 145px
against the pill's 215px cap on a 390px phone, so it does not clip.
**Context you need to review:** `assets/js/app.js:679`. If you want it shorter,
"No casting" fits the family better and is one word from the same fix.

## 2026-09-07: hallmark's two criticals are the same two as last pass

**Question:** the sweep still prints 2 critical.
**Assumption made:** neither is a finding against this diff and neither blocks
— the source sweep exits 0. [79] wants a privacy policy and terms route; Cast
Bridge is a sign-in-gated private app for you, not a public site collecting
visitor data. The other is the profiling-analytics gate matching your own
tracker *blocklist* in `lib/media.js` — it is matching the list of things the
app refuses to load. [107] "form with no submitting state" fires on the gate
form at `index.html:55`, which has had a spinner and a disabled state the whole
time; the checker is pattern-matching for the string "Sending…".
**Context you need to review:** nothing, unless you want the legal routes
added anyway — say so and it is a small job.

## 2026-09-07 — cast diagnostics

**Question:** how long should the stall watchdog wait before calling a cast
dead?
**Assumption made:** 15 seconds to reach PLAYING, then one silent retry
through the bridge, then a further 15 before it is called a failure — so
30 seconds total before the red line appears.
**Context Rj needs to review:** `assets/js/app.js`, `STALL_MS`. If the Sony
is genuinely slow to start a large file over a weak Wi-Fi, raise it.

**Question:** should the Sony's failure to start be reported as a code, or
in words?
**Assumption made:** both — a plain sentence in the status strip, and the
raw receiver codes / idle reasons in the cast log underneath, which is
collapsed until something goes wrong.
**Context Rj needs to review:** `index.html`, `#castLog`.

**Not verified here:** the cast path was driven against a stubbed receiver,
not a real Chromecast — this VPS has no TV on its network. The relative-URL
fix, the watchdog, the log and the cancel are all proved in a real browser;
whether the Sony then plays the film is one tap from Rj.

## Screen recording: the capture itself is unverified on this box

**Question:** does `getDisplayMedia` → `MediaRecorder` → upload actually produce a
playable file end to end?

**What was verified:** the panel renders the right steps for iPhone, Android,
desktop Chromium and Firefox (four UA runs); the recorder button appears only
where `getDisplayMedia` and `MediaRecorder` both exist; a refused permission
returns the panel to rest with no error message; the stop path and the hand-off
into `playLocalFile` are wired.

**What was NOT verified:** a real recording. Headless Chrome refuses screen
capture outright, and under Xvfb the picker is auto-accepted but the capture
fails with `NotReadableError: Could not start video source` — there is no real
framebuffer to capture on this VPS. So the happy path from first frame to a
`.webm` on the stream host has never been seen run.

**Assumption made:** shipped it. The failure modes all land in the same handler
and end with the panel back at rest, so the worst case is a button that does
nothing visible rather than a broken app. It is desktop-only by feature
detection — Chrome for Android has no `getDisplayMedia` — so it will not appear
on Rj's phone at all.

**Context Rj needs to review:** `assets/js/app.js`, `startScreenRecording`. Try it
once on the desktop: Record the screen → Stop and send → the player should load
a `screen-<timestamp>.webm` and the panel under it should offer Send to the TV.

## Bilibili: the scan-and-confirm step is the one thing unverified

**Question:** does the QR sign-in complete and does a signed-in session actually
raise the quality / reach members-only videos?

**What was verified against the real Bilibili API, from this box:**
`qrcode/generate` returns a key and a URL; `qrcode/poll` returns `waiting` for a
fresh key, `expired` for an unknown one, and a clean error for a malformed one;
`whoami` correctly returns null for no cookie and for a junk cookie. Resolution
works end to end signed-out — `pagelist` → `playurl` → a real 720p MP4, through
`/api/extract`, through the bridge with the right referer, 206 with `video/mp4`
bytes.

**What was NOT verified:** the middle of the login. Confirming a QR needs a phone
with the Bilibili app signed in, which is Rj's, not this server's. So the
`state: 'ok'` branch — cookies parsed out of `Set-Cookie`, sealed into `cb_bili`,
and then used to ask for a better quality — has never run.

**Assumption made:** shipped it. Signed-out resolution is the common case and is
proven; the sign-in only adds quality and members-only reach, and if the cookie
parse is wrong the panel says "confirmed the sign-in but sent no session" rather
than failing silently.

**Two facts worth knowing, both measured 2026-09-07:**
- `www.bilibili.com/video/<bvid>` and `api /x/web-interface/view` return **412**
  to both this VPS and Vercel — Bilibili risk control refuses datacentre traffic.
  `pagelist`, `playurl`, `nav` and the passport endpoints all answer 200. The
  implementation avoids the two blocked ones entirely; if Bilibili extends the
  block to `pagelist`, the feature dies and the panel will say 412.
- Casting is capped at **720p**. `platform=html5` is the only response shape that
  is a single file, and a Cast receiver cannot assemble the DASH form's separate
  video and audio streams. Not a shortcut — it is the ceiling.

**No QR is drawn**, deliberately: on a phone the link opens the Bilibili app
directly, and shipping a hand-written QR encoder whose output this box has no way
to decode and check would risk an unscannable code. If Rj wants one for desktop,
vendor a tested library.

**Context Rj needs to review:** `lib/bilibili.js`, `api/bilibili.js`. Open the
Bilibili panel, tap Sign in, confirm on the phone, then paste a members-only link.

## 2026-09-07 — the stream panel

**hallmark on `index.html` reports five [73] "form posts nowhere" and a
multiple-H1.** Pre-existing and not touched by this session's commits: the
forms are wired by listeners in `app.js`, which the checker cannot see. Left
alone rather than silenced — a `<form action>` added only to quiet a gate is
worse than the finding. Worth a real look at the two H1s.

**The stream host's `.env` is not in the repo, by design.** It is at
`/opt/cast-stream/.env`, `chmod 600`, gitignored, and it carries
`STREAM_UPLOAD_SECRET`. If that box is ever rebuilt, that file is the thing
to restore first — the README's first-time block writes it.

**One em-dash finding stands on purpose.** `hallmark` counts em-dashes as a
copy smell; RJ-Design-Skill §data-display 1.5 requires an em-dash for a
missing value, never a blank. The correctness layer wins, as its own
ordering says it should.

**Context Rj needs to review:** dashboard → **Stream** (below Terminal), and
the app's own **Stream host** panel for the same numbers from the phone.

## Round 9 — 2026-09-07

## Task 1: the screen-recorder survived the panel's removal

**Question:** "Remove this if cannot use" — does that include the working part?
**Assumption made:** no. What cannot be used is screen MIRRORING, and those
instructions are gone in full. Recording the screen and playing the recording on
the television does work, and it is now a single button on the Cast screen with
no explanation attached, shown only where the browser implements
`getDisplayMedia` and `MediaRecorder`. On your phone it will not appear at all,
which is the same thing you saw before minus the wall of text.
**Context you need to review:** `assets/js/app.js`, the "Record this screen"
section. Say the word and the whole thing goes.

## Task 2: the QR needs a second device on a phone

**Question:** a QR on a phone is a code that same phone cannot scan. Is that
useful?
**Assumption made:** yes, and it is what Bilibili offers — the QR is the only
web sign-in they have that does not end in a captcha. Drawn here it works
whenever a second device is to hand, which is the desktop case and the
two-phones case. For the one-phone case the screen still offers **Copy the
sign-in address**, described accurately this time: it is an address to open in
Bilibili, not a link that opens the app. It is not a deep link and never was.
**Context you need to review:** the Bilibili screen, waiting state.

## Task 3: share links are public, deliberately

**Question:** should a share link require a sign-in?
**Assumption made:** no, it cannot. A television fetches with no headers we
control, so the address IS the credential — that has always been true of
`/f/<id>` and the watch page inherits it. 32 hex characters is not guessable and
the page is `noindex`, but anyone you send it to can forward it. The Library
says so in those words rather than assuming it is understood.
**Context you need to review:** the note at the top of the Library screen.

## Task 4: the retention ceiling is 30 days

**Question:** how long may a file be kept?
**Assumption made:** "until I delete it" is offered with no ceiling, because
that is a decision you are making about your own disk. Every timed choice is
clamped to `CAST_MAX_KEEP_HOURS`, default 30 days, so a typed-in 99999 becomes
720 rather than being taken at its word. Change the env var if you want a
different number.
**Context you need to review:** `server/storage.js`, `MAX_KEEP_HOURS`.

## Task 6: the bottom bar carries five entries, not nine

**Question:** nine screens, how many in the bar?
**Assumption made:** five. RJ-Design-Skill navigation-and-feedback §2.3 puts the
line at five: under it a tab bar, over it a Sections sheet. So the fifth entry
IS the sheet — More — and Bilibili, Stream host, People and the TV help live
behind it with a Menu button back. Nine across a 390px screen would be 43px per
target with the labels unreadable.
**Context you need to review:** the More screen. If you want Library out of the
bar and something else in, it is one line in `NAV_VIEWS` plus the markup.

## Bilibili: I could not reproduce "invalid QR code" from here

**Question:** the Bilibili app told you the code was invalid. Which code — the
one on screen at the time, or a screenshot taken earlier?

**Assumption made:** the code was older than the panel let on. That is the one
cause I could measure: Bilibili's key outlives the three minutes the panel gave
it, and the panel's own countdown had no relationship to Bilibili's. Everything
else checks out — the symbol is byte-identical to a reference encoder, a
screenshot of the running app decodes to the live URL, and the key it decodes to
polls as unscanned at Bilibili. I have no Bilibili account here, so the one step
I cannot perform is the scan itself.

**Context you need to review:** if it still says invalid on a code that is fresh
on the screen, the next suspect is the account, not the picture — Bilibili's
risk control has already been refusing this server elsewhere (`lib/bilibili`
documents the 412s). In that case use **Paste a sign-in instead**, which has no
camera and no key in it, and tell me — that would be evidence I cannot get on
my own.

## Bilibili: a pasted session is a real credential in a textarea

**Question:** is asking for SESSDATA acceptable?

**Assumption made:** yes, because the QR flow already ends with the same three
cookies in the same signed HttpOnly jar — pasting changes how they arrive, not
what is kept or where. The field is `autocomplete="off"`, it is emptied the
moment the session is accepted, and only SESSDATA, bili_jct and DedeUserID are
read out of whatever is pasted; a full `document.cookie` dump from bilibili.com
carries a dozen tracking values and none of them are stored. The server asks
Bilibili to confirm the session before writing anything.

**Context you need to review:** `lib/bilibili.js parseCookieText`, and the
`paste` branch of `api/bilibili.js`. The one thing to be aware of is that
SESSDATA is a full account credential — a person you hand it to is signed in as
you until you sign out on bilibili.com. Do not paste someone else's.


## Task 22: unpacking a page's own scripts

**Question:** is reversing a packed script something this app should do?
**Assumption made:** yes, and it is not a protection being undone. Dean
Edwards' packer is a 2000s minifier — it ships its dictionary and its decoder
in the page because the browser has to read them. What comes back is the same
text the browser gets. It is done by substitution, never by `eval`: the payload
is a stranger's JavaScript and this runs on our server, so executing it would
hand every page we scan the ability to run code here. That is asserted by
consequence in `scripts/test-unpack.js`, not by grepping for `eval`.
**Context you need to review:** `lib/media.js`, the "Packed player scripts"
section. If you would rather this never ran, delete the `deobfuscate(` call in
`api/extract.js` and the one in `readFrames` and the app returns to its old
behaviour on these hosts, which is "nothing found, try the deep scan".

## Task 24: the re-issue can hand back a different quality

**Question:** when the bridge has to ask the page again for an address, and the
exact quality is gone, should it refuse or substitute?
**Assumption made:** substitute, and prefer playing. The renditions differ only
inside the signed part of the address, so without the label they are
indistinguishable; the label now travels with the request as `&q=`. If the
label finds nothing, it takes the first of the same shape — which can mean 192p
where 720p was asked for.
**Context you need to review:** `lib/reissue.js` `reissue()`. If you would
rather see an honest failure than a soft picture, drop the `sameShape` and
`sameHost` fallbacks and return null when the label misses.

## Task 24: what the re-issue is allowed to return

It only ever hands back an address on the SAME host as the one that was
refused, because the page it re-reads belongs to a stranger and this runs
inside a request a television is waiting on. Without that rule a scanned page
could point the TV anywhere it liked. Asserted in `scripts/test-reissue.js`.

## Task 26: the old Vercel address still answers

`cast-bridge.vercel.app` is still attached to the project alongside
`cast.jrvsystems.app`. I left it rather than removing it, because anything you
have already installed or bookmarked points at it. Say the word and I will
detach it; the app itself has no reference to either name.

## Not done: sitemap.xml

The earlier note here said a sitemap was skipped because the deployed domain
was unknown. It is now `cast.jrvsystems.app`. Still skipped — it is a private,
password-gated utility with one route, and `robots.txt` already tells crawlers
to stay out. Ask and it is a two-line file.

## Task 28: notifications are local, and there is no push

There is no push server and no subscription, deliberately. A bridge between a
phone and a television has nothing to say when the phone is not running, and
asking for push permission in order to say nothing is how an app earns a
permanent "Blocked". Everything is `registration.showNotification` driven by
the running page.
**What this costs:** if the app is fully closed — not backgrounded, closed —
an upload cannot continue and nothing is reported, because there is no page to
report it. Tell me if you want a finished upload to notify a closed app and I
will wire real Web Push; it needs VAPID keys and a subscription table.

## Task 30: the lock-screen widget disappears while casting, and that is the platform

**Question:** should the Media Session widget stay on the lock screen while a
film is on the television?
**Assumption made:** it cannot, so the notification carries the controls
instead. The OS draws that widget from the audio the tab is producing, and
while casting the local element is paused on purpose — two soundtracks a few
seconds apart in one room. No amount of metadata makes Android draw it.
**Context you need to review:** `mediaSession` in `assets/js/app.js`. If you
would rather the phone kept playing silently to hold the widget, that is a
muted local playback and a battery cost, and I did not assume you wanted it.

## Task 31: a kept subtitle is reachable by anyone with its id

Same bargain the Library makes, for the same reason: the thing fetching the
track is a Chromecast, which carries no session and cannot be made to. The id
is a random uuid, there is no listing endpoint, and nothing lets you walk from
one to the next — but the address IS the credential, and the screen says so in
those words. Kept 30 days, swept when the next upload happens and enforced
again on read.

## Task 32: `/series/bigg-boss` comes back in the seasons list

It is the page's own parent, not a child of it. I left it: tapping it lands on
the series page, which then offers the season, so it leads somewhere useful
rather than nowhere. Say the word and I will exclude a link whose address is a
prefix of the page's own.

## Task 32: what the crawler cannot do

- **A page that builds its list in JavaScript.** The crawl is a fetch and a
  parse, like `/api/extract` — it never runs the page. Rj's site happened to
  put the list in the delivered HTML one hop down, which is why the follow
  works; a site that renders episodes purely client-side will come back empty
  and say so. `/api/scan` runs a real browser but looks for MEDIA, not links.
  Making it also report anchors is the fix if you hit that.
- **Pagination.** A season split across "Page 1 / 2 / 3" returns only the
  page you gave it. Not attempted; say if you want it.
- **Verified against two real sites**, desicinema.org (two different shows,
  two different slug shapes) and a Wikipedia episode list, plus 31 synthetic
  cases. Wikipedia is what found four genuine defects — see the four
  regression tests named after it in `scripts/test-crawl.js`.

## Task 34: no live end-to-end test of /api/series from here

**Question:** does the shelf work against the real database?
**What I could and could not prove:** the upsert semantics are proven directly
against the live `castbridge.series` table — same row id, title and episode
list replaced, exactly one row — and the proof row was deleted afterwards. The
HANDLER was not exercised over HTTP, because signing in locally needs
`CAST_SUPABASE_SERVICE_KEY` and the Vercel API returns every value as
ciphertext.
**Worth your eye:** running `node scripts/dev.js` from this machine silently
inherited `SUPABASE_URL` for a DIFFERENT project (`qvnqfvlkaliydqtwptpv`, not
cast-bridge's `ifbebbjpvrhbvfngydnr`), because `lib/db.js` falls back to the
bare `SUPABASE_*` names. I killed it and re-ran with those stripped, so
nothing touched a foreign database — but a local run on any machine with those
variables set will point this app at the wrong store without saying so.

## Task 35: the migration ledger version will not match the filename

`db/002_castbridge_subtitles_series.sql` was applied through the Supabase
management API, which stamps its own timestamp version rather than the `002`
in the filename. The file is the reviewable record and is re-runnable; the
ledger row is not named after it.
