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

# Overridable so the whole script can be driven against a throwaway clone in
# a test, rather than only against the one checkout it protects.
REPO=${CAST_REPO:-/opt/cast-stream}
LOG=$REPO/data/self-update.log
BEAT=$REPO/data/self-update-heartbeat.json
LOCK=/tmp/cast-stream-self-update.lock
# Overridable so the guards below can be exercised against a stub rather than
# only in production, where "a cast is in flight" is not a state you can stage.
HEALTH=${CAST_HEALTH_URL:-http://127.0.0.1:7801/healthz}

mkdir -p "$(dirname "$LOG")"
log() { echo "[$(date -u +%FT%TZ)] $*" >> "$LOG"; }

# A tick with nothing to do writes nothing to the log, on purpose: 288
# identical lines a day is a file nobody reads. But that makes "ran, nothing
# to do" and "has not run since Tuesday" the same observation — and not
# noticing the box had stopped moving is the exact failure this script was
# written for. So every tick stamps its own liveness here whatever it
# decided, and /healthz reports the age. Silence stays cheap; death stops
# being invisible.
beat() {
  printf '{"ts":"%s","state":"%s","head":"%s","behind":%s,"ahead":%s}\n' \
    "$(date -u +%FT%TZ)" "$1" \
    "$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)" \
    "${2:-0}" "${3:-0}" > "$BEAT.tmp" 2>/dev/null && mv "$BEAT.tmp" "$BEAT"
}

# notify <text> [kind] [cooldown_s]
#
# Two bugs lived in the first version of this and both were invisible:
#
#  1. it posted {"message": ...}. bridgeSend() reads `text` and rejects
#     anything else with a 400 — so every alert this script has ever raised
#     was refused, and `curl ... >/dev/null || true` reported that as fine.
#     Proven by hand against the live endpoint before this was changed.
#  2. the BLOCKED branch calls this every tick. Left alone, one dirty tree
#     would have put 288 identical messages a day in the owner's chat, which
#     is how an alert channel gets muted and stops working for real faults.
#
# So: correct field, resolved JID, response logged rather than discarded,
# and a per-kind cooldown for the states that persist. Calls with no kind
# (an update actually landed) are one-off events and always send.
notify() {
  [ "${CAST_UPDATE_NOTIFY:-on}" = off ] && return 0
  local text="$1" kind="${2:-}" cooldown="${3:-21600}"
  local env_file=${CAST_WA_ENV:-/opt/whatsapp-bridge/.env}
  local api=${CAST_WA_API:-http://localhost:7777}
  [ -r "$env_file" ] || { log "alert_undelivered reason=no_env_file"; return 0; }

  if [ -n "$kind" ]; then
    local marker="$REPO/data/.notified-$kind"
    if [ -f "$marker" ]; then
      local age=$(( $(date +%s) - $(stat -c %Y "$marker" 2>/dev/null || echo 0) ))
      [ "$age" -lt "$cooldown" ] && { log "alert_throttled kind=$kind age=${age}s"; return 0; }
    fi
    touch "$marker"
  fi

  local token jid raw
  token=$(grep -oP '^API_TOKEN=\K.*' "$env_file" | head -1)
  # BOSS_JIDS (first entry) -> OWNER_JID -> OWNER_NUMBER. Never a literal:
  # the old fallback hardcoded a phone number into a script in a public repo.
  raw=$(grep -oP '^BOSS_JIDS=\K.*' "$env_file" | head -1)
  [ -n "$raw" ] || raw=$(grep -oP '^OWNER_JID=\K.*' "$env_file" | head -1)
  raw=${raw%%,*}; raw=$(printf '%s' "$raw" | tr -d '[:space:]')
  case "$raw" in
    *@*) jid="$raw" ;;
    *)   jid="$(grep -oP '^OWNER_NUMBER=\K.*' "$env_file" | head -1 | tr -cd '0-9')@s.whatsapp.net" ;;
  esac
  [ -n "$token" ] || { log "alert_undelivered reason=no_api_token"; return 0; }
  case "$jid" in @*) log "alert_undelivered reason=no_boss_jid_in_env"; return 0 ;; esac

  local resp
  resp=$(curl -s -m 20 -X POST "$api/api/wa/send" \
    -H "Authorization: Bearer ${token}" -H 'Content-Type: application/json' \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"jid":sys.argv[1],"text":sys.argv[2],"admin_override":True}))' \
          "$jid" "$text")" 2>&1)
  log "alert_sent kind=${kind:-event} jid=${jid%%@*} resp=$(printf '%s' "$resp" | head -c 160 | tr -d '\n')"
}

