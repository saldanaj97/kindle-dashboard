**Partly tested on the device.** The fetch and display steps work on the real Kindle; the full loop against a deployed Worker, sleep and Wi-Fi recovery are not tested yet.

# Kindle client

`dashboard.sh` is a POSIX `sh` script (busybox ash) for the jailbroken Kindle. Each cycle it:

1. Sends one `GET` to `$BASE_URL/screen/$SCREEN.png` with the Cloudflare Access service token headers.
2. Checks the response is a PNG (8-byte signature). If so, it replaces `last.png` atomically.
3. On success, runs `eips -c` (clear) then `eips -g last.png`. The clear is only for new images, to limit ghosting.
4. On failure, logs one line and leaves the last good image on screen. If there has never been a good image, it prints `dashboard: no image yet` with `eips` text mode.
5. Sleeps `REFRESH_SECONDS` (default 600).

It makes no other network calls and triggers nothing. The token is passed to curl through stdin, so it is not in the process list, and it is never logged.

## Install (untested)

1. Connect the Kindle over USB and copy this folder to `/mnt/us/dashboard`.
2. `cp dashboard.conf.example dashboard.conf`
3. Put the service token and your host in `dashboard.conf`.
4. `chmod 600 dashboard.conf`

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

A KUAL menu entry that starts the script is the other option. Logs go to `$CACHE_DIR/dashboard.log`.

`DASHBOARD_CONF=/path/to/file` points at a different config file.

## Dry run on a Mac

```sh
DASHBOARD_CONF=./my-test.conf sh dashboard.sh --once --dry-run
```

The fetch still runs (so point `BASE_URL` at something safe); `eips` and `lipc-set-prop` are printed instead of run, with the secret masked. Set `CACHE_DIR` to a temp folder.

## Config

See `dashboard.conf.example`. Required: `BASE_URL`, `SCREEN`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`. Optional: `REFRESH_SECONDS`, `CACHE_DIR`, `CA_BUNDLE` (adds `curl --cacert`), `PREVENT_SCREENSAVER=1` (calls `lipc-set-prop com.lab126.powerd preventScreenSaver 1`; untested).

## Device results

Verified on the real Kindle (KT5, firmware 5.19.2.0.1, jailbroken):

- Framebuffer is 1072 x 1448, matching `SCREEN_SIZE` in the Worker.
- The Kindle's curl 7.86 (OpenSSL 1.0.2q) reaches Cloudflare over HTTPS with TLS 1.2 and verifies the certificate. `CA_BUNDLE` is not needed.
- `curl -K -` (config from stdin, which keeps the token out of the process list) works.
- busybox has `head -c` and `od`, so the PNG signature check works.
- `eips -g` shows the Worker's 8-bit grayscale PNG crisply.

## Still untested

- Screensaver and suspend: does the image survive, and does `PREVENT_SCREENSAVER` help? Power saving (RTC wake, suspend between fetches) is a follow-up; plain `sleep` keeps the device awake and drains the battery.
- Does Wi-Fi reconnect after sleep, and does a failed fetch while offline recover on the next cycle?
- The full loop against a deployed Worker behind Cloudflare Access (background run, KUAL entry).
