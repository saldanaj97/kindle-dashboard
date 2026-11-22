#!/bin/sh
# Kiosk mode: turn the Kindle into a dashboard-only display. Stops the Kindle
# interface (home screen, books, screensaver) and runs dashboard.sh in its
# place. Started at boot by upstart/kindle-dashboard.conf.
#
# On/off switch: /mnt/us/KINDLE_DASHBOARD_KIOSK (on the USB drive, so a
# computer can create or delete it). To get the normal Kindle back over SSH:
#   rm /mnt/us/KINDLE_DASHBOARD_KIOSK && reboot
#
# Fails open: the interface is only stopped once USB SSH is up and the switch
# has been read. If either fails, the normal Kindle (and Jobman) stay usable.
# It never switches USB mode while a computer has the storage mounted.

SWITCH=/mnt/us/KINDLE_DASHBOARD_KIOSK
DIR=${DASHBOARD_DIR:-/var/local/dashboard}
LOG="$DIR/kiosk.log"
USB_IP=${USB_IP:-192.168.15.244}
DROPBEAR=/mnt/us/jobman/bin/dropbearmulti

mkdir -p "$DIR"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

# A computer (not a wall charger) is on the USB cable.
host_connected() { grep -qx configured /sys/class/udc/*/state 2>/dev/null; }

userstore_mounted() { grep -q ' /mnt/us ' /proc/mounts && [ -d /mnt/us/jobman ]; }

# Wait (in 5 s steps, up to $1 seconds) for a condition command to succeed.
wait_for() {
  limit=$1; shift
  t=0
  while [ "$t" -lt "$limit" ]; do
    "$@" && return 0
    sleep 5
    t=$((t + 5))
  done
  return 1
}

log "boot: kiosk.sh started"

# 1. Never take the drive away from a computer. While a computer has the
#    Kindle's storage mounted as a drive, /mnt/us is not mounted here, and
#    switching USB to network mode then is an unclean removal: the storage is
#    left dirty and the Kindle refuses to mount it on the next boot
#    ("Critical device error E3"). So wait for /mnt/us to be mounted locally,
#    and if it never is, leave the Kindle and its USB mode alone.
if ! wait_for 120 userstore_mounted; then
  log "userstore not mounted here after 120 s (a computer may have it as a drive); leaving USB and the interface alone"
  exit 0
fi

# 2. USB SSH, the way Jobman's "Enable USB SSH" does it. Safe now: the
#    storage is mounted here, so no computer holds it.
lipc-set-prop -i -- com.lab126.volumd useUsbForNetwork 1 >/dev/null 2>&1
lipc-send-event -r 3 -d 2 com.lab126.hal usbUnconfigured >/dev/null 2>&1
lipc-send-event -r 3 -d 2 com.lab126.hal usbPlugOut >/dev/null 2>&1
sleep 3
ifconfig usb0 "$USB_IP" >/dev/null 2>&1
if ! pgrep -f "dropbearmulti dropbear" >/dev/null 2>&1 && [ -x "$DROPBEAR" ]; then
  # Same options as Jobman with password login off: key-only, USB only.
  nohup "$DROPBEAR" dropbear -R -H/mnt/us -p22 -lusb0 -s >/dev/null 2>&1 &
fi
sleep 2
usb_ok=0
ifconfig usb0 2>/dev/null | grep -q "inet addr:$USB_IP" && pgrep -f "dropbearmulti dropbear" >/dev/null 2>&1 && usb_ok=1
log "usb ssh: $([ "$usb_ok" = 1 ] && echo up || echo DOWN)"

# 3. The switch.
if [ ! -f "$SWITCH" ]; then
  log "switch $SWITCH missing; leaving the Kindle interface alone"
  exit 0
fi
# Only insist on SSH when a computer is attached at boot. On a wall charger
# there is nothing to reach it from; plugging a computer in later still gets
# USB network mode, since useUsbForNetwork stays set.
if [ "$usb_ok" != 1 ] && host_connected; then
  log "usb ssh is down with a computer attached; not stopping the interface, so the Kindle stays recoverable"
  exit 0
fi

# 4. Stop the interface. Stopping x also stops lab126_gui, which takes
#    framework, pillow, webreader and the rest with it. wifid, cmd, powerd,
#    volumd and dbus keep running, so Wi-Fi and USB SSH are unaffected.
/sbin/initctl stop lab126_gui >/dev/null 2>&1
/sbin/initctl stop x >/dev/null 2>&1
lipc-set-prop com.lab126.powerd preventScreenSaver 1 >/dev/null 2>&1
log "interface stopped"

# 5. Give Wi-Fi up to two minutes; dashboard.sh copes with a failed fetch anyway.
wait_for 120 sh -c '[ "$(lipc-get-prop com.lab126.wifid cmState 2>/dev/null)" = CONNECTED ]'
log "wifi: $(lipc-get-prop com.lab126.wifid cmState 2>/dev/null)"

exec /bin/sh "$DIR/dashboard.sh"
