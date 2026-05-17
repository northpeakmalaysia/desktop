# @swarmai/desktop

> **SwarmAI plugin** — Cross-platform desktop control toolkit. 27+ tools for clipboard, screenshot, window management, app launch, system info, battery, volume, brightness, caffeinate, and Android (Termux + Shizuku) bridges.

Maintained by [NorthPeak Malaysia](https://github.com/northpeakmalaysia). Published to the [SwarmAI Hub](https://hub.northpeak.app) as an `official`-tier package. Carved out of the monorepo's `packages/tools/src/builtin/desktop-*.ts` per doc 15 §4 so operators can install / update desktop tools independently of the host runtime.

## What this is

A drop-in plugin that bridges installed platform CLIs (`pbcopy`, `xclip`, `osascript`, `powershell.exe`, `screencapture`, `wmctrl`, `notify-send`, `termux-*`, `rish`, …) to SwarmAI agents as policy-gated tools. Argv-only subprocess execution (never `shell: true`), per-platform fallbacks with actionable install hints, and Android-aware (Termux + Shizuku) so the same plugin works on a phone the way it works on a laptop.

## Install

From the SwarmAI Hub super-admin UI: **Plugins → Install `@swarmai/desktop`**. Or programmatically:

```http
POST /admin/hub/plugins/install
{ "id": "@swarmai/desktop" }
```

Drop the folder under `$SWARMAI_PLUGINS_DIR` (e.g. `F:\Published\Pluggins\swarmai-desktop\`) and the loader auto-discovers it via `package.json#name`.

## Tool list

Grouped by category. Policy column shows the registry gate the host applies on dispatch.

### Clipboard

| Tool | Policy | What it does |
| --- | --- | --- |
| `clipboard_read` | pair-gated | Read OS clipboard text |
| `clipboard_write` | pair-gated | Write text to OS clipboard |

### Notification

| Tool | Policy | What it does |
| --- | --- | --- |
| `notify` | pair-gated | Show OS notification (title + body, optional sound) |

### Capture

| Tool | Policy | What it does |
| --- | --- | --- |
| `screenshot` | pair-gated | Capture full screen / window / region as PNG (default: full virtual desktop) |

### App / URL

| Tool | Policy | What it does |
| --- | --- | --- |
| `app_open` | pair-gated | Launch installed application by name (package id on Android) |
| `url_open` | pair-gated | Open URL in default browser (optional browser hint on macOS) |

### Power / AV

| Tool | Policy | What it does |
| --- | --- | --- |
| `volume_set` | pair-gated | Set system audio volume (0-100) |
| `brightness_set` | pair-gated | Set primary display brightness (0-100) |
| `caffeinate` | pair-gated | Prevent sleep for N seconds; release with `{ release: true, token }` |

### Process

| Tool | Policy | What it does |
| --- | --- | --- |
| `process_list` | pair-gated | List running processes (filters: name, user, topByCpu, topByMem) |
| `process_info` | pair-gated | Get detailed info for a single PID |
| `process_kill` | master | Kill process by pid or name (refuses PID 1 + self-PID) |

### Shell

| Tool | Policy | What it does |
| --- | --- | --- |
| `powershell` | master | Run a PowerShell script (powershell.exe / pwsh) |
| `cmd_exe` | master | Run a Windows cmd.exe command |
| `applescript` | master | Run an AppleScript via osascript (macOS) |

### System info (read-only)

| Tool | Policy | What it does |
| --- | --- | --- |
| `system_info` | open | OS, arch, hostname, uptime, CPU count, mem, current user |
| `disk_usage` | open | Disk free/total per path |
| `network_interfaces` | pair-gated | List network interfaces with IP/MAC (mildly sensitive) |
| `battery` | open | Battery state (percent, plugged-in, health on Android) |

### Window management

| Tool | Policy | What it does |
| --- | --- | --- |
| `window_list` | pair-gated | List visible windows (filters: app, title) |
| `window_focus` | pair-gated | Bring window to front (by id or app+title) |
| `window_close` | master | Close window (closing wrong one can lose unsaved work) |
| `window_move` | pair-gated | Move/resize window |

### Android (registered only when running on Android)

| Tool | Policy | What it does |
| --- | --- | --- |
| `shizuku_run` | master | Run arbitrary shell command as Shizuku `shell` uid |
| `termux_notification` | pair-gated | Post Android notification (priority, replace-by-id) |
| `termux_vibrate` | pair-gated | Vibrate device for N ms |
| `termux_location` | master | Get device GPS location |
| `wifi_toggle` | master | Enable/disable WiFi radio (can sever ADB-over-WiFi) |
| `bluetooth_toggle` | master | Enable/disable Bluetooth radio |
| `screen_lock` | pair-gated | Press power button (TOGGLE — locks if on, wakes if off) |
| `call_phone` | master | Dial phone number IMMEDIATELY (no compose step) |
| `send_sms` | master | Open SMS composer pre-filled (operator taps Send) |

## Platform support

`✓` = works out of the box. `dep` = needs a platform CLI installed (see hints). `Shizuku` = needs Shizuku APK + `rish`. `Termux:API` = needs `pkg install termux-api` + Termux:API APK. `n/a` = not applicable.

| Tool | darwin | linux | win32 | android |
| --- | --- | --- | --- | --- |
| clipboard_read/write | ✓ (pbcopy/pbpaste) | dep (xclip) | ✓ (powershell) | Termux:API |
| notify | ✓ (osascript) | dep (notify-send) | ✓ (BurntToast or fallback) | Termux:API |
| screenshot | ✓ (screencapture) | dep (gnome-screenshot / scrot / import) | ✓ (System.Drawing) | Shizuku |
| app_open / url_open | ✓ (open) | dep (xdg-open / gtk-launch) | ✓ (Start-Process) | Shizuku (app), Termux:API (url) |
| volume_set | ✓ (osascript) | dep (amixer / pactl) | ✓ (IAudioEndpointVolume P/Invoke) | Termux:API |
| brightness_set | dep (`brew install brightness`) | dep (sysfs write, often needs root) | ✓ (WMI) | Shizuku |
| caffeinate | ✓ (caffeinate) | dep (systemd-inhibit) | ✓ (SetThreadExecutionState) | Termux:API |
| process_list/info/kill | ✓ (ps + pkill) | ✓ (ps + pkill) | ✓ (Get-CimInstance) | ✓ (ps + pkill) |
| powershell | ✓ (pwsh if installed) | ✓ (pwsh if installed) | ✓ | ✗ |
| cmd_exe | ✗ | ✗ | ✓ | ✗ |
| applescript | ✓ | ✗ | ✗ | ✗ |
| system_info / disk_usage / battery | ✓ | ✓ | ✓ | ✓ (Termux:API for battery details) |
| network_interfaces | ✓ | ✓ | ✓ | ✓ |
| window_list/focus/close/move | ✓ (osascript) | dep (wmctrl, xdotool fallback) | ✓ (Get-Process + P/Invoke) | n/a (Android apps OS-managed) |
| Android-only tools | n/a | n/a | n/a | Shizuku and/or Termux:API |

## Android note

The Android backend stitches two systems together:
- **Termux:API** for sandboxed CLIs (clipboard, notification, battery, vibrate, location, volume).
- **Shizuku** (`rish`) for elevated `shell`-uid commands (screencap, am start, settings put, svc wifi/bluetooth, input keyevent).

See [`src/desktop-android.README.md`](./src/desktop-android.README.md) (also shipped inside the package) for the full per-tool prereq matrix and install instructions.

## Security model

Three policy tiers, enforced by the host's registry gate, not by this plugin:

- **`open`** — read-only observability (`system_info`, `disk_usage`, `battery`). Any session can call.
- **`pair-gated`** — perturbs the host or exposes mildly sensitive data (`clipboard_*`, `screenshot`, `notify`, `app_open`, `url_open`, `volume_set`, `brightness_set`, `caffeinate`, `process_list/info`, `network_interfaces`, `window_list/focus/move`, plus Android `termux_notification`, `termux_vibrate`, `screen_lock`). Requires a paired dashboard / device.
- **`master`** — destructive or high-blast-radius (`process_kill`, `window_close`, all three shells `powershell`/`cmd_exe`/`applescript`, plus Android `shizuku_run`, `termux_location`, `wifi_toggle`, `bluetooth_toggle`, `call_phone`, `send_sms`). Requires explicit master credential; otherwise routes to the Approvals queue.

Subprocess invariant: **argv-only**, never `shell: true`. The single exception is `caffeinate`'s Android wake-lock holder which uses `sh -c '<trap script>'` — necessary so SIGTERM cleanly releases the wake-lock — but the script body is static (no caller-supplied interpolation).

The two Android tools that DO interpolate operator data into a `rish -c "..."` payload (`send_sms`, `call_phone`) cleanse via `shellQuote()` (escapes `"`, `\`, `$`, `` ` ``) and a digits-only number filter. `send_sms` is deliberately compose-only — there is NO silent auto-send anywhere in this plugin.

## Build (for forks)

```sh
npm install
npm run build
```

`npm install` only pulls dev deps (typescript, @types/node). The plugin has no runtime `dependencies` — `@swarmai/plugin-sdk`, `@swarmai/shared`, and `@swarmai/tools` are `peerDependencies` provided by the host at load time. **Do not** add them to `dependencies` — that would create duplicate package instances and the `register({...})` calls would land in a registry the host never dispatches from.

## License

PolyForm Noncommercial 1.0.0. Free for personal / evaluation / non-commercial use. Commercial use requires a separate license from NorthPeak (AXICOM SDN BHD).
