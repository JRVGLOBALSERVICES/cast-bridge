# FAILURES.md

Things that went wrong in this repo, written by Friday (reflection loop +
Rj corrections). Every Friday spawn reads this BEFORE planning. Newest last.
Format: date · source · what went wrong · how to catch it next time.

## 2026-09-16 — ?
- **source:** reflection · task `20260916-task`
- **what went wrong:** the back picture failed to send to WhatsApp twice ("bridge unreachable"), so it went as a link
- **detect next time:** read "colour only" as one flat colour and check with him if unsure
- **do instead:** when Rj says "background colour only", make the flat-colour version first instead of keeping the glow

## 2026-09-16 — 📋 Plan — starting now: 1. Search the literal phrase and pull current references
- **source:** reflection · task `20260916-plan-starting-now-1-search`
- **what went wrong:** the plan was sent again after the work had been committed; I caught it with git log before redoing anything
- **detect next time:** the task folder already exists and HEAD's commit message matches the task slug
- **do instead:** check git log and tasks.md before starting a plan that has come back in
