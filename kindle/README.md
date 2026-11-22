**Partly tested on the device.** One full cycle works on the real Kindle against the deployed Worker behind Cloudflare Access. The background loop, sleep and Wi-Fi recovery are not tested yet.

# Kindle client

`dashboard.sh` is a POSIX `sh` script (busybox ash) for the jailbroken Kindle. Each cycle it:

1. Sends one `GET` to `$BASE_URL/screen/$SCREEN.png` with the Cloudflare Access service token headers.
2. Checks the response is a PNG (8-byte signature). If so, it replaces `last.png` atomically.
3. On success, runs `eips -c` (clear) then `eips -g last.png`. The clear is only for new images, to limit ghosting.
4. On failure, logs one line and leaves the last good image on screen. If there has never been a good image, it prints `dashboard: no image yet` with `eips` text mode.
5. Sleeps `REFRESH_SECONDS` (default 600).

It makes no other network calls and triggers nothing. The token is passed to curl through stdin, so it is not in the process list, and it is never logged.

## Install

Everything lives in `/var/local/dashboard`, on the Kindle's internal ext3 partition. It survives reboots, a computer can't see it over USB, and `chmod` works there. Don't use `/mnt/us`: that is the USB drive, where any computer the Kindle is plugged into can copy files and permissions do nothing. `dashboard.sh` refuses a config there, and the cached `last.png` shows whatever the screen shows, so it stays off the drive too.

Over SSH as root:

1. Copy `dashboard.sh` to `/var/local/dashboard/dashboard.sh`.
2. Write `/var/local/dashboard/dashboard.conf` from `dashboard.conf.example` with your host and the service token, then `chmod 600` it. To send the token from 1Password, run the `ssh … 'cat > …'` inside `op-sa run … -- sh -c '…'`: `op run` replaces secret values in its own output with `<concealed by 1Password>`, so piping them out of it delivers that placeholder.
3. If the Kindle is lost, revoke the service token in Zero Trust.

`dashboard.conf` is gitignored. Never commit it.

## Run

Once, to test:

```sh
sh dashboard.sh --once
```

In the background (untested):

```sh
nohup sh dashboard.sh >/dev/null 2>&1 &
```

A scriptlet that starts the script is the other option (KUAL is obsolete on current jailbreaks). Logs go to `$CACHE_DIR/dashboard.log`. Only one copy runs at a time; a second start exits with "already running". `--once` exits 1 when the fetch fails.

`DASHBOARD_CONF=/path/to/file` points at a different config file.

## Dry run on a Mac

```sh
DASHBOARD_CONF=./my-test.conf sh dashboard.sh --once --dry-run
```

The fetch still runs (so point `BASE_URL` at something safe); `eips` and `lipc-set-prop` are printed instead of run, with the secret masked. Set `CACHE_DIR` to a temp folder.

## Config

See `dashboard.conf.example`. Required: `BASE_URL` (must be `https://`), `SCREEN`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`. Optional: `REFRESH_SECONDS` (at least 60; default 600), `CACHE_DIR`, `CA_BUNDLE` (adds `curl --cacert`), `PREVENT_SCREENSAVER=1` (calls `lipc-set-prop com.lab126.powerd preventScreenSaver 1`; untested).

## Device results

Verified on the real Kindle (KT5, firmware 5.19.2.0.1, jailbroken):

- Framebuffer is 1072 x 1448, matching `SCREEN_SIZE` in the Worker.
- The Kindle's curl 7.86 (OpenSSL 1.0.2q) reaches Cloudflare over HTTPS with TLS 1.2 and verifies the certificate. `CA_BUNDLE` is not needed.
- `curl -K -` (config from stdin, which keeps the token out of the process list) works.
- busybox has `head -c` and `od`, so the PNG signature check works.
- `eips -g` shows the Worker's 8-bit grayscale PNG crisply.
- Installed in `/var/local/dashboard`, `sh dashboard.sh --once` fetches `kindle.juansaldana.dev/screen/trade-plans.png` through Access with the service token and displays it (exit 0). With no Wi-Fi it logs "Could not resolve host", shows "no image yet" and exits 1.
- `/var/local` is ext3 (`/dev/mmcblk0p9`), survives reboots, and `chmod 600` holds there. `/mnt/us` is a FUSE view of a vfat image; the script refuses a config under it.

## Still untested

- Screensaver and suspend: does the image survive, and does `PREVENT_SCREENSAVER` help? Power saving (RTC wake, suspend between fetches) is a follow-up; plain `sleep` keeps the device awake and drains the battery.
- Does Wi-Fi reconnect after sleep, and does a failed fetch while offline recover on the next cycle?
- The background loop (`nohup` or a scriptlet) over hours, including what the screen shows across refreshes.
