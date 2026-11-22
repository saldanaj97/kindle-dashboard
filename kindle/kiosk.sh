#!/bin/sh
# Kiosk mode: turn the Kindle into a dashboard-only display. Stops the Kindle
# interface (home screen, books, screensaver) and runs dashboard.sh in its
# place. Started at boot by upstart/kindle-dashboard.conf.
#
# On/off switch: /mnt/us/KINDLE_DASHBOARD_KIOSK. Without it this script
# changes nothing, not even the USB mode. To get the normal Kindle back over
# SSH:
#   rm /mnt/us/KINDLE_DASHBOARD_KIOSK && reboot
#
# Fails open: the interface is only stopped once the dashboard can run and,
# with a computer attached, USB SSH is up. If the dashboard loop ever exits,
# the interface is started again. It never switches USB mode while a computer
# has the storage mounted.

SWITCH=/mnt/us/KINDLE_DASHBOARD_KIOSK
DIR=${DASHBOARD_DIR:-/var/local/dashboard}
LOG="$DIR/kiosk.log"
USB_IP=${USB_IP:-192.168.15.244}
DROPBEAR=/mnt/us/jobman/bin/dropbearmulti

mkdir -p "$DIR"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

# A computer (not a wall charger) is on the USB cable: the gadget has been
# enumerated by a host, whether it is active or suspended.
host_connected() { grep -qxE 'addressed|configured|suspended' /sys/class/udc/*/state 2>/dev/null; }

userstore_mounted() { grep -q ' /mnt/us ' /proc/mounts && [ -d /mnt/us/jobman ]; }

dropbear_running() { pgrep -f "dropbearmulti dropbear" >/dev/null 2>&1; }

start_interface() {
  /sbin/initctl start x >/dev/null 2>&1
  /sbin/initctl start lab126_gui >/dev/null 2>&1
}

log "boot: kiosk.sh started"

# 1. Never take the drive away from a computer. While a computer has the
#    Kindle's storage mounted as a drive, /mnt/us is not mounted here, and
#    switching USB to network mode then is an unclean removal: the storage is
#    left dirty and the Kindle refuses to mount it on the next boot
#    ("Critical device error E3"). So wait, however long it takes, for /mnt/us
#    to be mounted locally: the kiosk starts once the computer ejects the
#    drive or the cable is unplugged. Until then the normal Kindle stays.
if ! userstore_mounted; then
  log "waiting for /mnt/us (a computer may have it as a drive); the kiosk starts once it is ejected or unplugged"
  until userstore_mounted; do sleep 5; done
  log "userstore mounted"
fi

# 2. The switch, before touching anything: with it off, the Kindle (and its
#    USB drive mode) is left exactly as it was.
if [ ! -f "$SWITCH" ]; then
  log "switch $SWITCH missing; leaving the Kindle alone"
  exit 0
fi

# 3. The dashboard must be able to run before the interface goes away.
if [ ! -f "$DIR/dashboard.sh" ] || ! /bin/sh "$DIR/dashboard.sh" --check >> "$LOG" 2>&1; then
  log "dashboard.sh or its config is missing or invalid; leaving the Kindle alone"
  exit 0
fi

# 4. USB SSH, the way Jobman's "Enable USB SSH" does it. Safe now: the
#    storage is mounted here, so no computer holds it. dropbear runs in its
#    own session so it outlives this job if upstart stops it.
lipc-set-prop -i -- com.lab126.volumd useUsbForNetwork 1 >/dev/null 2>&1
lipc-send-event -r 3 -d 2 com.lab126.hal usbUnconfigured >/dev/null 2>&1
lipc-send-event -r 3 -d 2 com.lab126.hal usbPlugOut >/dev/null 2>&1
sleep 3
ifconfig usb0 "$USB_IP" >/dev/null 2>&1
if ! dropbear_running && [ -x "$DROPBEAR" ]; then
  # Same options as Jobman with password login off: key-only, USB only.
  setsid nohup "$DROPBEAR" dropbear -R -H/mnt/us -p22 -lusb0 -s >/dev/null 2>&1 < /dev/null &
fi
sleep 2
usb_ok=0
ifconfig usb0 2>/dev/null | grep -q "inet addr:$USB_IP" && dropbear_running && usb_ok=1
log "usb ssh: $([ "$usb_ok" = 1 ] && echo up || echo DOWN)"

# Only insist on SSH when a computer is attached at boot. On a wall charger
# there is nothing to reach it from; usb0 keeps its address and dropbear keeps
# listening, so plugging a computer in later reaches SSH (verified on the
# device).
if [ "$usb_ok" != 1 ] && host_connected; then
  log "usb ssh is down with a computer attached; not stopping the interface, so the Kindle stays recoverable"
  exit 0
fi

# 5. Stop the interface. Stopping x also stops lab126_gui, which takes
#    framework, pillow, webreader and the rest with it. wifid, cmd, powerd,
#    volumd and dbus keep running, so Wi-Fi and USB SSH are unaffected.
/sbin/initctl stop lab126_gui >/dev/null 2>&1
/sbin/initctl stop x >/dev/null 2>&1
lipc-set-prop com.lab126.powerd preventScreenSaver 1 >/dev/null 2>&1
log "interface stopped"

# 6. Give Wi-Fi up to two minutes; dashboard.sh copes with a failed fetch anyway.
t=0
while [ "$t" -lt 120 ] && [ "$(lipc-get-prop com.lab126.wifid cmState 2>/dev/null)" != CONNECTED ]; do
  sleep 5
  t=$((t + 5))
done
log "wifi: $(lipc-get-prop com.lab126.wifid cmState 2>/dev/null)"

# 7. Run the dashboard. It only returns on an error; then bring the Kindle
#    interface back rather than leave a frozen screen. Exit 0 so upstart does
#    not respawn into the same failure.
/bin/sh "$DIR/dashboard.sh"
log "dashboard.sh exited ($?); starting the Kindle interface again"
lipc-set-prop com.lab126.powerd preventScreenSaver 0 >/dev/null 2>&1
start_interface
exit 0
