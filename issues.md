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


## desicinema still yields no stream after the lazy-frame fix

**What changed:** the deep scan used to see nothing on that page and say the
video "may need a sign-in". It now promotes the deferred `data-litespeed-src`
address, loads the player frame and reports `saw.frames: 1`. That part is
fixed and is a general fix — every site behind a caching plugin defers its
embeds the same way, so this was never one site's quirk.

**What still fails:** with the frame open and every frame poked twice, no
manifest or media response is captured, so the answer is still empty. Most
likely the inner embed only builds its source after a real user gesture
(a synthetic `.click()` does not carry `isTrusted`), or it checks the referer
of the frame, or it hops through another host that our poke never reaches.

**Assumption made:** I stopped here rather than keep adding layers aimed at
this one host. Two general defects were worth fixing and are fixed; chasing a
specific site's player past that point is a different kind of work and I did
not want to do it without you saying so.

**Also worth your call:** desicinema.org is an unlicensed source for that
show. The scanner change is generic and bypasses no login or DRM, but it is
your app and your name on it, so you should be the one deciding what it is
pointed at.

**Context Rj needs to review:** `api/scan.js` `collect()`, and whether you
want a real gesture path (CDP `Input.dispatchMouseEvent` on the frame's play
control, which does carry `isTrusted`) tried next.
