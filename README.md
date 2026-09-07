# Cast Bridge

Paste any link. It works out what the video is, plays it, and sends it to the
television — with the phone left holding an actual remote.

A page address is read server-side and every stream on it is listed. A file
address plays straight away. Nothing has to be a `.mp4` for this to work: an
extensionless signed CDN link is identified by what the server answers with,
not by its name.

## What it does

- **Extract from a page** — `/api/extract` fetches the page and reports every
  media reference on it: `<video>`, `<source>`, Open Graph, JSON-LD, player
  configs, HLS and DASH manifests. It follows up to three `<iframe>`s, since a
  wrapper page's video usually belongs to the host it delegates to.
- **Deep scan** — `/api/scan` runs a real headless browser for the players that
  build their source in JavaScript, which a fetch-and-parse can never see.
- **Cast to TV** — Google Cast (Chromecast, Google TV, Android TV). Chrome on
  Android or desktop Chrome; no other browser has the API.
- **The remote** — once it is on the TV: position with a live scrubber, ±10s,
  play/pause, volume, mute and stop, all reported back by the receiver.
- **Subtitles** — paste an `.srt` or `.vtt` link. `/api/subs` converts it to
  WebVTT and re-serves it cross-origin-open, because that is the only thing a
  Cast receiver will fetch. The same copy captions the phone.
- **AirPlay** — Remote Playback API, where the browser has it (Safari, iOS).
- **Open in VLC** — hands the link to VLC on the phone (Android intent, iOS
  x-callback). This is the route to Samsung, LG, Roku and Fire TV, which no
  browser can reach.
- **Accounts and history** — Supabase-backed, so what was watched and where it
  was paused survives a reinstall or a different phone.
- **A file from the phone, and a link for it** — the upload lands on the stream
  host and comes back with a public watch page,
  `https://stream.jrvsystems.app/w/<slug>-<32 hex>`. Anyone with that address
  watches it in a browser with no sign-in; the 32 hex characters are the whole
  credential, so an address that is not given out cannot be found. You choose at
  the point of sending how long it stays — 1 day, 7, 30, or until you delete it
  — and **Library** lists everything you have up there with re-cast, copy-link,
  re-date and delete.
- **Bilibili** — QR sign-in, with the code **drawn in the app**
  (`assets/js/qr.js`). What Bilibili's API returns is the payload of a QR, not a
  page: offered as a link it opens a scan page that does nothing. Two things
  follow from a QR needing two devices. **Save this code** writes it out as a
  PNG, so one phone can hand it to Bilibili's own scanner from its album; and
  **Paste a sign-in instead** takes a session copied out of any signed-in
  browser (`SESSDATA`), which is the route with no camera in it at all. A code
  Bilibili lets lapse is replaced where it stands rather than being wiped off
  the screen — the panel used to give up after three minutes on a key that is
  good for something over ten.
- `?u=<encoded-url>` — deep-link straight into the player.

## What a browser cannot do, and this is honest about

- **Screen mirroring.** No web API exposes the screen to a television. The Cast
  sender API takes an address for the TV to fetch, never a live picture; the
  Presentation API shows a *different* page on a registered receiver; and
  `getDisplayMedia` can capture but cannot then hand the stream to a Chromecast.
  Chrome's own menu → Cast → Cast screen does it, and a page cannot. The app
  used to carry a panel of instructions for that menu, which was correct and
  useless; it is gone. What is left is **Record this screen** — capture, stop,
  upload, play — shown only where the browser can actually do it, which is
  Chrome and Edge on a computer.
- **A file on the phone.** The TV fetches over the network and cannot reach the
  phone's storage, so a locally-picked file has no address to be fetched from.
- **DLNA discovery** (Samsung, LG) needs SSDP over UDP multicast, which is not
  reachable from a browser at all. Hence the VLC hand-off.
- **Walled services** — Netflix, Disney+ and the like are DRM-protected and are
  refused up front rather than failed at slowly.

## Layout

```
api/     extract · scan · subs · auth · users · history   (Vercel functions)
lib/     media.js  — fetch guards, extraction, probing, HLS expansion
         subs.js   — SRT → WebVTT
         db.js · auth.js · users.js
assets/  app.js  — nine screens behind a five-entry bottom bar, one job each
         qr.js   — byte-mode QR encoder, versions 1-10, level L (Bilibili)
         app.css — neumorphism, one dark surface: the on-air panel
db/      001_castbridge_schema.sql
scripts/ dev.js — local server that routes the functions like Vercel does
         stamp-build.mjs — assembles public/ and stamps sw.js BUILD
server/  stream-server.js — runs api/stream.js as a service on our own box
deploy/  stream.jrvsystems.app.conf — the nginx vhost in front of it
```

## Design system

Neumorphism on a single `--cb-surface: #e6e7ee`, with one dark surface — the
on-air panel — where the accent switches to `--cb-accent-dark: #7d93f2` to hold
contrast. Tokens live at the top of `assets/css/app.css`.

| Role | Token | Value |
|---|---|---|
| Surface | `--cb-surface` | `#e6e7ee` |
| Accent | `--cb-accent` | `#2d4cc8` |
| Accent, on dark | `--cb-accent-dark` | `#7d93f2` |
| Body text | `--cb-ink-2` | `#525480` (5.80:1) |
| Decoration only | `--cb-mute` | `#93a5be` (2.04:1 — never text) |
| Danger | `--cb-bad` | `#a91e2c` |
| Radius | `--cb-radius` / `-xl` | `0.55rem` / `0.95rem` |

Rules the code holds to: every remote control clears a 44px target; elapsed and
volume figures are tabular so the row does not twitch under a thumb; red is
spent on errors only, so *Stop casting* is a bordered ghost button set apart
from the transport rather than a red one beside it.

