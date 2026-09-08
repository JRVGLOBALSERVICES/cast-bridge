#!/usr/bin/env bash
# Keep the VPS half of cast-bridge on the same commit as the Vercel half.
#
# WHY THIS EXISTS: pushing to GitHub deploys Vercel automatically — that side
# has a webhook. The VPS has nothing. Every update it has ever received came
# from a human (or an agent) remembering to run `git pull`, which is why on
# 2026-09-07 it spent a whole day eight commits behind while Vercel served
# current code. Two halves of one app on different versions is a debugging
# trap: the symptom moves depending on which box answers.
#
# Runs every 5 minutes from root's crontab.
#
# Deliberate limits:
#   * fast-forward ONLY. Local commits or a dirty tree stop the update and
#     raise an alert rather than being clobbered — someone is mid-work there.
#   * a restart waits for `in_flight == 0`. Bouncing the process during a
#     cast stalls the television; the next tick is 5 minutes away and the
#     film is longer than that.
#   * npm ci runs only when package-lock.json actually moved.
set -uo pipefail

REPO=/opt/cast-stream
LOG=$REPO/data/self-update.log
LOCK=/tmp/cast-stream-self-update.lock
# Overridable so the guards below can be exercised against a stub rather than
# only in production, where "a cast is in flight" is not a state you can stage.
HEALTH=${CAST_HEALTH_URL:-http://127.0.0.1:7801/healthz}

mkdir -p "$(dirname "$LOG")"
log() { echo "[$(date -u +%FT%TZ)] $*" >> "$LOG"; }

notify() {
  [ "${CAST_UPDATE_NOTIFY:-on}" = off ] && return 0
  local env_file=/opt/whatsapp-bridge/.env
  [ -r "$env_file" ] || return 0
  local token jid
  token=$(grep -oP '^API_TOKEN=\K.*' "$env_file" | head -1)
  jid=$(grep -oP '^OWNER_JID=\K.*' "$env_file" | head -1)
  [ -n "$token" ] || return 0
  curl -s -m 20 -X POST "http://localhost:7777/api/wa/send" \
    -H "Authorization: Bearer ${token}" -H 'Content-Type: application/json' \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"jid":sys.argv[1],"message":sys.argv[2],"admin_override":True}))' \
          "${jid:-60138606455@s.whatsapp.net}" "$1")" >/dev/null || true
}

exec 9>"$LOCK"
flock -n 9 || exit 0

cd "$REPO" || exit 1

git fetch -q origin main 2>>"$LOG" || { log "fetch failed"; exit 0; }

BEHIND=$(git rev-list --count HEAD..origin/main)
AHEAD=$(git rev-list --count origin/main..HEAD)
[ "$BEHIND" -eq 0 ] && exit 0

# Never discard work that only exists here.
# --untracked-files=no is deliberate: a fast-forward cannot touch a file git
# is not tracking, so runtime artifacts must not count as "someone is working
# here". Counting them made the guard refuse every update forever.
if [ "$AHEAD" -ne 0 ] || [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  log "BLOCKED: behind $BEHIND but ahead $AHEAD / tree dirty — not touching it"
  notify "⚠️ cast-stream VPS is $BEHIND commit(s) behind but has local work (ahead $AHEAD, dirty tree). Auto-update refused — needs a human."
  exit 0
fi

# A restart mid-cast stalls the TV. Wait for the next tick instead.
INFLIGHT=$(curl -s -m 10 "$HEALTH" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("in_flight",0))' 2>/dev/null || echo 0)
if [ "${INFLIGHT:-0}" -gt 0 ]; then
  log "deferred: $BEHIND behind, $INFLIGHT stream(s) in flight"
  exit 0
fi

OLD=$(git rev-parse --short HEAD)
LOCK_BEFORE=$(git rev-parse HEAD:package-lock.json 2>/dev/null || echo none)

git pull -q --ff-only origin main 2>>"$LOG" || { log "pull failed"; notify "⚠️ cast-stream auto-update: git pull failed on the VPS."; exit 1; }

NEW=$(git rev-parse --short HEAD)
LOCK_AFTER=$(git rev-parse HEAD:package-lock.json 2>/dev/null || echo none)
[ "$LOCK_BEFORE" != "$LOCK_AFTER" ] && { log "deps changed — npm ci"; npm ci --omit=dev >>"$LOG" 2>&1 || { notify "⚠️ cast-stream auto-update: npm ci failed on the VPS ($NEW)."; exit 1; }; }

pm2 restart cast-stream --update-env >/dev/null 2>&1

# Prove it came back, rather than assume it. /healthz is the public probe;
# the commit lives behind an owner ticket, so the restart itself is evidenced
# by a fresh uptime rather than by asking the process what it is running.
sleep 4
HEALTH_OK=$(curl -s -m 10 "$HEALTH" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("ok" if d.get("ok") else "notok", int(d.get("uptime_s",999)))' 2>/dev/null || echo "down 999")
log "updated $OLD -> $NEW ($BEHIND commit(s)); health: $HEALTH_OK"
case "$HEALTH_OK" in
  "ok "[0-9]|"ok "[0-9][0-9]) notify "🔄 cast-stream VPS updated $OLD → $NEW ($BEHIND commit(s) behind Vercel). Back up, healthy." ;;
  *) notify "⚠️ cast-stream VPS updated $OLD → $NEW but the service did not come back clean: $HEALTH_OK" ;;
esac
