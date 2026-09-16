# Design research — 20260916-now-logs-shows-phone-player

Research only. No app code touched. All web references were fetched and screenshotted in this
session (2026-09-16) with agent-browser at a 390x844 viewport. Screenshots show the store/landing
page as served to a phone browser; for app-store listings the in-app screens are only visible as
the small screenshot carousel on that page, so takes about in-app UI lean on the listing text and
those carousel thumbnails, not on hands-on use.

## Current Cast Bridge (baseline)

- `current-castbridge-390.png` · http://127.0.0.1:5173/index.html served locally with `python3 -m http.server` · Only the password gate renders (light neumorphic "Cast Bridge" sign-in with an equaliser-bar graphic). No credentials were used, so the Browse / player / History / Logs screens were not captured.

## Live references (fetched this session)

1. https://apps.apple.com/us/app/web-video-cast-browser-to-tv/id1400866497 · `ref-01-webvideocast-appstore.png` · Web Video Cast (iOS): built-in browser grabs the video URL from the page, "Connect" device picker listing TVs by room (Home Theater / Bedroom / Samsung TV / Apple TV), cast controls with a larger touchable scrubber, detects on-page subtitles, tab groups + tab search, pop-up/redirect blocking · Take: the device list is grouped by room name, not by protocol; casting is one tap from the page you are on.
2. https://play.google.com/store/apps/details?id=com.instantbits.cast.webvideo&hl=en_US · `ref-06-webvideocast-play.png` · Same app on Android (50M+ downloads, 2.4M reviews); carousel is literally "SEARCH → CONNECT → ENJOY" · Take: the whole product is sold as a three-step sequence, and the UI follows that order.
3. https://apps.apple.com/us/app/localcast-cast-to-tv/id969804264 · `ref-02-localcast-appstore.png` · LocalCast: "Built-in browser detects videos automatically", web browser screen with URL bar + New Tab / Tabs tiles, now-playing remote (play, pause, seek, volume, skip), queue and playlists, sleep timer · Take: the first carousel frame appears to show a now-playing bar pinned at the bottom of the home screen (thumbnail too small to confirm), so the remote stays reachable while you browse.
4. https://apps.apple.com/us/app/castify-cast-web-videos-to-tv/id1530642487 · `ref-03-castify-appstore.png` · Castify: dark UI, side menu (Start, Search, Web Browser, Local Files, Bookmarks, Recent), browser home with URL field and a cast icon permanently in the top bar · Take: the cast/connection icon sits next to the address bar at all times, so "am I connected" is always answered without leaving the page.
5. https://firecore.com/infuse and https://firecore.com/blog/infuse-8-now-available · `ref-04-infuse-firecore.png` · Infuse 8: player overlay redesigned for quick access to audio/subtitle track, volume boost and playback speed; AirPlay + Google Cast · Take: secondary controls (tracks, speed) are one tap on the overlay rather than buried in settings.
6. https://video-tv-cast.com/ · `ref-05-video-tv-cast.png` · Video & TV Cast: marketing site leading with a hand holding a remote, then a per-TV-brand picker (Chromecast, Samsung, LG) · Take: they make you pick the TV family first, which is exactly the step Cast Bridge's "TV mode" could avoid. A cookie banner covers the lower half of the capture; I did not dismiss it.
7. https://support.google.com/chromecast/answer/7649824?hl=en · `ref-07-google-media-controls.png` · Google Media Controls: control any Cast session (up to 4 devices) from outside the app that started it; open the Google Home app and tap the current media session (the page says it is not available on Android and may be missing on some iOS versions) · Take: the "session" is a first-class object you return to, not a screen inside one app.

Reached but not used for screenshots: search results for Castify's second listing (id1629859529) and CastBrowser (Play). Not attempted: Arc Search, Samsung Internet pop-out, Apple TV Remote, Plex — Mobbin covered the browser and now-playing patterns instead.

## Mobbin screens (search_screens, iOS)

