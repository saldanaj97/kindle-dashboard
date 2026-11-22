#!/bin/sh
# Kindle dashboard client. Fetches a screen PNG from the backend and shows it
# with eips. Display only: the only network call is one GET per cycle.
#
# Usage: sh dashboard.sh [--once] [--dry-run] [--check]
#   --once      fetch and display one time, then exit
#   --check     validate the config and exit (1 if invalid or already running)
#   --dry-run   print the eips/lipc commands instead of running them
#               (same as DRY_RUN=1). The fetch still runs.
# Env: DASHBOARD_CONF overrides the config path (default: dashboard.conf next
#      to this script). Install under /var/local/dashboard: /mnt/us is the
#      USB drive, and the script refuses a config there.

ONCE=0
CHECK=0
DRY_RUN=${DRY_RUN:-0}
for arg in "$@"; do
  case "$arg" in
    --once) ONCE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --check) CHECK=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
CONF=${DASHBOARD_CONF:-$SCRIPT_DIR/dashboard.conf}
if [ ! -f "$CONF" ]; then
  echo "dashboard: config not found: $CONF" >&2
  exit 1
fi
# /mnt/us is the drive a computer sees over USB, where permissions do nothing:
# a token there can be copied by anyone who plugs the Kindle in.
case "$(cd "$(dirname "$CONF")" && pwd)/" in
  /mnt/us/*|/mnt/base-us/*)
    echo "dashboard: refusing a config on the USB drive ($CONF); move it to /var/local/dashboard" >&2
    exit 1 ;;
esac
# shellcheck disable=SC1090
. "$CONF"

REFRESH_SECONDS=${REFRESH_SECONDS:-600}
CACHE_DIR=${CACHE_DIR:-/var/local/dashboard}
PREVENT_SCREENSAVER=${PREVENT_SCREENSAVER:-0}
CA_BUNDLE=${CA_BUNDLE:-}
SLEEP_MODE=${SLEEP_MODE:-awake}
case "$SLEEP_MODE" in
  awake|suspend) ;;
  *) echo "dashboard: SLEEP_MODE must be awake or suspend" >&2; exit 1 ;;
esac

missing=""
for v in BASE_URL SCREEN CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET; do
  eval "val=\${$v:-}"
  [ -n "$val" ] || missing="$missing $v"
done
if [ -n "$missing" ]; then
  echo "dashboard: missing required config:$missing" >&2
  exit 1
fi
case "$REFRESH_SECONDS" in
  ''|*[!0-9]*) echo "dashboard: REFRESH_SECONDS must be a whole number" >&2; exit 1 ;;
esac
if [ "$REFRESH_SECONDS" -lt 60 ]; then
  echo "dashboard: REFRESH_SECONDS must be at least 60" >&2
  exit 1
fi
# The service token travels in headers, so never send it over plain HTTP.
case "$BASE_URL" in
  https://*) ;;
  *) echo "dashboard: BASE_URL must start with https://" >&2; exit 1 ;;
esac

mkdir -p "$CACHE_DIR" || { echo "dashboard: cannot create $CACHE_DIR" >&2; exit 1; }
LAST="$CACHE_DIR/last.png"
TMP="$CACHE_DIR/fetch.tmp"
LOG="$CACHE_DIR/dashboard.log"
URL="${BASE_URL%/}/screen/$SCREEN.png"

# One copy at a time: two loops would race on fetch.tmp. The PID file lives in
# /tmp (cleared on reboot) and is ignored when its process is gone, so a crash
# or power loss never blocks the next start.
PIDFILE=/tmp/kindle-dashboard.pid
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
  echo "dashboard: already running (pid $(cat "$PIDFILE"))" >&2
  exit 1
fi
[ "$CHECK" = 1 ] && { echo "dashboard: config ok"; exit 0; }
echo $$ > "$PIDFILE"
# Wi-Fi back on whatever happens: an exit mid-suspend must not strand it off.
trap 'rm -f "$PIDFILE"; [ "$wifi_off" = 1 ] && lipc-set-prop com.lab126.cmd wirelessEnable 1 >/dev/null 2>&1' EXIT
trap 'exit 130' INT TERM
wifi_off=0

log() {
  line="$(date '+%Y-%m-%d %H:%M:%S') $*"
  echo "$line" >&2
  echo "$line" >> "$LOG" 2>/dev/null
  # Keep the log small: trim to the last 200 lines once it passes ~100 KB.
  if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 100000 ]; then
    tail -n 200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  fi
}

# Run a device command, or print it in dry-run mode.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}

is_png() {
  [ -s "$1" ] || return 1
  sig=$(head -c 8 "$1" | od -An -v -t x1 | tr -d ' \n')
  [ "$sig" = "89504e470d0a1a0a" ]
}

# Returns 0 when a new valid PNG replaced last.png.
fetch() {
  rm -f "$TMP"
  # Headers go in through a curl config on stdin, so the secret never appears
  # in the process list.
  # shellcheck disable=SC2086
  printf 'header = "CF-Access-Client-Id: %s"\nheader = "CF-Access-Client-Secret: %s"\n' \
    "$CF_ACCESS_CLIENT_ID" "$CF_ACCESS_CLIENT_SECRET" |
    curl -K - --silent --show-error --fail \
      --connect-timeout 15 --max-time 60 \
      ${CA_BUNDLE:+--cacert "$CA_BUNDLE"} \
      -o "$TMP" "$URL" 2>"$CACHE_DIR/curl.err"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    log "fetch failed (curl exit $rc): $(head -n 1 "$CACHE_DIR/curl.err" 2>/dev/null)"
    rm -f "$TMP"
    return 1
  fi
  if ! is_png "$TMP"; then
    log "fetch failed: response is not a PNG"
    rm -f "$TMP"
    return 1
  fi
  mv "$TMP" "$LAST"
}

show() {
  if [ -s "$LAST" ]; then
    run eips -g "$LAST" || log "display failed: eips -g exited $?"
  else
    run eips 0 0 "dashboard: no image yet" || log "display failed: eips exited $?"
  fi
}

# A computer (not a wall charger) is on the USB cable: the gadget has been
# enumerated by a host, whether it is active or suspended.
host_connected() { grep -qxE 'addressed|configured|suspended' /sys/class/udc/*/state 2>/dev/null; }

