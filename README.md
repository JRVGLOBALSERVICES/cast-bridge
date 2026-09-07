# Cast Bridge

Paste a direct video link (.mp4 / .webm / .m3u8), play it in the browser, and send it to the TV.

- **Cast to TV** — Google Cast (Chromecast / Google TV on the same Wi‑Fi). Best in Chrome on Android.
- **AirPlay / Cast** — Remote Playback API where the browser supports it (Safari/iOS AirPlay).
- **Open in VLC** — hands the link to the VLC app on the phone (Android intent / iOS x-callback).
- `?u=<encoded-url>` — deep-link a video straight into the player.

Only works with direct media URLs. Webpage links won't play.

Static site, no build step. Deployed on Vercel.
