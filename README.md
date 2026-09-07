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
- `?u=<encoded-url>` — deep-link straight into the player.

## What a browser cannot do, and this is honest about

- **Screen mirroring.** No web API exposes the screen to a television. Chrome's
  own menu → Cast → Cast screen does it; a page cannot.
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
assets/  app.js · app.css (neumorphism, one dark surface: the on-air panel)
db/      001_castbridge_schema.sql
scripts/ dev.js — local server that routes the functions like Vercel does
         stamp-build.mjs — assembles public/ and stamps sw.js BUILD
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