## Local

```
npm install
node scripts/dev.js        # http://127.0.0.1:3400
```

The static files are served from the repo root and the functions are routed the
way `vercel.json` routes them. `/api/extract`, `/api/users` and `/api/history`
need a session; `/api/subs` deliberately does not, because the thing fetching a
subtitle track is a Chromecast and it carries no session.

## Deploy

Vercel. `buildCommand` runs `scripts/stamp-build.mjs`, which copies the named
static entries into `public/` and stamps `sw.js` with the commit SHA — a
byte-identical service worker is never reinstalled, so an installed copy would
otherwise keep serving the old shell. The build refuses to ship if the `BUILD`
line is missing.

Confirm what is live by fetching `/sw.js` and reading its `BUILD`. On the phone,
pull down to reload before judging a change.

## The stream host

Everything except the film is on Vercel. The film is not.

`/api/stream` is the one endpoint that carries the media itself, and on Vercel
every byte of it is billed twice — once function-to-CDN as Fast Origin Transfer,
once CDN-to-television as Fast Data Transfer. The data leg has a terabyte
included; the origin leg has no free allowance at all, so a proxied stream costs
from its first byte, around **$0.27/GB** in Singapore. That is $1.35 to watch one
5 GB film, and since every HLS stream goes through the proxy by definition, it is
the ordinary case rather than the exception. Compute is noise next to it.

So the same handler also runs on our own VPS, which is in Singapore, has no
per-gigabyte charge, and is a few milliseconds from the television doing the
fetching:

```
https://stream.jrvsystems.app/api/stream   nginx :443 → node :7801
```

`server/stream-server.js` **requires the same `api/stream.js`** rather than
reimplementing it. There is one referer-forwarder, one playlist rewriter, one
disguised-segment detector and one SSRF guard, and both hosts run it.

Two things differ on the VPS, both by environment:

- `STREAM_RANGE_WINDOW_MB=64`. The 8 MiB window exists because Vercel kills a
  function at 60 seconds; with no execution limit a wider one means the same
  film in fewer, longer reads.
- Bytes served are counted per day into `/var/lib/cast-stream/usage.json` and
  reported by `/healthz`, so "what does this cost" has a measured answer.

It carries the uploaded files too, under one root and nothing outside it:

```
POST /api/upload?name=…&size=…&keep=<hours|0>   upload ticket
GET  /f/<32 hex>                                what the television fetches
GET  /w/<slug>-<32 hex>                         the page a person is given
GET  /api/library                               my own uploads      library ticket
POST /api/library/keep    { id, keep }          re-date one of mine
POST /api/library/delete  { ids }               remove one of mine
GET  /api/storage · /api/system                 the whole disk      storage ticket (owner)
```

`keep` is hours, `0` meaning until deleted by hand, clamped to
`CAST_MAX_KEEP_HOURS` (30 days). It is written into the file's meta as an
`expires`, and the sweeper reads that meta rather than mtime — two files
uploaded in the same minute can now carry a one-day expiry and a never, and
mtime cannot tell them apart. A meta from before retention existed has no
`expires` and is treated as the old blanket day from when it landed.

`STREAM_HOSTS` in `assets/js/app.js` is the order they are tried: the VPS first,
this origin second. The Vercel function stays deployed and is not decoration — a
box that is rebooting would otherwise take casting with it. A stream that stalls
or is refused on the first host is retried on the second, and the cast log names
which one served it.

Deploying the stream host:

```
git -C /opt/cast-stream pull && pm2 restart cast-stream
curl -s https://stream.jrvsystems.app/healthz
```

Or press **Update** in the bridge dashboard's **Stream** section, which does
exactly that and then re-reads the health. That panel is the reason
`/api/system` exists: `/healthz` says the service is up, `/api/system` says
what the box is doing — load, memory, host uptime, node, pid and the commit
read out of `.git`, behind the same owner-only ticket as the file list. The
deploy clone was six commits behind the app it serves for a day and nothing
on any screen said so; the panel now shows how far behind it is.

First time on a box:

```
git clone …/cast-bridge.git /opt/cast-stream        # no npm install — the
                                                    # stream path uses only
                                                    # node's own modules
mkdir -p /var/lib/cast-stream/media

cat > /opt/cast-stream/.env <<'ENV'
PORT=7801
STREAM_RANGE_WINDOW_MB=64
STREAM_STATE_DIR=/var/lib/cast-stream
CAST_FILES_DIR=/var/lib/cast-stream/media
STREAM_PUBLIC_HOST=https://stream.jrvsystems.app
STREAM_UPLOAD_SECRET=…same value as the app project's…
ENV
chmod 600 /opt/cast-stream/.env

cd /opt/cast-stream && pm2 start server/stream-server.js --name cast-stream --time
pm2 install pm2-logrotate && pm2 set pm2-logrotate:max_size 20M
pm2 save
```

The `.env` is not decoration. Started with the variables typed on the command
line instead, they live nowhere but pm2's own dump: `pm2 delete cast-stream`
takes `STREAM_UPLOAD_SECRET` with it, and the only symptom is every upload
answering 503 — file casting silently off, with nothing broken enough to
notice. Anything already in the environment still wins over the file, so pm2's
env and a one-off `FOO=bar node server/…` both keep working.

The logrotate line is not optional: the service logs one line per range
request, and a film is thousands of them.

The nginx vhost is scoped to `/api/stream` and `/healthz` and 404s everything
else, on purpose: it is a new public hostname on a box that also runs the bridge
and its admin console. `proxy_buffering off` is load-bearing — with buffering on,
nginx reads the whole film to disk before sending any of it.