# Deep sleep between refreshes (SLEEP_MODE=suspend): Wi-Fi off, the RTC alarm
# armed, suspend to RAM, then Wi-Fi back on. E-ink keeps the image with no
# power. The kernel refuses to suspend while Wi-Fi is connected or the display
# is still updating (wake locks WLAN, hwtcon_wakelock), hence Wi-Fi off and a
# pause first. An early wake (power button, charger) suspends again for the
# rest of the interval. Returns 1 when it could not suspend at all, so the
# caller sleeps awake instead.
# sleep in the background and wait for it, so TERM (initctl stop) is handled
# at once instead of after the whole interval.
nap() { sleep "$1" & wait $!; }

RTC=/sys/class/rtc/rtc0
# Arms the RTC alarm $1 seconds from now and checks it took; 1 if it did not.
arm_alarm() {
  now=$(cat "$RTC/since_epoch" 2>/dev/null)
  case "$now" in ''|*[!0-9]*) return 1 ;; esac
  target=$((now + $1))
  echo 0 > "$RTC/wakealarm" 2>/dev/null
  echo "$target" > "$RTC/wakealarm" 2>/dev/null
  [ "$(cat "$RTC/wakealarm" 2>/dev/null)" = "$target" ]
}
suspend_for() {
  [ -w /sys/power/state ] && [ -w "$RTC/wakealarm" ] || return 1
  t0=$(date +%s)
  lipc-set-prop com.lab126.cmd wirelessEnable 0 >/dev/null 2>&1
  wifi_off=1
  sleep 5
  refused=0
  slept=0
  while :; do
    left=$(( $1 - ($(date +%s) - t0) ))
    # Close enough: the rest is shorter than a suspend round trip.
    [ "$left" -lt 15 ] && break
    # A computer was plugged in (it may have woken us): stay awake for SSH.
    host_connected && break
    if ! arm_alarm "$left"; then
      log "could not arm the RTC wake alarm; not suspending"
      break
    fi
    sync
    if echo mem > /sys/power/state 2>/dev/null; then
      slept=1
    else
      refused=$((refused + 1))
      [ "$refused" -ge 5 ] && break
      sleep 3
    fi
  done
  echo 0 > "$RTC/wakealarm" 2>/dev/null
  lipc-set-prop com.lab126.cmd wirelessEnable 1 >/dev/null 2>&1
  wifi_off=0
  if [ "$slept" -ne 1 ]; then
    [ "$refused" -ge 5 ] && log "suspend refused $refused times (wake lock held); sleeping awake this cycle"
    left=$(( $1 - ($(date +%s) - t0) ))
    [ "$left" -gt 0 ] && nap "$left"
    return 0
  fi
  # Wi-Fi took about 5 s to reconnect in testing; give it up to a minute.
  n=0
  while [ "$n" -lt 12 ] && [ "$(lipc-get-prop com.lab126.wifid cmState 2>/dev/null)" != CONNECTED ]; do
    sleep 5
    n=$((n + 1))
  done
  return 0
}

# Waits until the next refresh. Stays awake while a computer is attached, so
# SSH over USB keeps working: plug one in and the Kindle stops sleeping after
# its next wake-up.
wait_next() {
  if [ "$SLEEP_MODE" = suspend ] && [ "$DRY_RUN" != 1 ] && ! host_connected; then
    suspend_for "$REFRESH_SECONDS" && return 0
  fi
  nap "$REFRESH_SECONDS"
}

if [ "$DRY_RUN" = 1 ]; then
  echo "[dry-run] curl -K - --fail ... -H 'CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID' -H 'CF-Access-Client-Secret: ****' -o $TMP $URL"
fi

if [ "$PREVENT_SCREENSAVER" = 1 ] && { command -v lipc-set-prop >/dev/null 2>&1 || [ "$DRY_RUN" = 1 ]; }; then
  # Untested on device.
  run lipc-set-prop com.lab126.powerd preventScreenSaver 1
fi

while :; do
  if fetch; then
    ok=0
    # Full-screen clear first, only when there is a new image, to limit ghosting.
    # Skipped when the fetch failed so the last good image stays untouched.
    run eips -c
    show
    batt=$(lipc-get-prop com.lab126.powerd battLevel 2>/dev/null)
    log "ok: updated $LAST${batt:+ (battery $batt%)}"
  else
    ok=1
    # Keep the last good image. Only draw when nothing is on screen yet.
    [ -s "$LAST" ] || show
  fi
  # --once exits with the fetch result, so callers can tell a failed fetch.
  [ "$ONCE" = 1 ] && exit "$ok"
  wait_next
done