- Hulu player with cast/AirPlay icon in the player chrome and the episode queue directly under it — https://mobbin.com/screens/3d7f29ec-07da-4edc-8174-4a5f21eb762b · Better than paste-a-link: player on top, "Watching / Up next" list below on the same screen; the AirPlay icon turns blue when a target is active.
- Matter mini player floating above the tab bar (title, time left, pause, close) — https://mobbin.com/screens/0b904b91-7534-4504-aad0-d3d898ef0c1e · Better: playback state follows you across tabs; one pill, three actions.
- Matter full now-playing (big art, scrubber, ±15s, speed, AirPlay, sleep) — https://mobbin.com/screens/45e6fb89-7fc2-49ef-b85e-3b75bce907ae · Better: output device is a single icon in the bottom row, same weight as speed; dark canvas so the art is the only bright thing.
- Comet (browser) page-actions bottom sheet with page title + URL header, then Reload / Favorite / Share tiles — https://mobbin.com/screens/3a42d14c-44f9-4404-a62f-17764987de05 · Better: every action about "this page" comes from one sheet anchored to the page identity, instead of scattered buttons.
- Brink mini player docked under a floating tab bar — https://mobbin.com/screens/eca83382-f024-4089-81df-9fdcd5ba0ca9 · Better: now-playing and navigation are one stacked unit at the thumb, never overlapping content.
- Also seen: Opera iOS address bar + bottom toolbar (https://mobbin.com/screens/436452a4-3933-45d8-956a-5aaf52f184eb), Box Box Club "Listen on / Watch on" destination sheet (https://mobbin.com/screens/3d235cdd-5999-4919-8e92-8ff30a664ea3) — a clean model for a "Play on: This phone / Living room TV / TV mode" chooser.

## refero-styles

- `refero_search("media streaming dark app remote control player")`, `("browser utility tool minimal")`, `("video streaming tv cinema dark")` — the catalog runs in keyword mode, results are loose. Best fit: Frame.io ("midnight cinema projection room", one blue accent).
- `refero_similar("frame.io")` → Vimeo, Framer, Stink Studios, Design Full-Time.
- `DESIGN.md` in this folder = Frame.io system, annotated with how it would map onto a phone cast app.

## 3 things these refs do that Cast Bridge does NOT

1. **The cast session is always on screen.** LocalCast, Matter, Brink and Hulu keep a mini player / device state visible on every tab. In Cast Bridge the player, History and Logs are separate destinations, so once you go back to Browse you lose sight of what the TV is doing.
2. **The output target is one chip, not a mode.** Web Video Cast, Matter and Hulu show "where it's playing" as a single icon or chip (blue when active) that opens a device list named by room. Cast Bridge splits Chromecast / AirPlay / TV mode into separate paths the user has to understand.
3. **Detected media is attached to the page you are on.** Web Video Cast and LocalCast surface found videos from the browser chrome (and Comet shows how a page-anchored sheet works). Cast Bridge's framed browser and its detection results are not tied together in one surface at the address bar.

## The one fresh move

**A single "cast dock" that is bound to the Browse address bar and never leaves the screen.**
Collapsed, it is a pill above the tab bar: detected-media count on the left ("2 videos found"), and once something plays it turns into the mini player (thumbnail, title, where it's playing — "Living room TV" / "This phone" / "TV mode" — play/pause). Tap the count and a sheet slides UP out of the dock listing the videos found on the current page with duration/quality and a "Play on" row (This phone · TV · TV mode). Swipe the dock up and it becomes the full remote (scrubber, ±10s, tracks, volume). Logs and History open as tabs inside that same sheet, so "why did it fail" sits next to the thing that failed. Dark canvas per DESIGN.md so the page and the video stay the brightest thing in a dim room.

## Components / libs from design-library-index-2026-W38 that fit

- **Magic UI — Dock** (https://magicui.design/docs/components/dock): starting point for the pill dock's button row (restyle to DESIGN.md tokens, no magnification on touch).
- **Magic UI — Progressive Blur** (https://magicui.design/docs/components/progressive-blur): fade the framed page under the floating dock so it reads as layered without a hard bar.
- **Magic UI — Animated List** (https://magicui.design/docs/components/animated-list): videos appearing in the detected-media sheet as the scanner finds them.
- **Motion v13.4.0 / motion.dev "React iOS App Folder" example** (https://motion.dev/examples/react-ios-app-folder): the dock → sheet → full remote expand as one shared-layout morph. Note Cast Bridge is vanilla JS, so this would be Motion's vanilla `animate()` API or plain CSS/View Transitions rather than the React component.

## Could not reach / limits

- Cast Bridge beyond the password gate (no credentials used).
- App-store in-app screenshots are small carousel thumbnails; no hands-on use of any app.
- video-tv-cast.com capture is partly covered by its cookie banner.
- Google's Media Controls page gives no screenshot of the control surface itself.
- refero-styles ran in keyword (not embedding) mode, so its matches are rough.
