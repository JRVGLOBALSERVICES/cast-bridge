# Cast Bridge — revamp audit (16 Sep 2026)

Signed-in audit. The session was minted with `lib/auth.issue()` for the `friday` admin account and injected as the
`cb_session` cookie, so every screen was seen the way a signed-in person sees it (not the sign-in door).
Local dev server `scripts/dev.js` on :5192, real Supabase data.

Evidence: `audit-evidence/20260916-plan-starting-now-1-search/` (13 pages × 375/768/1440/1920, report.json,
plus `castlogs-everyone-open-375.png`).

Checker result: **50/52 pass**. The 2 fails are `tv.html` at 375 and 768, where the "Cast Bridge · TV mode" eyebrow is clipped.
The 8 false alarms from the earlier audit (buttons inside the fixed bottom nav) are gone: the checker now skips
anything inside a `position: fixed` parent, and it takes `--cookie` for signed-in runs.

A green checker only means nothing overflows or overlaps. What's below is what it can't see.

Consulted: RJ-Design-Skill §forms, §tables, §errors, §destructive-actions, §notifications, §focus-a11y.

## What looks wrong (from the screenshots)

### Paste a link (Cast tab), 375
1. The field is a pressed-in neumorphic well, the same grey as the page. It has no border or label, and the only
   text is the placeholder, so it doesn't look like somewhere to type.
2. The field has no **Paste** button, and no clear (×) once a link is in. On a phone, a long press on an empty grey well is the only way in.
3. **Play** takes up 1/3 of the row and is the loudest thing on the screen, even while the field is empty. Nothing
   stops it from being tapped with no link.
4. "Choose a video on this phone" is as big as the main action, which makes two competing primaries.
5. **Record this screen** sits partly under the bottom nav at scroll-top.

### History, 375
6. Rows show `tvtest`, `flower` and `HD`: the raw page title or filename, with no site name, cover or length.
   You can't tell two films apart.
7. The rows have no progress. Continue watching doesn't show how far you got, even though the resume positions are stored.
8. Each row has five actions (☆, Play, ×, Open link, Copy). The small × deletes and sits next to Play.
9. There's no grouping by day (Today / Yesterday / Earlier) and no filter by site. Search and Starred are the only tools.
10. The **Danger zone** (Clear all history) is inside the list page, 1 scroll from everyday use.
11. The nav badge ("3") counts history rows. A count on History reads as unread alerts, which it isn't.

### Cast logs, 375
12. The logs use plain browser checkboxes. They're the only unstyled controls in the app.
13. An opened log is one dark monospace block. The signed video address (hundreds of characters of token) comes first and
    pushes the real events below the fold. There are no timestamps down the side, no colour for problems, and no way to
    jump to the first error.
14. The title "HD" is the stream's quality label saved as the film name, so the log list is mostly rows called "HD".
15. The empty state ("Nothing logged yet…") doesn't offer a next step.

### Library / Stream host
16. Library shows **Try again** above a raw `Failed to fetch`. The button comes before the reason, and the reason is
    browser wording, not the app's. This is still open from the last audit.
17. Stream host is unreachable from this box and shows a sentence and a text link, with no state, last-seen time or
    next step.

### Whole app
18. Every tab repeats the "Cast Bridge / Find a video. Put it on the TV." header, which costs about 70px on each screen.
19. The "No TV found" pill looks like a button. What a tap does with no TV around wasn't tested.
20. The neumorphic surfaces (the same grey for page, cards and inputs) give no contrast between what you can type in,
    what you can tap and what's just a label. This is the root cause behind 1, 3, 8 and 12.

## Missing features and flows

| # | Missing | Why it matters |
|---|---|---|
| F1 | **Paste from clipboard** button (`navigator.clipboard.readText`, 0 uses today) | The app's main job is pasting a link, and on a phone that should take one tap |
| F2 | **Now casting dock**: "Living room TV · playing · 12:04 / 1:41:00" on every tab | You leave the player and lose sight of the TV (research gap 1) |
| F3 | **Failure line with the reason and one fix** (Retry through bridge / Open in VLC / Send to TV browser) | Errors are logged (L004) but not acted on in the UI |
| F4 | **TV picker with inline help** ("Can't see your TV?") | Help is buried under More (research gap 2) |
| F5 | **Quality + subtitles chosen before casting** | They're picked after the film starts today (research gap 3) |
| F6 | **Up next / queue** for series episodes | Episodes are read but there's no queue |
| F7 | **History day groups, progress bars, site favicon/cover, swipe or menu for delete** | Items 6–10 |
| F8 | **Log timeline**: time column, colour by level, address collapsed to host, "jump to first problem", share | Items 13–14 |
| F9 | **Undo toast for single-row delete** (only clear-all has undo) | §destructive-actions |
| F10 | **Duplicate collapse in History** (3 × `tvtest` just now) | Same link played twice makes two rows |
| F11 | **Share target**: the manifest declares one, but nothing confirms it lands in the paste field | Share-from-Chrome flow unverified |

## Not checked
- Real casting to a TV (no TV reachable from the VPS).
- Library/Stream host with a live stream host (unreachable from here; it answers on production).
- iOS Safari (headless Chrome only).
