#!/bin/sh
# Kindle dashboard client. Fetches a screen PNG from the backend and shows it
# with eips. Display only: the only network call is one GET per cycle.
#
# Usage: sh dashboard.sh [--once] [--dry-run]
#   --once      fetch and display one time, then exit
#   --dry-run   print the eips/lipc commands instead of running them
#               (same as DRY_RUN=1). The fetch still runs.
# Env: DASHBOARD_CONF overrides the config path (default: dashboard.conf next
#      to this script).

ONCE=0
DRY_RUN=${DRY_RUN:-0}
for arg in "$@"; do
  case "$arg" in
    --once) ONCE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
CONF=${DASHBOARD_CONF:-$SCRIPT_DIR/dashboard.conf}
if [ ! -f "$CONF" ]; then
  echo "dashboard: config not found: $CONF" >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$CONF"

REFRESH_SECONDS=${REFRESH_SECONDS:-600}
CACHE_DIR=${CACHE_DIR:-/mnt/us/dashboard}
PREVENT_SCREENSAVER=${PREVENT_SCREENSAVER:-0}
CA_BUNDLE=${CA_BUNDLE:-}

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

mkdir -p "$CACHE_DIR" || { echo "dashboard: cannot create $CACHE_DIR" >&2; exit 1; }
LAST="$CACHE_DIR/last.png"
TMP="$CACHE_DIR/fetch.tmp"
LOG="$CACHE_DIR/dashboard.log"
URL="${BASE_URL%/}/screen/$SCREEN.png"

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
    run eips -g "$LAST"
  else
    run eips 0 0 "dashboard: no image yet"
  fi
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
    # Full-screen clear first, only when there is a new image, to limit ghosting.
    # Skipped when the fetch failed so the last good image stays untouched.
    run eips -c
    log "ok: updated $LAST"
    show
  else
    # Keep the last good image. Only draw when nothing is on screen yet.
    [ -s "$LAST" ] || show
  fi
  [ "$ONCE" = 1 ] && break
  sleep "$REFRESH_SECONDS"
done
