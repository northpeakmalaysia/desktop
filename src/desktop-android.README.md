# Android (Termux + Shizuku) support

The device agent runs on Termux. This file lists which tools work and
what prerequisites you need.

## Prerequisites

- **Termux** (latest, from F-Droid — not the Play Store version)
- **Termux:API** addon APK + `pkg install termux-api` — required for clipboard,
  notification, battery, volume, location, sensor, vibrate
- **Shizuku** (https://shizuku.rikka.app/) — required for screenshot, app launch,
  brightness, and arbitrary elevated commands via `shizuku_run`. Pair via wireless
  ADB (Android 11+) or root. `pkg install rish` for the CLI.

## Tool support matrix

| Tool                | Termux:API only | Needs Shizuku | Notes |
|---------------------|-----------------|---------------|-------|
| clipboard_read/write| yes             |               |       |
| screenshot          |                 | yes           | uses `screencap` via rish |
| notify (notification)| yes            |               |       |
| volume_set          | yes             |               | scale converted 0-100 -> 0-15 |
| brightness_set      |                 | yes           | `settings put system screen_brightness` |
| caffeinate          | yes             |               | wake-lock acquire/release |
| battery             | yes             |               | rich data: percent, status, health, temp |
| app_open            |                 | yes           | needs package name (no fuzzy lookup) |
| url_open            | yes             |               |       |
| window_*            | n/a             | n/a           | Android apps are OS-managed |
| system_info, disk_usage, network_interfaces | | | work as on Linux (node:os) |
| applescript, powershell, cmd_exe | n/a    | n/a           | not present on Android |
| shizuku_run         |                 | yes           | master-gated; runs as shell uid |
| termux_notification, termux_vibrate, termux_location | yes | (location only - permission) | |
| wifi_toggle         |                 | yes           | master-gated; `svc wifi enable/disable` — can sever ADB-over-WiFi |
| bluetooth_toggle    |                 | yes           | master-gated; `svc bluetooth enable/disable` |
| screen_lock         |                 | yes           | pair-gated; `input keyevent KEYCODE_POWER` — TOGGLES (locks if on, wakes if off) |
| call_phone          |                 | yes           | master-gated; `am start -a CALL` — DIALS IMMEDIATELY (no compose step) |
| send_sms            |                 | yes           | master-gated; opens SMS composer pre-filled, operator taps Send (no silent auto-send) |
| device_info         | yes             |               | pair-gated; `getprop` for manufacturer/model/Android version/build (shell-user accessible) |
| list_apps           | yes             |               | pair-gated; `pm list packages` works without Shizuku (regular shell user can list installed apps) |
| kill_app            |                 | yes           | master-gated; `am force-stop <pkg>` — needs system uid |
| youtube_search      | yes             |               | pair-gated; opens `https://www.youtube.com/results?search_query=...` via `termux-open-url` |
| whatsapp_send       | yes             |               | master-gated; opens `wa.me/<number>?text=...` via `termux-open-url`; user must tap Send in WhatsApp |

## OpenClaw / device-agent command parity

The five tools above (`device_info`, `list_apps`, `kill_app`, `youtube_search`, `whatsapp_send`)
close the gap with the original "main agent → device" command list. The full surface that the
main agent can drive on Android is now: clipboard, screenshot, notify, volume, brightness,
caffeinate, battery, app_open, url_open, system_info, shizuku_run, termux_notification,
termux_vibrate, termux_location, wifi_toggle, bluetooth_toggle, screen_lock, call_phone,
send_sms, device_info, list_apps, kill_app, youtube_search, whatsapp_send.
