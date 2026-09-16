# Design research — 20260916-cast-app-with-in-app

Research only. No app code touched. Second pass on the same topic as
`../20260916-now-logs-shows-phone-player/` (Task 40, earlier today). That pass already covered
Web Video Cast, LocalCast, Castify, Infuse, Video & TV Cast and Google Media Controls, and proposed
the "cast dock". This pass uses only NEW references and does not repeat those findings.

Literal search `"cast app with in app browser"` run first (WebSearch, 2026-09-16). It returned
CastBrowser, Web Video Cast, Video & TV Cast, Cast to TV/Chromecast/Roku and Google's Cast docs.
A second search (`best browser cast to TV app 2026 …`) added iWebTV and castbrowser.tv.

Screenshots: agent-browser at 390x844, this session. Store listings only show the in-app UI as a
small carousel, so takes lean on listing text plus those thumbnails, not hands-on use.

## Live references (fetched this session)

1. https://play.google.com/store/apps/details?id=tv.castbrowser.app&hl=en_US · `ref-01-castbrowser-play.png` · CastBrowser (Android, 10K+): built-in browser, pop-up/tracker blocker, "Cast to Device" sheet in the carousel · Take: the device sheet lists "Web Receiver" (a TV's own browser) as a row next to Chromecast and Samsung, so the browser-on-TV route is just another destination.
2. https://castbrowser.tv/ · `ref-05-castbrowser-tv-site.png` · CastBrowser site: "Browse → Tap the video badge ('1 video found') → Cast to… Living Room TV / Bedroom TV / Fire TV Stick", quality choice SD/HD/4K, "Use Web Receiver" help page · Take: the badge opens "every stream available on that page", and quality is picked there, before casting, not in settings.
3. https://play.google.com/store/apps/details?id=castwebbrowsertotv.castwebvideo.webvideocaster&hl=en_US · `ref-02-casttotv-roku-play.png` · Cast to TV/Chromecast/Roku by InShot (10M+, 4.4★): browser home is a grid of site shortcuts (YouTube, Vimeo, Facebook…) under the URL bar · Take: the empty browser is never blank. It opens on the sites people actually cast from.
4. https://apps.apple.com/us/app/cast-web-videos-to-tv-iwebtv/id999462129 · `ref-04-iwebtv-appstore.png` · iWebTV (iOS, 175K ratings, 4.8★): "HD up to 4K", "Subtitle Finder", phone stays usable while the TV plays · Take: subtitles are a headline feature with their own name and icon, not a buried option.
5. https://developers.google.com/cast/docs/design_checklist/sender · `ref-03-google-cast-design-checklist.png` · Google Cast sender design checklist: cast button always available and shows connection state; mini controller persists at the bottom on every screen; expanded controller shows title/art before playback, a loading indicator while buffering, and the receiver's state; volume slider synced to the receiver; after an implicit disconnect (network drop, phone sleep) the session is restored and the TV keeps playing · Take: this is the rulebook the big apps follow. "Reconnect silently and keep the TV playing" is a requirement, not a nice-to-have.

## Mobbin (search_screens + search_flows, iOS)

- HBO Max "Casting a show to a TV" — https://mobbin.com/flows/5b64fef9-ba2f-4ff0-bd5e-8f959b68ee24 · `mobbin-hbomax-playing-on-bedroom-tv.jpg`, `mobbin-hbomax-casting-now-playing.jpg` · The dimmed player on the phone says "Playing on Bedroom TV" in the middle of the frame; the now-playing screen repeats "Casting to Bedroom TV" under the controls. The cast icon turns blue.
- Google TV "Connecting to a TV" — https://mobbin.com/flows/f4a1c6f0-b7ae-427b-a896-b4f3c2535f41 · `mobbin-googletv-select-device.jpg`, `mobbin-googletv-connected-bar.jpg` · A "TV Nearby" pill appears on its own. The device sheet explains Wi-Fi/Bluetooth right under the list. Once connected, a bar above the tab bar says "Connected · Living Room TV", with remote and TV buttons.
- Tubi "Select a casting device" — https://mobbin.com/flows/17daf7c9-d93e-47be-aafa-d6773c1f3ed9 · `mobbin-tubi-local-network-permission.jpg` · Before searching, a sheet says why it needs the local network ("Tubi uses the local network to find your TV"). The picker shows "Finding more devices" with a spinner and a "Can't see your TV or casting device?" link inside the sheet.
- Equinox+ "Casting a video to another device" — https://mobbin.com/flows/90e8e274-3f8b-4d10-ab0c-15ffa9456a20 · The AirPlay picker opens over the running video. The cast and CC buttons sit together as two round icons.

## refero-styles

`refero_search("dark media remote control video player utility")` (keyword mode, rough). The nearest
fit is Trunk: "monochrome control room with one green signal light", a near-grayscale UI where the
only colour marks a live state. That matches a cast remote, where the only thing that should be lit
is "the TV is playing". The Frame.io `DESIGN.md` from the earlier pass still applies, so no new
DESIGN.md was written.

## 3 things these refs do that Cast Bridge does NOT

1. **The player says where the film is, in words, on the picture.** HBO Max writes "Playing on Bedroom TV" across the dimmed phone player. Google TV's bar says "Connected · Living Room TV". Google's checklist requires the receiver's state and a loading indicator on the controller. In Cast Bridge the phone's player area does not tell you, in one line, which screen is playing and what state it is in.
2. **Help for "my TV isn't showing" sits inside the device picker.** Tubi has "Can't see your TV?" and a local-network explainer in the picker. Google TV puts the Wi-Fi rule right under the device list. Cast Bridge keeps that help in a separate FAQ list (`index.html` ~L905-920: Cast to TV / Open in VLC / other TVs), away from the moment it is needed.
3. **The TV-browser route is just another device, and quality/subtitles are picked before casting.** CastBrowser lists "Web Receiver" in the same "Cast to…" sheet as Chromecast, and picks the stream and quality from the "video found" badge. iWebTV sells "Subtitle Finder" as a named feature. Cast Bridge's TV browser is a separate segmented mode (`index.html` L312 "TV browser"), and subtitles (`lib/opensubs.js`) are not surfaced at the pick-a-stream step.
   - Not checked this pass: whether Cast Bridge restores a dropped Cast session the way Google's checklist requires. Worth testing before any build.

## The one fresh move

**The phone's picture becomes a status line for the TV, and every failure shows up there as a reason with a fix.**
While a film plays on a TV, the phone's player area dims to the poster and shows one large line:
`Living room TV · playing · 12:04 / 1:41:00`. It changes state in place: `connecting…`, `buffering`,
`paused`, `reconnecting (phone slept)`. When something breaks, the same line turns amber and shows the
reason already written to the cast log (the host's words, the HTTP status, direct or through the
bridge), plus one button with the next step: `Retry through bridge`, `Open in VLC`, `Send to TV browser`.
This builds on the earlier "cast dock": the dock is where the session lives, and this line is what
the session says. It is also the visible side of standing rule L004 ("every failure the person can see
must log its reason"). A player that only says "error | unknown" would be impossible.
In Trunk's terms there is one lit signal: green while playing, amber when blocked, nothing else coloured.

## Limits

- Cast Bridge itself was not re-screenshotted (the earlier pass only got past the password gate, and no credentials were used here either).
- The store carousels are small, and castbrowser.tv's step graphics were read as page text, not as images.
- refero-styles is in keyword mode.
- `!audit-strict cast bridge` in the request is a separate command. It was not run in this research-only pass.