# A fault marker outlives the fault it describes, so clear them the moment
# the box is demonstrably healthy again. Otherwise a block that is fixed in
# ten minutes silences the NEXT block for six hours.
clear_markers() { rm -f "$REPO"/data/.notified-* 2>/dev/null || true; }

exec 9>"$LOCK"
flock -n 9 || exit 0

cd "$REPO" || exit 1

git fetch -q origin main 2>>"$LOG" || { log "fetch failed"; beat fetch_failed; exit 0; }

BEHIND=$(git rev-list --count HEAD..origin/main)
AHEAD=$(git rev-list --count origin/main..HEAD)
[ "$BEHIND" -eq 0 ] && { clear_markers; beat up_to_date 0 "$AHEAD"; exit 0; }

# Never discard work that only exists here.
# --untracked-files=no is deliberate: a fast-forward cannot touch a file git
# is not tracking, so runtime artifacts must not count as "someone is working
# here". Counting them made the guard refuse every update forever.
if [ "$AHEAD" -ne 0 ] || [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  log "BLOCKED: behind $BEHIND but ahead $AHEAD / tree dirty — not touching it"
  beat blocked "$BEHIND" "$AHEAD"
  notify "⚠️ cast-stream VPS is $BEHIND commit(s) behind but has local work (ahead $AHEAD, dirty tree). Auto-update refused — needs a human." blocked
  exit 0
fi

# A restart mid-cast stalls the TV. Wait for the next tick instead.
INFLIGHT=$(curl -s -m 10 "$HEALTH" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("in_flight",0))' 2>/dev/null || echo 0)
if [ "${INFLIGHT:-0}" -gt 0 ]; then
  log "deferred: $BEHIND behind, $INFLIGHT stream(s) in flight"
  beat deferred "$BEHIND" "$AHEAD"
  exit 0
fi

OLD=$(git rev-parse --short HEAD)
LOCK_BEFORE=$(git rev-parse HEAD:package-lock.json 2>/dev/null || echo none)

git pull -q --ff-only origin main 2>>"$LOG" || { log "pull failed"; beat pull_failed "$BEHIND"; notify "⚠️ cast-stream auto-update: git pull failed on the VPS." pull_failed; exit 1; }

NEW=$(git rev-parse --short HEAD)
LOCK_AFTER=$(git rev-parse HEAD:package-lock.json 2>/dev/null || echo none)
[ "$LOCK_BEFORE" != "$LOCK_AFTER" ] && { log "deps changed — npm ci"; npm ci --omit=dev >>"$LOG" 2>&1 || { notify "⚠️ cast-stream auto-update: npm ci failed on the VPS ($NEW)."; exit 1; }; }

pm2 restart cast-stream --update-env >/dev/null 2>&1

# Prove it came back, rather than assume it. /healthz is the public probe;
# the commit lives behind an owner ticket, so the restart itself is evidenced
# by a fresh uptime rather than by asking the process what it is running.
sleep 4
HEALTH_OK=$(curl -s -m 10 "$HEALTH" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("ok" if d.get("ok") else "notok", int(d.get("uptime_s",999)))' 2>/dev/null || echo "down 999")
clear_markers
log "updated $OLD -> $NEW ($BEHIND commit(s)); health: $HEALTH_OK"
beat updated
case "$HEALTH_OK" in
  "ok "[0-9]|"ok "[0-9][0-9]) notify "🔄 cast-stream VPS updated $OLD → $NEW ($BEHIND commit(s) behind Vercel). Back up, healthy." ;;
  *) notify "⚠️ cast-stream VPS updated $OLD → $NEW but the service did not come back clean: $HEALTH_OK" ;;
esac
