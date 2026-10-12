# Shan Shui Wall

A living landscape painting for your wall: an endless, slowly drifting Chinese
landscape scroll, generated live and never repeating. You control it from your
phone.

Built on [{Shan, Shui}\*](https://github.com/LingDong-/shan-shui-inf) by
Lingdong Huang (MIT). The original generator is used unchanged; this project
adds a display engine suited to always-on ambient use.

## Run it

```bash
npm start
```

- Painting: `http://localhost:8080/` (open full-screen on the wall display)
- Remote: `http://<this-machine's-IP>:8080/remote` (open on your phone; the
  painting shows this address in the corner for 20 s at startup)

There are no dependencies. Node 18 or later is enough.

## How it works

| File | Role |
| --- | --- |
| `public/engine.js` | The original generator, extracted from `upstream/index.html` by `scripts/extract-engine.mjs`. Don't edit it by hand. |
| `public/worker.js` | Generates the world in a Web Worker and paints it into 512-unit tiles on an `OffscreenCanvas`, from only the brush strokes that cross each tile. Each chunk is reseeded from `seed@x`, so the painting can resume from any position. |
| `public/painting.js` | Receives finished bitmaps (zero-copy), places them side by side in one strip, and drifts it with a GPU transform. The main thread does almost nothing per frame, which keeps it smooth on slow chips. Crossfades to a new landscape when the seed changes. |
| `public/remote.html` | Phone remote: play/pause, drift speed, brightness, new landscape, enter a seed, reload display. |
| `server.js` | Static server, `/api/*` endpoints, and live updates over Server-Sent Events. Saves state to `data/state.json`, so a reboot resumes the same landscape at the same spot. |

The painting also runs without the server, for example on static hosting or a
device that can only open a URL. It is then configured by URL parameters:
`index.html?seed=mountain&speed=6&brightness=0.8`.

Live (static, no remote): https://kingbowser501.github.io/shan-shui-wall/

| Parameter | Meaning |
| --- | --- |
| `seed` | Same seed, same landscape |
| `speed` | Drift in world units per second (default 6, about one screen every 3.5 minutes) |
| `brightness` | 0–1 |
| `res` | Render scale below 1 (e.g. `0.75`) for slow hardware |
| `test` | Shows a performance overlay: frame rate, tile generation and paint times, and whether the drift ever waited for tiles |

## Testing new hardware

Open `…/?test&seed=wall-test` on the device and leave it for 5 minutes. A
healthy result shows about 60 fps, few or no janky frames, and "waited for
tiles 0×". Tile generation time only needs to stay well under the budget line
(about 85 s per tile at the default speed).

## Android frame app

`android/` is a small app for Android art frames (built for a 27" RK3566
frame on Android 14). It makes the frame self-contained:

- **Boots into the painting**, full screen with the screen kept on. It reopens
  after a power cut or an app update, and recovers if the browser engine crashes.
- **Runs the wall server inside the frame** (a Kotlin port of `server.js`
  with the same API). Phones on the same Wi-Fi open
  `http://<frame-ip>:8080/remote`. The address shows on screen for 20 s at
  startup and in the admin menu.
- **Dims the real backlight** when you lower brightness on the remote, rather
  than darkening the picture.
- **Admin menu:** tap the top-left corner 5 times for the remote address,
  reload, Wi-Fi and Android settings, and exit.

Build (needs JDK 17 and the Android SDK):

```bash
cd android && ./gradlew assembleRelease
```

The APK is `android/app/build/outputs/apk/release/app-release.apk`. It's
signed with this machine's debug key, so later updates must be built here too
(or Android will refuse to install them over the old version).

Set up on the frame:

1. Install the APK (copy it over on a USB stick and open it, or use `adb install`).
2. Open **Shan Shui**. When it asks to start automatically, open the setting
   and switch on **Display over other apps**, then press Back.
3. Optionally, also point the frame's own "auto-launch app" setting at
   Shan Shui, or choose it as the home screen from the admin menu.
4. Leave it on for half an hour before the first power-cut test, because
   Android saves that permission to disk on a delay.



On a Pi 4 or 5 running Raspberry Pi OS (desktop):

```bash
git clone https://github.com/kingbowser501/shan-shui-wall.git ~/shan-shui-wall && cd ~/shan-shui-wall
```

Create `~/.config/systemd/user/shanshui.service`:

```ini
[Unit]
Description=Shan Shui wall server
[Service]
WorkingDirectory=%h/shan-shui-wall
ExecStart=/usr/bin/node server.js
Restart=always
[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now shanshui && sudo loginctl enable-linger $USER
```

Then autostart Chromium in kiosk mode (labwc: `~/.config/labwc/autostart`):

```bash
chromium --kiosk --noerrdialogs --disable-infobars --check-for-update-interval=31536000 http://localhost:8080/
```

## Updating the upstream engine

`public/engine.js` is checked in. To regenerate it from the original project:

```bash
git clone https://github.com/LingDong-/shan-shui-inf.git upstream
npm run extract-engine
```
