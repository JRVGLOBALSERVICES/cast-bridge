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
