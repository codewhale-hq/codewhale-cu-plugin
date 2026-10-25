# Release notes

## 0.12.1 — unreleased

- A runner that cannot read the focused control says so. When the desktop helper or ssh agent is too old to report it (or the backend lacks it) and a key press would have been judged, the receipt carries `focus_gate: "unavailable"`, so the model and the user learn that a Return on a focused button is not being checked. The macOS native read of the focused control has still never run against a live app (Accessibility is not granted to the build host); the macOS gate is checked with fake helpers only.

- Re-registering an ssh computer no longer inherits fields across users or ports. User, port, known-hosts file, agent path and platform hint carry over only when host, user and port all match; before, the same host with another user or port kept them, and a stale `platformHint` could make the launch policy and the owner checks apply another platform's rules.

- Windows input that fails partway reports that input may have been sent. A PowerShell failure on an input script, such as typing that dies after some characters, now sets `outcome_unknown` so the caller does not replay it, unless the failure came before any input (`cursor_move_failed` before a press, `element_stale`, `element_disabled`, `element_read_only`). HarmonyOS `list_displays` ignores a failure to delete its probe directory instead of failing a probe that worked. The Windows code is source-only: it was checked against injected runners and has never run on Windows.

- The default recordings directory is tightened more carefully. The 0700 change followed a symlink and changed the mode of whatever the default path pointed at (including setgid and group access on a shared directory) and swallowed every failure. It now skips a directory that is a symlink, changes only a directory the current user owns, through an opened handle, keeps the owner's own permission bits, and writes one line to stderr when it could not make the directory private. A directory named by `CODEWHALE_CU_RECORDINGS_DIR` that does not exist yet is created 0700 by the plugin; an existing one is still left as the operator made it.

- The spawned-container reaper proves ownership. It matched a dead owner by hostname and local pid alone, so two clients sharing a daemon with the same hostname, or a reused pid, could make a live container look orphaned or an orphan look alive. Containers now carry a host identity (hostname, machine id and pid namespace, hashed) and the owner's start time; the reaper removes a container only when the host identity matches and the owner pid is dead or belongs to a process that started at a different time, and also removes this session's own containers that have stopped at the end of their lifetime. The receipt and tool text now say a spawned desktop is stopped, not destroyed, when its lifetime ends. Containers started by an earlier build carry the old host label and are left alone. Windows does not read the start time. Not run against a remote daemon or podman.

- More key spellings are judged on the focused control. The focus gate recognized `return`, `enter`, `kpenter`, `keypadenter`, `space` and `spacebar`, but Linux passes unknown key names to `xdotool`, so `ISO_Enter`, `KP_Space`, `Linefeed` and `3270_Enter` (GTK binds the first two to button activation) were sent without a focus judgment. They are judged now.

- The launch policy is stricter. A `url` with any control character (a tab or newline inside a scheme is stripped by browsers, so `java<TAB>script:` and a leading C0 byte slipped through on macOS) is refused on every platform; macOS accepts only a URL or an absolute path (relative paths, `~` and a leading `-` are refused); Windows refuses a `file:` URL that names a network share and the `ms-msdt`, `search-ms`, `ms-search`, `ms-appinstaller`, `ms-officecmd`, `mhtml` and `jar` schemes; and a remote computer (ssh, Docker, hdc), which has no ledger behind the policy, opens only `http`, `https`, `mailto` and `file` URLs. The interpreter list gained `pwsh-preview`, `pypy`, `jshell`, `sftp`, `ftp`, `telnet`, `aria2c`, `awk`, `tclsh`, `expect`, `groovy`, `kotlin`, `scala`, `julia`, `Rscript`, `swift`, `swiftc`, `dotnet`, `go`, `cargo` and `rustc`. It is still a deny-list for local computers, not a sandbox.

- A whole-screen capture needs an approved app. The per-app ledger covered the accessibility tools, but `screenshot` (with or without `region` or `display`), `zoom` and `recording` start without a window index captured the whole desktop, frontmost app included, with no consent record at all. They now refuse `consent_required` until the user has approved at least one app on that computer, and on macOS refuse `app_denied` while the app in front is one the user denied. This is a floor, not per-app consent: once any app is approved a whole-screen capture still shows every other app, so use `app_ref` to capture one. Whether whole-screen observation should need its own grant is still a founder decision.

- A launch that fails no longer makes the server forget the app it had bound. `open_application` cleared the server's bound app whenever the call had been sent to the runner, but the desktop helper can refuse (paused, stopped, input busy, session limit, its own policy) before the backend rebinds, so the backend kept the old app while the server stopped judging it: keys and clicks then reached an app the user had since denied. The server now keeps the old binding and, until a later launch succeeds, judges the failed launch's target as well, as it does for a launch that reports no resolved app.

- A repeated press is not judged by one read of the focused control. `key` with `repeat`, and `type` with two or more newlines (or `press_enter` after a newline), read the focus once and reused that judgment for every press, so a first Return on a harmless button that moved focus to a Delete or Send button was followed by unjudged presses. When a button or other non-text control has focus, such a call now asks for the single-use confirmation as a whole (the message says how many presses); a text field or container in focus is unaffected, as is a single press.

- The ledger no longer trusts a window name or a stale pid. On Windows and Linux the owner of a window is decided by its process: a name that a window or document controls (a Windows window title, a Linux sibling window name) can add an allow only when the process itself has no decision, and can never override a deny on the process; a Windows title now counts only for the shared `ApplicationFrameHost` process, so a browser tab titled like an approved app no longer inherits that approval. A pid grant stays valid only while the process at that pid is still named as it was when the grant was made, and a bare `app_ref {pid}` is resolved to the app now running at that pid before it is judged (an unresolvable pid refuses `consent_required`), so an app that inherits a quit app's pid no longer inherits its approval. On macOS an unnamed call is pinned to the app's pid, bundle id and name together, so a recycled pid fails closed in the native resolver as it did before the frontmost-app change.

- `open_application` and `kill_app` are judged on every identity they name. The ledger used to check only the pid when one was given while the backends launch or kill by name (Linux and Windows ignore the pid, and macOS ran `open -a <name> <url>`), so an approved app's pid authorized opening any other app, including one the user had denied. Now the pid, the bundle id and the name are each checked and each must be allowed; a deny on any of them refuses `app_denied`. A `pid` that is not a positive integer and a `name` or `bundle_id` that is not a string refuse `bad_args`. The desktop helper's own deny check judges each identity separately too, so a newer allow on a pid no longer hides an older deny on the name.

- The operating skill no longer depends on line endings, and its consent and stop rules come first. A Windows checkout with CRLF endings made the advertised instructions 6,501 bytes, one over the 6,500-byte budget, so hosted Windows CI failed on the previous commit; `.gitattributes` now pins text files to LF. The consent and stop rules moved ahead of the observe-act-verify loop (they used to start at byte 3,595), so a host that truncates server instructions at 4,096 bytes, as the Engine does, keeps them. The never-replay rule for `action_sent:true` and `outcome_unknown` moved into that block too. No rule was dropped.

- ssh computers are steadier and safer. Every ssh and scp the plugin starts now sets `ServerAliveInterval=15` and `ServerAliveCountMax=3` (a silent connection is dropped after about 45 seconds instead of holding a dead channel open) and turns off agent, X11 and port forwarding and local commands. On a remote with a POSIX shell the agent install builds the new tree beside the old one under a name unique to that install and swaps it in with two renames, restoring the old tree if the swap fails, so an interrupted registration no longer leaves a half-copied agent; a remote without `sh` (a Windows host whose default shell is cmd or PowerShell) is installed in place as before. The install also copies `wayland-input.py`, which the Wayland backend needs and the installer used to skip. A request that times out retires its persistent channel (the agent releases held input as the channel closes) so the late request cannot run after the caller moved on, and a channel that dies reports the last lines the ssh client printed, such as a refused connection or a host-key failure, instead of only `exited 255`. A malformed one-shot receipt is an error instead of a crash. Screenshots and zooms from an ssh computer now come back as images, read over ssh with `wc` and `base64` under the same size budget as a local capture; only a plain absolute `.png`, `.jpg` or `.jpeg` path is fetched and the bytes must start with a PNG or JPEG signature; a remote without a POSIX shell, or a path the host will not fetch, reports `image_omitted` with the reason instead of failing the call. A replacement channel inherits whether the first one ever replied, so one timeout cannot demote the session to one-shot mode; a retired ssh client that ignores SIGTERM is killed two seconds later. Checked against a real sshd in a loopback container: two installs, the swap, option resolution, image read-back, the timeout and a refused connection.

- Windows now names the window that receives input. The backend had no `input_owner`, so keyboard and pointer input through the desktop helper or an ssh agent was refused outright and the direct route sent keys and clicks to whatever window was in front with no consent check. `input_owner` reports the process behind the foreground window (keys) or the top-level window under the point (pointer), so the consent ledger judges the application that would receive the input, as on Linux; a pointer position with no window under it (off the screen, or in a gap between monitors) and an unnamed or missing foreground window refuse `input_owner_unknown`, so a click aimed beyond the screen edge, which Windows clamps onto the nearest pixel, is no longer allowed through unjudged. `focused_control` reads the UI Automation focused element so an untargeted Return or space on a button that would pay, buy, send or delete needs the confirmation a click needs. A cursor move that Windows refuses now stops the action before any button event (`cursor_move_failed`) instead of clicking wherever the pointer was, a PowerShell timeout or cancellation on an input script is reported as input that may have been sent, and `element_stale`, `element_disabled` and `element_read_only` from UI Automation arrive as codes instead of a plain exit status. Each input call now runs an extra PowerShell process to name its target (two for a drag, and one more to read the focused control for Return, Enter, space or a newline), so Windows input is slower. The desktop belongs to `explorer`, and UWP and Store apps share the `ApplicationFrameHost` process, so approving the host covers all of them (a window title stands in for the host only while the host itself has no decision). A drag now checks both ends are reachable before pressing, and a refused move after the press reports that input may have been sent; a release failure no longer replaces the original error. This is source behavior for the Windows preview: it was written and checked against an injected runner only, and has not been run on Windows.

- Captures are private. The default recordings directory (`~/.codewhale-cu/recordings`, holding screenshots, zoom crops, OCR captures and trajectories) is created with mode 0700 and an existing broader one is tightened, so other local users can no longer read files in it; before, the directory was 0755 and the files 0644. A directory chosen with `CODEWHALE_CU_RECORDINGS_DIR` is left as the operator made it.

- Retention. Screenshots, zoom crops and OCR captures (`.png`, `.jpg`, `.jpeg` files directly in the default recordings directory and in its `captures` folder) older than 14 days are deleted, at most once every six hours across all processes (a `.pruned` marker records the last scan) and at most 5,000 files per scan; a recordings directory or `captures` folder that is itself a symlink is skipped, symlinked files are never removed, and recordings (`.mov`, `.mp4`), trajectories and any directory chosen with `CODEWHALE_CU_RECORDINGS_DIR` are left alone. An image you saved at the top level of the default recordings directory is covered too: copy it elsewhere to keep it. `CODEWHALE_CU_RETENTION_DAYS` changes the age (1 or more); `0`, or a value that is not a number of days, keeps everything. After a successful install or update that replaced an existing app, the app keeps the two newest rollback backups in `.codewhale-cu-backups` (named `<timestamp>-<uuid>`, with or without `.app`), always including the backup that install just made, and deletes older ones, on macOS and Windows; other entries in that folder are not touched. `CODEWHALE_CU_BACKUPS_KEEP` sets the count (at least 1). The first scan after this change deletes what the rules already cover, which can be thousands of old captures (up to 5,000 per scan, six hours apart) and, at the next update, many gigabytes of old backups. Not run on Windows.

- HarmonyOS: the first `list_displays` on a computer no longer throws a TypeError from its probe capture cleanup.

- Spawned Docker computers are bounded. `spawn` used to share the host IPC namespace and set no limits, capabilities or lifetime, and a hard-killed host left the container running with nothing to remove it. A spawned desktop now has a private IPC namespace with a 1 GB `/dev/shm`, all capabilities dropped, `no-new-privileges`, 4 GB of memory, 2 CPUs (capped at what the daemon has), 2048 processes and a six-hour lifetime, which the spawn receipt reports; `CODEWHALE_CU_SPAWN_MEMORY`, `_CPUS`, `_PIDS` and `_TTL_S` override the limits and `CODEWHALE_CU_SPAWN_NETWORK=none` removes network access (egress stays on by default). Each container carries its owner's pid and host, and the next spawn removes spawned containers whose owner process is gone on the same host. The image reference and computer id are validated before anything is started, and a desktop that fails to start reports its container log. Chromium, the screenshot path and AT-SPI were exercised in a hardened container; a hand-edited docker entry is still never destroyed.

- Irreversible-action confirmation reaches more presses. On macOS an untargeted Return, Enter, keypad Enter or space, a `type` with a newline or `press_enter`, and `hold_key` are now judged against the control that has keyboard focus, as they already were on Linux: the helper reads the bound app's focused control (new `focused_control` tool and capability) and a focused control that would pay, buy, send, transfer or delete asks for the same single-use confirmation as a click on it. Spellings the backends accept (`kp-enter`, `KP Enter`, `return+cmd`, a bare space character) are judged too, `type` with an element target and a newline is judged on that element, and `left_mouse_down` needs the confirmation a click needs because macOS delivers the pointer click at release. A focus the helper cannot read refuses `focused_control_unknown`; an app with no focus is not gated; focused text fields, search fields and containers (web areas) are exempt, as before. A helper without the capability, such as an installed 0.12.0 app, keeps the old behaviour. Limits: a key pressed inside a text field still submits (composers send that way), the label match is English-only, and drags are not judged.

- Remote and Linux hardening. `open_application` passed `url` as the first argument of any executable on the PATH without validation, so on Linux `name:"node", url:"--eval=..."` ran code, and on ssh and spawned computers no per-app consent applies, which contradicted "no shell over the socket". One launch policy (`src/launch-policy.mjs`) now runs in the MCP server for every computer and again in the runner that executes the call (desktop helper and ssh agent): `url` must be an absolute URL with a real scheme (`file:///` for a document; `javascript:`, `vbscript:` and `data:` are refused), macOS also accepts a path but refuses a value that starts with `-`, `name` and `bundle_id` must be strings, and interpreters, shells, package runners and script hosts (`sh`, `node`, `npx`, `python`, `powershell`, `mshta` and similar) are refused with `launch_refused`; on macOS only an explicit executable path is judged by name, so apps such as Dash or Java still launch. The policy runs before any consent decision, so the user is not asked to approve a launcher. Because the server enforces it, ssh hosts and Docker images that still hold an older agent are covered; the list is a deny-list, not a sandbox. The platform an ssh host reports no longer names a local backend module: registration, the catalog loader and the backend lookup accept only darwin, linux, win32 and harmonyos (`invalid_platform`), and a catalog entry with another platform is ignored. The ssh agent's persistent mode releases held input and closes its sessions when stdin closes or it is told to stop, and says so on stderr if that fails; before, a dropped channel left a button or key pressed on the remote desktop (hosts need `computer_register` to receive the new agent). `owned` and `spawnedBy` are honoured only for docker entries, and `local` is built from the running machine alone, so an edited catalog cannot mark `local` as a disposable computer and skip the ledger. Re-registering an id under another transport no longer carries the old entry's fields. A refused `open_application` no longer makes the server forget the bound app while the backend keeps its binding, which let a revoked app go on receiving keys after any refused launch; only a launch that reached the backend clears the binding.

- macOS: observing or reshaping an app without naming it no longer bypasses the per-app ledger. `get_app_state`, `find_elements`, `wait_for`, `list_windows`, `set_window_frame` and `recording_start` with a window index and no `app_ref` used to act on whichever app was frontmost, with no consent record. They now resolve the frontmost app, check the ledger on it and pin the call to its process, so the app cannot change between the check and the use; with a bound app they pin that app, so a helper that lost its binding cannot fall back to the frontmost one. When nothing can be identified they refuse `consent_required`. `set_window_frame` now defaults to the bound app, as its schema always said. A `state_id` argument no longer stands in for an app on these tools. Linux and Windows still choose an app themselves when none is named (tracked separately).

- An approved app can be brought forward with `activate:true` without a second foreground approval prompt. The grant stays scoped to that app; missing or revoked app approval and explicit foreground denials still refuse. Background stays the default, with human-input yielding, Pause/Stop, input ownership and consequential-action confirmation unchanged. This is source behavior for the next update, not an installed-helper upgrade.


- `max_dimension` now works on every backend that returns a raster. Linux X11/Wayland scales with imagemagick (`magick`/`convert`) or ffmpeg and reports the derived `scale`; Windows scales inside the existing PowerShell capture before saving; the HarmonyOS backend refuses it explicitly instead of silently ignoring the argument and returning a raster larger than the caller asked for. Before, only macOS honoured it, so a Linux or Windows host asking for a vision-sized raster still received a full-resolution one and the `pixels`/`scale` receipt kept describing a picture the model never got.

- `screenshot` takes `max_dimension`: the longest side of the returned raster in pixels. A 6K display returned 5760x3240 (2.1MB), which no vision model receives at that size, so the picture the model saw and the raster its coordinate targets were checked against were different grids. Passing the model's vision budget (for example 1568) makes the returned image exactly the raster the receipt describes, and `pixels`/`scale` are derived from the file actually written.
- The setup background check writes its verification capture to a generated path in the recordings directory instead of a temp directory the sanitizer refuses. Before, every check that reached the final screenshot failed with `output path must be inside the recordings directory` after the click and typing had already succeeded.
- Document `max_dimension` in the operating details next to the raster_id guidance a vision model reads before acting.

- Integrate the October 6–8 Cua Driver workflow improvements through the existing tools: fresh unique element lookup in batches, `args` compatibility, final observations, complete-plan validation and explicit completed/delivery receipts.
- Stop batches on failed waits and recheck wait conditions on the returned observation.
- Add same-view `get_app_state since` diffs without replacing the complete target cache; expired, changed or incomplete baselines return a full resync.
- Forward filtered macOS searches to the native deep walk and accept common key spellings (`Page_Down`, `PgDn`, `ArrowLeft`, `Forward_Delete`, `KP_Enter`).
- Preserve trajectory text redaction and capture-pin replay refusal for aliased batch arguments.
- Supply the concise operating skill through standard MCP initialization.
- Serve detailed operations and recording as exact packaged MCP resources; incomplete skill packs fail at startup.
- Clarify bundled-helper setup and the local-app, signed-in-Chrome and isolated-browser routes.
- `computer_register` removes an ssh computer it just added when installing or probing the agent fails; before, the failed computer stayed listed and selectable. An entry that existed before the call is left alone.

### Many live sessions (CW-7495)

- macOS: the live preview stops capturing after 60 s without a bind, preview or action (`CODEWHALE_CU_PREVIEW_IDLE_MS`), and the next action restarts it. Before, a bound session refreshed it every second (a window capture, a cursor read and a panel update) until the session closed, which never happens under a host that keeps idle sessions open.
- macOS menu-bar app: it reads the helper's control channel when data arrives, asks for status every 250 ms only while its window is open and when its menu opens, and waits on the helper process instead of polling it. Before, it asked for status and rechecked Accessibility and Screen Recording four times a second for as long as it ran. Takes effect in the next helper build.
- Through the helper, one session at a time sends input to an app. Another session's input to the same process is refused `input_busy` before anything is sent, until the first session binds another app, closes, is stopped or makes no request for `CODEWHALE_CU_INPUT_IDLE_MS` (default 60 s). Before, two sessions bound to one app could interleave their keystrokes in it. `input_busy` is now in the refusal-code reference.
- A held pointer whose session has made no request for that idle window is released when another session sends input. Before, it refused every other session's input until its host closed the connection.
- `list_sessions` through the helper reports each session's `owner` (`pid`, `host_pid`), `self` and `writing`, and the idle window as `inputIdleSec`.
- Limitations: Codex keeps one server per thread; what was and was not established about doubled keystrokes; a helper without a build fingerprint cannot be told apart from another build of its version.
- The helper's `hello` carries a build fingerprint (a hash of the plugin's `src`, `app` and `plugin.json` taken at start) and its plugin path. `request_access` marks `app.stale` with `installed_build` when the helper's app on disk has changed since it started, and `app.build_skew` with `bundled_build` when this plugin and the helper are different builds of one version. Before, both read as the same version and nothing was reported. Helpers without a fingerprint are compared by version only, as before.

### Input ownership on the desktop-helper and ssh routes

- The consent check on the app that would receive keyboard or pointer input now also runs when input goes through the desktop helper or an ssh agent. Before, it ran only when the server drove the backend in-process, so helper-routed input into an unapproved Linux window was delivered. The runner answers a new allow-listed `input_owner` request, and the same ledger decision applies before dispatch.
- A runner that cannot name the owner refuses the input. Only a macOS runner may lack the request, because the macOS backend gates input on the bound app. An older helper or agent without the request returns `app_upgrade_required`.
- Windows, current behaviour: the Windows backend does not implement `input_owner`, so keyboard and pointer input through the Windows desktop helper or an ssh agent on Windows is refused (`unsupported_on_platform`; an older helper returns `app_upgrade_required`). The direct Windows route does not run this check and keeps the bound-app checks. Held input on Windows needs the helper, so it is refused on both routes.

### Linux desktop control (X11)

- Consent now covers the window that receives input. Keystrokes check the active window's app and pointer events check the topmost window under the point, so input aimed at an unapproved app is refused. Previously a fresh server could click and type into any window, and an approved app's decision covered input that landed elsewhere.
- A window's app identity comes from its process. Toolkits that set no `_NET_WM_PID`, Tk among them, are identified through the X server's X-Resource extension, and a process's other windows count as the same app for consent.
- Keystrokes are refused while a menu or popup item is open (`popup_open`); Escape is always allowed. A menu probe that does not answer refuses the keystroke (`popup_unknown`).
- `focus`, `get_value` and `select_text` work through AT-SPI. Targeted `type` and `key` refuse when the element's window is not the active one (`window_not_active`). When AT-SPI and X11 name an app differently (Chromium), these checks match by pid.
- An untargeted Return, Enter or space reads the focused control, whether it is sent through `key`, `hold_key`, or `type` with a newline or `press_enter`. If that control would pay, buy, send, transfer or delete, the key needs the same confirmation as a click on it (`confirmation_required`). A focused control that cannot be read refuses the key (`focused_control_unknown`). The helper and ssh routes answer the same `focused_control` request.
- `screenshot` and `list_windows` accept `app_ref.name`. App-window captures list the windows stacked above them in `occluded_by`.
- `switch_display` and `screenshot {display}` check the index against `list_displays` and refuse an unknown one (`bad_args`). `screenshot` with `display` crops to that display, and `switch_display` sets the display later full-screen captures use. `display:"all"` captures the whole screen. `display` cannot be combined with `region` or `app_ref`.
- `list_apps` returns one entry per process, with its pid.
- `open_application` and `write_clipboard` report an executable that is not installed as `app_not_found` (or `launch_failed`); before, the server exited.
- Screen recording runs ffmpeg `x11grab` as a child this server owns; it is finished by `recording_stop`, session close and server exit.
- `kill_app` is implemented: window close first, `force:true` for SIGKILL, ambiguous names refused.
- `list_sessions` is implemented.
- `browser start` reports why Chromium exited (root sandbox, exit code, stderr tail) instead of a generic timeout.
- `computer_switch` reports an unknown computer as a tool error (`unknown_computer`), not a protocol error.
- Smoke: consent checks run only for the app named in `CU_SMOKE_APP`; the registry checks expect the refusals the host actually gives.
- Held input on standalone Linux (drag, hold, held mouse) still requires the desktop helper. See LIMITATIONS for why.

### Linux on Wayland

- A session counts as Wayland when `XDG_SESSION_TYPE=wayland` or the `WAYLAND_DISPLAY` socket exists, even with an XWayland `DISPLAY` set; before, such a session was driven with X11 tools that saw only XWayland windows. `request_access` reports the reason (`session_reason`).
- On sway and Hyprland, keyboard and pointer input go through virtual Wayland devices (`src/backends/wayland-input.py`). Consent applies to the app the compositor names: the focused window's pid for keys, the window under the point for the pointer. The `window_not_active` and `popup_open` guards run here too.
- Refused even on sway: a point where floating windows, or XWayland windows, of two different apps overlap, and pointer input with no coordinates (sway does not report the pointer position).
- Every other compositor, GNOME and KDE included, is observation only: screenshots (grim, wlroots only), the clipboard and the AT-SPI tree. Input is refused (`input_owner_unknown`) and `request_access` says why.
- `read_clipboard` no longer appends a newline, and `list_apps` on sway no longer throws.
- Verified on headless sway 1.9 with XWayland, direct route: 21 of 27 parity tasks demonstrated at 5 repeats (`parity/results/linux-wayland-isolated-sway-2026-10-11.json`). Hyprland is unit-tested only. A real sway login session and the desktop-helper route are not exercised.

### Docker computers

- `screenshot`, `zoom` and `browser_screenshot` on a spawned Docker computer return the image. It is read back over `docker exec` under the same single-message budget as a local capture, or reported as `image_omitted`. Before, they returned an in-container path.
- Spawn reports ready only once the container's session bus is up, so an app opened right after spawn reaches AT-SPI.
- The image no longer runs `npm ci`; the server and tests have no npm dependencies.

Host guidance delivery is owned by Engine separately. No app or store publication is claimed.
Local source checks on macOS: 515 tests, 494 passed, 0 failed, 21 skipped; focused MCP resource suite (`tests/mcp-skills.test.mjs`): 12 passed.

## 0.12.0 — the agent gets its own pointer

The agent no longer uses the person's cursor on macOS; the shared-computer
attach mode lands for Codewhale Computers; and a safety floor gates app
scripting, irreversible clicks and recorded consent.

### The agent never drives the user's cursor (macOS)

- **Every macOS pointer gesture is window-routed.** Clicks, hover, drag and
  wheel go to a window of the bound app as window-routed event records in
  both background and `activate:true` modes. The HID-tap `pointer_sequence`
  route, the `strategy:"app"` move-and-restore fallback and native
  `release_input` are gone; the helper refuses them with
  `real_pointer_refused`. Foreground mode no longer means shared pointer:
  binding receipts report `shared_pointer: false` and
  `pointer_route: "window-record"`.
- `pointer` down/move/up buffer a drag on the Codewhale pointer and deliver it
  to the window on `up`; nothing is held on a real button, so there is
  nothing to release on disconnect.
- `activate:true` still takes foreground and keyboard focus; Windows and
  Linux raw input is unchanged and still shares the desktop.

### Shared-computer attach mode (Codewhale Computers)

- **Browser attach:** `CODEWHALE_CU_BROWSER_ATTACH=/run/cw/cdp.sock` connects
  to the shared Chromium's CDP bridge instead of launching a private browser.
  The agent opens and fronts its own tab beside the person's, `status` lists
  every tab, `start {tab}` moves to a named one, and `stop` only detaches — no
  tab or browser is closed. A second controller gets `browser_busy`.
- **Control lease gate:** with `CODEWHALE_CU_LEASE_FILE`, every input tool
  refuses `computer_busy_human_driving` while a person holds the lease;
  observation keeps working and hand-back restores input without a restart.
  An unreadable lease fails closed (`computer_lease_unreadable`).
- **Turn hold:** `codewhale-cu-turn-hold` keeps a Sprite Task registered for
  the turn (5 min capped expiry, refreshed every 60 s) and releases it when
  the turn ends.

### Safety floor

- `app_script` is app scripting, not a shell: `do shell script`,
  `doShellScript`, terminal `do script`, the Objective-C bridge, dynamic code,
  raw Apple event codes and System Events keystrokes refuse `script_refused`,
  and every app a script names — System Events and each `process "X"` it
  drives included — goes through the per-app consent ledger. Operators can set
  `CODEWHALE_CU_APP_SCRIPT=off|unrestricted`.
- Clicks and presses on controls labelled pay, buy, place order, send,
  transfer or delete refuse `confirmation_required` until the user confirms
  that exact call with `consent {action:"allow", confirm}`; no app grant
  covers it. The skill gains a section on untrusted screen text, links and
  irreversible actions, and routes signed-in web work to Chromewhale.
- A consent decision (allow, deny, revoke or confirm) must be its own call:
  it is refused as a `run_actions` step and stops a trajectory replay
  (`not_replayable`), so a batched or recorded decision never passes as one
  the user just made.
- Trajectories redact typed text, set values and clipboard writes, mark those
  steps not replayable, and are written 0600 in a 0700 directory.
- A helper newer than the plugin no longer reports itself as stale.
- `have()` resolves tools on PATH in-process instead of spawning
  `which`/`where`, which timed out on loaded Windows runners and turned the
  v0.11.2 and v0.11.3 tag runs red; a Windows test fixture retries a rename
  that a concurrent reader briefly blocks. The Sprite Unix-socket transport
  tests skip on Windows, which cannot bind the socket path.

## 0.11.3 — MCP protocol conformance

- The MCP server answers `resources/templates/list` with an empty template
  list instead of `-32601 method not found`. It publishes a fixed skill pack
  and never a parameterized URI space, so an empty list is the correct answer;
  a host that probes the method because the server advertises `resources` no
  longer records a discovery warning at the start of every session. The
  advertised capabilities are unchanged, and genuinely unknown methods are
  still refused.

## 0.11.2 — shared-desktop reliability

- macOS background mode refuses window-record focus leases before input,
  including pointer fallbacks, modified keys and web value replacement.
  Native typing cannot silently take focus for Unicode or hosted panels.
  Older helpers are refused for background typing until updated.
- Linux semantic value edits select the supported accessibility interface
  before writing, verify the value, and never replay a refused or uncertain edit.
- Disposable Linux desktops stop and reap their display processes before
  container exit, preventing stale display locks after an orderly restart.
- Routine consent tests use a recording backend and never launch, activate
  or quit a user's desktop application.
- Windows UIA targets bind to observed window/element identities; display and
  region capture preserve geometry. Bundled-Node installation, native input
  contracts, control pipes and real controlled-desktop acceptance run in CI.

- App bundles include the Docker build context and lockfile required by
  `computer spawn` on first use.
- Typing without a focus lease no longer reads uninitialized accounting
  data, fixing invalid JSON receipts and the macOS CI failure.
- A busy desktop now refuses `user_busy` when the quiet-input deadline
  expires, before taking focus or sending input. Foreground key presses
  revalidate their app after waiting. Input arriving mid-action remains
  a documented limitation.

Distribution: notarized universal macOS app; experimental unsigned Windows x64
preview with bundled Node; Linux source and Docker desktop. Windows preview
is not a signed production installer. Physical keyboard coexistence, native
sharing-picker integration, fresh-machine permissions and Windows mixed-DPI
acceptance remain open. The Codewhale Engine has its own release lifecycle;
its pending-approval Stop fix is tracked separately in Core14c64b5bdc.

## 0.11.1 — background is the default on every platform

- `activate:true` now requires the separate foreground consent on **every**
  local platform, not just macOS — the shared-surface escalation always asks.
- Windows `open_application` honors `activate:false` by launching the app
  minimized instead of stealing the user's foreground.
- Linux `open_application` honors `activate:false` by restoring the
  previously focused window after launch (X11/xdotool, best-effort). Raw
  input on Windows and Linux remains shared-surface by nature — background
  there means the launch doesn't steal focus.

## 0.11.0 — consent and turn-taking: working *with* the person on their Mac

The other half of "don't take over my computer": when the model works on the
user's own machine, the app — not the tool — becomes the unit of trust, and
shared-surface moments learn to take turns with the person at the keyboard.
Both products that shipped local computer use this year converged on these
same primitives; this release lands them.

- **Per-app consent ledger** (`consent {action:"status"|"allow"|"deny"|"revoke"}`).
  The first call that targets an application on `local` — `open_application`,
  an `app_ref`, an element or `state_id`, or an action on the bound app —
  refuses `consent_required` until the user decides. Decisions cover the
  session; `remember:true` persists them to `consent.json` for the computer.
  A deny is a wall: identity resolution folds name, bundle id and pid
  together, so a denied app fails `app_denied` under every spelling and
  cannot be opened, driven, or killed through this surface.
- **Foreground consent is a second axis.** `open_application
  {activate:true}` on macOS — the shared-desktop escalation — additionally
  requires `consent {action:"allow", scope:"foreground"}`;
  `foreground_consent_required` / `foreground_denied` are the typed
  refusals. Background control (`activate:false`) never needs it.
- **The helper yields to the person.** Before taking a shared surface — a
  front lease for window-record input, a real-pointer gesture, foreground
  keys, an activation — it waits for a gap in the user's hardware input
  (the same HID clock the interference accounting already reads; the agent's
  own posted events never tick it). Bounded: `CODEWHALE_CU_YIELD_GAP_MS`
  450 / `CODEWHALE_CU_YIELD_WAIT_MS` 2500 by default, 0 disables. Every
  receipt that waited reports `yield_ms`; mid-action user input is still
  reported, not prevented.
- **Bound-app identity tracking.** `open_application` records the resolved
  app; implicit actions consent-check against it, and rebinding a different
  app invalidates stale observations so old element indices can't silently
  target the previous app. Route teardown drops the computer's session
  consent with it.
- **Scope honesty**: spawned computers are exempt (task-owned, nothing of
  the user's); remote computers are covered by the transport's trust;
  `app_script` keeps macOS's own Automation consent; the ledger is a
  model-level gate, not a sandbox — see `docs/LIMITATIONS.md`.

Verification: `npm test` adds `tests/consent.test.mjs` (14 tests: ledger
units, `consent_required`/`app_denied`/`foreground_*` refusals live over
stdio, deny-bypass across all spellings including `kill_app`, session vs
persisted layers, remote/owned exemption) and `tool-merge` coverage for
the new merged tool. Live-verified: Calculator refused → allowed →
foreground-consented → activated; consent decisions alias across name,
bundle id and pid.

## 0.10.0 — spawned computers: the agent gets its own desktop

The missing primitive behind "don't take over my computer": a computer is
an execution environment, not necessarily the user's desktop. This release
adds the disposable kind.

- **`computer {action:"spawn", id, transport:"docker"}`** — provisions a
  task-owned Linux desktop container (the plugin's `docker/Dockerfile`
  image: Xvfb, openbox, AT-SPI, Chromium, the bundled agent), registers it
  `owned:true`, and makes it active. Every existing tool works on it
  unchanged — screenshots, the accessibility tree, `open_application`,
  clicks, `browser` — through the same allow-listed agent protocol as
  ssh: the channel is `docker exec` into `agent.mjs`, never a shell.
- **Transactional lifecycle.** Spawn auto-builds the image on first use,
  waits for a live window manager before reporting ready, and removes the
  container on any failure. `computer remove` destroys the container;
  MCP session end (stdin close, SIGTERM/SIGINT/SIGHUP) reaps every
  container this session spawned — labelled
  `codewhale.cu.spawned/session/computer` so teardown is auditable and
  never touches another session's or user's containers.
- **`local` becomes the exceptional route** — for tasks that need the
  user's own session, not the default. The skill now names the two
  computer kinds (spawned = ours, registered = someone's) and prefers a
  spawned desktop for general work.
- **Failures are typed**: `docker_unavailable`, `spawn_image_missing`,
  `spawn_failed`, `invalid_container`, `cleanup_failed`.
- **Scope honesty**: spawned desktops are Linux/X11 only. macOS and
  Windows still have no isolated in-session desktop (one WindowServer /
  one interactive session per login) — the architecture leaves room for
  a VM transport next.

Verification: `npm test` (new `tests/spawn.test.mjs` — real-container
integration gated on a live docker daemon, unit tests otherwise);
live on docker 28.4 / Colima: spawn in ~1s → `open_application`
chromium → `list_windows` shows the window, AT-SPI `get_app_state`
returns real elements, `type` lands, `computer remove` destroys the
container, server exit reaps session-owned containers.

## 0.9.0 — use the whole computer: `app_script` and interface choice

Clicking was the plugin's only way into an app. This release adds the
programmatic one and teaches the skill to choose between them — computer
use means using the whole computer, not only its screen.

- **`app_script` (advertised 37)** — AppleScript or JXA through osascript
  into apps that ship a scripting dictionary (Finder, Mail, Safari,
  Calendar, Notes, Reminders, System Events…). Deterministic, returns
  stdout as `result`, needs no Accessibility grant and never touches the
  pointer; `language:"javascript"` selects JXA, `timeout` caps at 120s.
  Refusals are typed: `script_error` (stderr in the message),
  `script_timeout`, `script_cancelled` (-128), and `automation_denied`
  (-1743 — the fix is Automation consent in Settings, not a retry).
  macOS only; other backends fail `unsupported_on_backend`.
- **Local computer only, by construction.** `app_script` is refused for
  ssh/hdc computers twice — the server fails `unsupported_on_transport`
  before dispatch, and the remote handler refuses it for any computerId
  that is not `local` — so a remote channel stays a computer-use
  surface and can never be steered into a shell. Routed through the
  helper when the app owns the session, so the action appears in
  `list_sessions`, honors Pause/Stop, and Automation consent lands on the
  bundle the user already manages.
- **The skill now leads with interface choice.** Per step: the host's own
  tools → `app_script` → `browser` (CDP) → accessibility actions →
  pixels. The observe–act–verify loop stays, reframed as the GUI loop —
  the route for apps with no better interface, not the whole product.
  A step that can be clicked still costs more than the same step
  scripted, and `action_sent` proves less than a returned value.

Verification: `npm test` 345 tests — 330 pass / 0 fail / 15
platform-skipped; `node scripts/check-receipts.mjs docs parity/results`
clean; `npm run smoke` 23/23 on macOS arm64 (the script's tools/list
checks were stale since the 0.7.0 merge — fixed to the advertised
surface in this release).
Live smoke in direct mode (`CODEWHALE_CU_APP=off`, macOS arm64):
AppleScript `return "whole computer"` → `result`, JXA
`"ok".toUpperCase()` → `OK`, syntax error → `script_error` with stderr,
`tell application "Finder" to count windows` → `0` with no consent
dialog where Automation was already granted.

## 0.8.0 — window frames, installed apps, trajectories, capability grants

The last four from the dogfood gap list, in one batch (no per-feature version
churn):

- **`set_window_frame`** — move or resize one window by exact geometry
  (`{x,y,w,h}` in the `list_windows` space) and read the result back from the
  app itself: `verified` is the app's own geometry after a settle loop, with
  `ax_errors` and a plain note when an app constrains (minimum sizes are
  common) or refuses (fixed-size windows) part of the frame. Both axes
  refusing is `frame_refused`.
- **`list_apps {installed:true}`** — the installed catalog of openable apps
  (`/Applications`, `/System/Applications`, `~/Applications`, one
  subdirectory deep; bundle identity read from the bundle, never the folder
  name) with running flags. On the dogfood machine: 143 apps, the user's
  Chrome correctly flagged with its pid. The running-process list is not
  consulted for this view.
- **Trajectories — record, status, replay** (`trajectory`, advertised 36).
  A local JSONL of every tool call the session makes — refusals included —
  in the recordings dir, off until started. `replay` re-enters the normal
  pipeline (grants, permissions and the kill switch all still apply), stops
  at the first refusal, never re-records itself, refuses ids that escape the
  trajectories directory, and caps a replay at 200 turns; `dry_run` lists the
  plan first. Arguments are stored verbatim so replay is faithful — that is
  the documented trade.
- **Capability grants** — `CODEWHALE_CU_GRANT` (`read-only`, or a comma list
  of tool names; merged names expand to their whole action set), fixed at
  launch, nothing can widen it. Enforced twice: the server filters
  `tools/list` and refuses calls as `not_granted` before validation, and the
  app daemon stores the granted wire set on the session lease and refuses
  ungranted tools at the boundary that actually sends input. Cleanup
  (`close_session` / `release_session_input`) and `stop_computer_control` are
  never blocked; `request_access` reports the active grant.

Verification: `npm test` 332 tests — 318 pass / 0 fail / 15 platform-skipped
(9 new across darwin, trajectory, grants, session lifecycle). Live smoke, app
mode against the installed bundle: 143-app installed catalog with running
flags (the user's Chrome flagged, its pid intact); TextEdit and Calculator
frame changes with the app's own readback (Calculator's fixed-size refusal
surfaced as ax_errors while the position moved); trajectory recorded three
turns including a refusal, dry-run listed the plan, replay stopped at the
refusal; a read-only grant narrowed the surface to 19 tools, refused
`click` as not_granted, rode the daemon lease, and reported itself via
request_access; browser and session registry spot checks stayed green —
25/25 (receipts in /tmp/cu-probe-082).

Follow-up on the same release, from the first hosted CI run of the sync:
`request_access` now reports the active grant on its *refusal* receipt too.
The Linux CI environment has no `DISPLAY`, so the probe itself refuses with
`no_session` before the grant was attached — a narrowed session on a headless
host could not see its own bounds. The grant is a launch-time server fact; it
now rides both the success and the refusal receipt, and the Linux suite (which
runs the platform tests macOS skips) is green: 333 tests — 306 pass / 0 fail /
27 skipped in a `node:22` Linux container; macOS 318 pass / 0 fail / 15
skipped. This is a fix, not a feature: the release stays 0.8.0.

Second follow-up on the same release, from the muse-driven acceptance pass:
macOS `open_application` reported `launched: true` even when it merely
resolved an already-running process — the literal was hardcoded while the
launch branch above it is conditional. It now reports whether this call
actually ran the opener (linux/win32/harmonyos always spawn, so theirs was
already accurate). macOS suite: 334 tests — 319 pass / 0 fail / 15 skipped.
Still a fix: the release stays 0.8.0.

Third follow-up: front-lease interference accounting (SHA-6643 slice 1).
Every taken window-record lease now reports its borrow window (`lease_ms`)
and the hardware-input clock around it (`idle_before_s`, `idle_after_s`),
plus the verdict `user_input_during_lease` — true only when the person's
own input arrived mid-lease (synthesized events provably do not tick the
clock, verified live 2026-09-17). The verdict is computed in one JS helper
so it stays unit-tested; receipts from older helpers stay quiet instead of
lying. macOS suite: 336 tests — 321 pass / 0 fail / 15 skipped. The release
stays 0.8.0.

## 0.7.2 — browser control over CDP

The capability axis we did not have: a Chromium-family browser driven over the
DevTools protocol, in a **self-owned profile** (`state/browser/profile`) with
one tab per session. The user's own browser — profile, tabs, logins — is never
attached to and never touched; the last session out closes the shared browser.
No screen coordinates and no accessibility are involved: elements are CSS
selectors through the DOM domain, and coordinate clicks are page-viewport
pixels — a space named differently from screen points so the two can never be
confused.

One advertised tool (`browser`, 33 -> 34) with actions `start | status |
navigate | click | type | screenshot | stop`; the seven wire names stay
callable and hidden. Page screenshots come back as inline images through the
same single-message budget guard as screen captures. Wired into all three
desktop backends (CDP is OS-independent) and the ssh transport. Node needs a
global WebSocket (22+); older runtimes refuse with `unsupported_runtime`
instead of half-working.

Verification: `npm test` 321 tests — 306 pass / 0 fail / 15 platform-skipped
(14 new: scripted-CDP unit coverage for every action, launch-tab adoption,
busy-instance tab creation, live-endpoint reuse, stale-port replacement,
last-one-out close, url refusals). Live smoke against the installed bundle:
real Chrome launched in its own profile, fixture-page click and type verified
by the page's own title, page screenshot inlined as an image, `stop` closed
the tab and the browser while the user's own Chrome was untouched — 20/20
(receipts in /tmp/cu-smoke-072).

## 0.7.1 — live preview, session visibility, kill_app; dogfood fixes

Straight out of the 2026-09-17 live dogfooding of 0.7.0 on a real Mac (a
scripted 9-check sweep with raw JSON-RPC receipts, run while another model
drove the same daemon):

- **The preview panel is live while a session is bound.** After the first
  successful capture a timer keeps refreshing it (default 1s;
  `CODEWHALE_CU_PREVIEW_REFRESH_MS=0` disables), so the person watches the app
  instead of a frozen still. A hide now quiesces an in-flight capture (its late
  notify could re-show a just-dismissed panel), and the session that showed
  the panel hides it on close — a dead session no longer leaves an orphaned
  panel with no owner to refresh or hide it.
- **`list_sessions`.** Multi-agent coexistence made visible: live sessions as
  content-free summaries (bound target, delivery mode, current action, idle
  age, whether any session holds a pointer) plus the user's control mode.
  Lease-gated; available even while the user has paused or stopped another
  session, because seeing who is driving is how a model explains machine
  state. In direct mode it reports the one in-process session.
- **`kill_app`.** Quit or force-quit by exact name, bundle id or pid. Refuses
  an ambiguous name match (`ambiguous_application` — pass pid), never
  terminates the Computer Use helper or its host (`protected_application`),
  and reports verified termination in the receipt.
- **`open_application` now returns `app_not_found`** for names and bundle ids
  that resolve nowhere and for dead pids. The dogfood sweep showed all three
  answering with a generic `tool_error` (`open failed: Unable to find
  application named ...`), so agents could not branch on a documented code.

Advertised surface: 33 tools (31 + the two above). Docs reconciled: the quick
reference and refusal codes (including the real `window_ambiguous` trigger —
duplicate window frames for the resolved window, not merely "several
windows"), and the README preview paragraph.

Verification: `npm test` 307 tests — 292 pass / 0 fail / 15 platform-skipped
(6 new: live-preview lifecycle, `app_not_found` codes, direct-mode
`list_sessions`, `kill_app` pass-through, daemon session registry). Live smoke
on this machine (0.7.1 installed, receipts in /tmp/cu-smoke-071): 33 tools
advertised; two live MCP clients visible in `list_sessions`; Calculator
launched in the background and killed with `kill_app` (the protected guard
refuses the helper itself); the preview file advanced 2.2s of mtime over a
2.6s window, froze on mute, resumed on re-enable, and stopped on session
disconnect — 17/17.

## 0.7.0 — merged advertised surface; wire names stay aliases

`tools/list` advertises **31 tools instead of 45**. Every session pays for the
schemas it loads, and six families said the same thing with different verbs:

- **`click`** ← `left_click`, `double_click`, `triple_click`, `right_click`,
  `middle_click` (`button`, `clicks`)
- **`pointer`** ← `mouse_move`, `left_mouse_down`, `left_mouse_up`
  (`action: move|down|up`)
- **`clipboard`** ← `read_clipboard`, `write_clipboard` (`action: read|write`)
- **`recording`** ← `recording_start/stop/status/list` (`action`)
- **`computer`** ← `computer_list/switch/register/remove` (`action`, `id`)
- **`key {duration}`** ← `hold_key`

All 19 wire names remain callable as aliases: resolution runs before every gate
(required args, kill switch, routing), so a merged call and its alias enforce
identical policy, and `run_actions` steps accept either. Validation the wire
schemas cannot express (which action, what each action requires) fails as
`bad_args` naming the tool the caller asked for.

Verification: `npm test` 301 tests — 286 pass / 0 fail / 15 platform-skipped
(8 new in `tests/tool-merge.test.mjs`), including that a merged call and its
wire alias produce identical refusals and that aliases never appear in
`tools/list`.

## 0.6.2 — context diet, focus accounting, and a menu route

- **The skill travels with the server.** The existing operating guide gains
  `references/quick-reference.md` (every tool on one page, plus recipes) and
  `references/refusal-codes.md` (fail-closed codes and the move that fixes
  each), and the whole pack is now served as MCP resources: `resources/list`,
  `resources/read`, and `skills/list` / `skills/get` with a sha256 manifest
  (`skill://codewhale-cu/SKILL.md`). Guidance is read once per session
  instead of being re-stated in receipts.
- **Tools advertise MCP annotations** (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`) so hosts can build approval and sandbox
  policy without guessing from prose.
- **`list_apps` defaults to regular apps.** The 22 KB process soup (XPC
  helpers, menu-bar extras, CLI children) is now opt-in with `all:true`; the
  default list is the apps a person would name. A helper that predates the
  new `activation_policy` field still returns the full list rather than
  hiding everything.
- **`invoke_menu` activates menu items by title path through accessibility
  alone** — no key events, no focus lease. App-level commands (New, Save,
  Quit) are exact; window-targeted items (Close) can validate against a key
  window a background app does not have and legitimately no-op, so the
  reference points those at the window's close-button element. Disabled items
  are refused (`menu_item_disabled`) instead of pressed; exact titles only,
  and each level is polled because menus expose items only while open.
- **Focus accounting is honest.** A window-record lease is skipped entirely
  when the target app is already frontmost (the swap would be a no-op);
  leases that *are* taken report `front_restored`, and a failed restore says
  so in the receipt — the person's menu bar must never silently stay where
  they did not put it. Restore re-asserts for up to one second.
- **The chord hedge note is gone.** A process-delivered chord now says what
  happened (`process delivery (no focus lease was taken)`) instead of
  speculating about failure.
- **Stale helpers are named.** When the running helper reports a different
  version than the plugin, `request_access` marks `app.stale` and says which
  restart fixes it — instead of letting an agent debug a build that is not
  running.
- **Native refusals map to stable codes** (`window_ambiguous`,
  `window_not_capturable`, `window_target_not_found`, `app_not_found`) for
  programmatic branching; the `get_app_state` note is shorter.

Verification: `npm test` 293 tests — 278 pass / 0 fail / 15 platform-skipped
(10 new in `tests/mcp-skills.test.mjs`); native helper compiles clean under
`-DCU_TEST=1`.

## 0.6.1 — concurrent-use hardening and honest chord delivery

Dogfooding while a person used the same Mac surfaced four defects; all are
fixed and re-verified live on macOS 26.1 (TextEdit, background mode):

- **Missing arguments no longer crash or reach the helper.** The server now
  enforces each tool schema's `required` fields before dispatch, so a bare
  `left_mouse_down`/`select_text`/`key`/`hold_key`/… call returns a
  structured `bad_args` receipt instead of a `TypeError` ("Cannot read
  properties of undefined") or an opaque native error (`-25205`). Schemas
  themselves were corrected too: `left_mouse_down` and `select_text` now
  declare `required:["target"]`, and `set_value`/`select_text`/
  `perform_action` accept element targets only — a coordinate there never
  worked and now fails `bad_target` at the boundary. Backend handlers got
  matching null-guards for direct/agent call paths.
- **`key` modifier chords actually fire in background mode.** `cmd+w`,
  `cmd+s` and friends are menu key equivalents that only validate against a
  key window; the 0.6.0 process-bound route discarded them while reporting
  `action_sent`. Flagged chords now use the window-record channel when the
  helper supports it (`keyboard_delivery:"window-record"`,
  `front_lease:true` — a momentary no-raise lease, cursor untouched). Live
  check: `cmd+w` closed the target TextEdit document while the user kept
  working. With no focusable window the chord falls back to process
  delivery *and says so* in a receipt note, so a silent no-op is no longer
  reported as success.
- **Stale targets report what actually happened.** A bare element index
  binds the computer's latest observation; the failure message previously
  printed `element 16 of undefined` because it echoed the absent
  `state_id`. Stale/stale-adjacent errors now name the resolved state id
  and app (`element 16 of state s-4 (TextEdit) no longer resolves
  (window_not_found)`) and note that the user or app may have changed it.
- **`open_application` retires cross-app element indices.** Rebinding to a
  different app deletes the computer's latest-observation pointer so a bare
  `index` can't silently address the previous app's tree under a concurrent
  user; the receipt carries a note. Explicit `state_id` pins still resolve
  through their own observation.

Also fixed: `set_value`'s web replacement path sent cmd+a twice — `bg_key`
posts a complete press per call, so the separate down/up calls were
redundant (harmless for select-all, but two front leases).

And the preview panel:

- **Borderless.** The watch panel drops its titlebar and edge chrome — it
  floats as the captured window with rounded corners, still draggable by
  its background, still non-activating. The "Codewhale · app · mode"
  caption is drawn inside the view instead of the titlebar. Close it with
  `preview(enabled:false)` or the control panel.
- **The user's real cursor is drawn too.** Each refresh now passes the
  hardware pointer position through `preview_notify`; the panel draws a
  white "you" arrow next to the cyan "Codewhale" agent arrow, both in the
  same window-relative space, so a person working alongside the agent can
  see where their cursor actually is relative to the controlled window.

Verification: `npm test` 268 pass / 0 fail / 15 platform-skipped (8 new
regression tests); `node scripts/check-receipts.mjs docs parity/results`
clean; live MCP dogfood against the installed 0.6.0 helper (direct mode,
`CODEWHALE_CU_APP=off`) exercised malformed args, background chords, stale
elements and app-switch eviction. No native-helper changes — the running
0.6.0 helper already speaks `bg_key`/`window_record`.

## 0.6.0 — window-routed background pointer and web-area traversal

- **Background mouse input now reaches AppKit views without touching the
  user's cursor.** Process-directed mouse events (`CGEventPostToPid`) never
  reach AppKit, and posting to the HID tap moves the real cursor. The
  production route addresses each event to the target window id (event fields
  `0x33`/`0x5b`/`0x5c`) with a window-space location
  (`CGEventSetWindowLocation`) and posts it as its raw event record through
  `SLPSPostEventRecordTo`. Measured on macOS 26.1: view-level delivery
  requires the window to be *key* — the window-focus record alone makes it
  only *main* (events arrive and are swallowed) — so the helper takes a
  momentary front-process lease with no-windows options and restores it in
  `@finally`, re-asserting the previous app through the Accessibility grant
  when the restore lags. Every receipt reports `front_lease` truthfully.
  - Coordinate `left_click`/`double_click`/`triple_click`/
    `right_click`/`middle_click` on a point with no pressable AX element and
    `left_click_drag` now deliver in background mode instead of refusing
    with `shared_pointer_required`. Delivery is by window id to a window
    owned by the bound app, so events cannot land on a covering window.
  - **Menus survive the flow.** A menu opened by a background click closes
    the moment the lease ends, so menu-opening clicks hold the lease across
    calls (state file + 15 s watchdog + restore at the next raw-input call,
    and only while the target is still frontmost). Web popup buttons report
    unpressable so they get a real click — `AXPress` does not open the
    native menu — and the helper polls for the menu through Chromium's
    post-activation AX rebuild. Observes poll for menu items while a menu
    lease is held.
  - **Wheel scrolling uses pixel units.** Chromium ignores line-unit wheel
    events entirely (measured); one notch now maps to 40 px.
  - **Astral-plane typing works in occluded windows.** The WindowServer
    drops key translation for covered windows, losing surrogate-pair
    graphemes (measured: "héllo wörld 日本 🐳" → "héllo wörld 日本 "). Any
    multi-unit grapheme now routes the whole keystream through the record
    channel under one lease; receipts say `keyboard_delivery:"window-record"`.
  - **Activation repaired.** `open_application(activate:true)` uses the
    WindowServer front-process channel (options 0x200) with the AXFrontmost
    fallback, and the confirmation wait pumps the run loop — a one-shot
    helper otherwise reads a stale NSWorkspace answer for seconds.
  - **`set_value` covers web text fields.** Direct `AXValue` writes are
    still refused (Chromium ignores or coerces them), but the backend now
    answers with the replacement path instead of an instruction: focus,
    select-all through the window-record channel (menu key equivalents need
    a key window — new `bg_key` primitive), type, read-back verify.
    Receipts say `strategy:"focus-type-replace"` with `verified` from the
    control's own value — the last capability kimi-cu held over us.
  - **Observation rides out Chromium's a11y rebuilds.** Windows that vend
    zero content are rebuilt-tree states, not empty pages: unfiltered
    observes poll up to 2.4 s (longer while a menu lease is held) before
    returning. Filtered observes are exempt — an empty match is a legitimate
    answer.
  - Live receipts (macOS 26.1): full parity suite 28/28 tasks × 5 reps —
    background drag to a drop zone, `<select>` popup open + pick, native
    file-picker upload, emoji into a fully occluded window — with the real
    cursor position unchanged across every gesture and the operator's
    foreground restored.

The plugin could not see inside browser pages: `get_app_state` on Chrome
returned the toolbar and tab strip but never descended into `AXWebArea`, so
every control on the page was invisible to observe, target and verify. This
version fixes the blindness and the interaction-model friction around it,
matching the behavior kimi-cu demonstrated while keeping Codewhale's
receipts, batching, clipboard, preview and remote-computer surfaces.

- **macOS observation now unlocks web content.** The backend sets
  `AXEnhancedUserInterface` + `AXManualAccessibility` on target app
  elements before walking, so Chrome/Electron `AXWebArea` subtrees vend
  their DOM. Traversal budgets grow to depth 16 / 900 elements for
  summaries and depth 24 / 1600 for `detail:"full"` and `query`/`role`
  filtered observes — a filtered find can now reach deeply nested web
  controls. An `AXWebArea` that arrives with no descendants (page still
  populating) triggers one 200 ms re-observation before returning.
- **`state_id` is optional on element targets.** `{type:"element", index}`
  binds the computer's latest observation — observe, then act on the flat
  index, kimi-style. Passing `state_id` pins a specific earlier snapshot
  (e.g. one returned by `wait_for`). Live-tree revalidation,
  `element_stale`, `state_wrong_computer` and `target_reacquired` receipts
  are unchanged.
- **Degenerate-frame refusal.** Acting on a zero-size element — collapsed
  placeholder rows vended by virtualized lists (`13x0`, `734x1`) — fails
  `degenerate_frame` telling the caller to scroll the row into view and
  re-observe, instead of pressing a phantom rect.
- **`set_value` handles numeric controls honestly.** `AXIncrementor`,
  `AXSlider`, `AXStepper`, `AXValueIndicator` and `AXProgressIndicator`
  receive an `NSNumber` parsed with a POSIX `NSNumberFormatter`; a
  non-numeric string fails before dispatch with a focus-then-type
  instruction (previously a string write could clear the control). The
  value is read back and reported as `verified`. Elements under
  `AXWebArea` refuse `set_value` before dispatch entirely — Chromium
  accepts `AXValue` sets and then ignores them, or a numeric control
  coerces the write to empty — with an instruction to `focus` the
  element and `type` instead.
- **Web-area typing uses real key events.** `type` skips the
  `AXSelectedText` semantic path for elements under `AXWebArea`
  (Chromium accepts the write and drops it) and sends process-bound
  unicode events after accessibility focus — still no pointer movement,
  still verified against the control's own value.
- **The preview panel is on by default** while an app is bound: a
  nonactivating mini view of the captured app window with the agent
  cursor drawn at each action's target — element-targeted actions update
  it too, not just pointer gestures. The real pointer never moves;
  `preview(enabled:false)` mutes it for the session.
- **Source installs reuse the signed helper.** When the plugin runs from
  a plain checkout (Kimi Code and other hosts' plugin dirs), the backend
  now prefers `~/Applications/Codewhale Computer Use.app`'s signed helper
  over compiling an unsigned one — so accessibility and screen-recording
  grants carry over instead of re-prompting or silently failing.

Live spot check on the maintainer Mac (macOS 26.1, arm64): real Chrome on
a long ChatGPT page yields ~750 elements to depth 24 including the composer
`AXTextArea`; the same call before the change returned ~85 browser-chrome
elements. An OCI-style create-instance form driven end-to-end through the
installed app — background, flat indices, no pointer movement — typed the
name field (`verified:true`), pressed the radio, refused the web
incrementor, filled the textarea and produced `created:<name>`. The real
OCI wizard (`cloud.oracle.com/compute/instances/create`) still wants its
own receipt before the `docs/LIMITATIONS.md` rows change.

Source suite: 260 passed, 0 failed, 15 platform skips (`npm test`);
Objective-C helper compiles clean in normal and `CU_TEST` builds.

## 0.5.0 — stateful waits and persistent SSH sessions

The workflows that burned observe→wait→observe round-trips on dynamic UI now
have a first-class wait, and SSH remotes are no longer one-shot-per-call.

- `wait_for` polls the accessibility tree until a `query`/`role` match
  appears (`state:"present"`, the default) or disappears
  (`state:"absent"` — dialogs dismissed, spinners finished). Intermediate
  polls are ephemeral so they cannot evict the states you already hold or be
  targeted by accident; the satisfying observation is rebound and returned as
  a fresh `state_id` with its matched elements, ready to act on. Timeouts
  return an honest `timed_out:true` receipt rather than throwing, and
  cancellation / stop / computer-switch abort immediately.
- `type` and `key` accept an element `target` from `get_app_state`: the
  element is revalidated and accessibility-focused first, then the text or
  key is sent — the documented focus-then-act idiom in one call. If the
  element went stale, the call fails closed at `stage:"focus"` and no
  keystrokes are sent.
- `recording_start` accepts `app_ref`/`window_id` on macOS to crop the
  recording to that window's rect at start (it does not follow later moves),
  picking the display the window lives on.
- `recording_list` on macOS now returns `.jpg`/`.jpeg` files — screenshots
  saved by the system default JPEG format were previously invisible.
- `agent.mjs --serve` runs the SSH remote agent as a persistent session over
  one connection, so `open_application` bindings and session-owned input
  survive between calls instead of dying with each request. The server uses
  it automatically, falls back to one-shot mode for an older pushed agent,
  and fails closed after a channel restart until the remote app is rebound
  and re-observed — requests that may have run remotely before a timeout or
  disconnect are marked `requestDispatched` rather than silently retried.

Source suite at commit `b25f11c8673667329af2d9172aa57b153b9cc49d`:
258 passed, 0 failed, 15 platform skips (`npm test`); live smoke on the
maintainer Mac 23/23.

0.5.0 is a Developer ID-signed, notarized universal macOS build from commit
b25f11c8673667329af2d9172aa57b153b9cc49d, with its packaging receipt in
[docs/releases/0.5.0.json](docs/releases/0.5.0.json). It was published on
2026-09-15 (PDT) as the [v0.5.0 GitHub release](https://github.com/Hmbown/codewhale-cu-plugin/releases/tag/v0.5.0);
the setup page at https://codewhale.net/computer-use offers the download and
**Check for updates…** in an installed 0.4.0 app offers it.

## 0.4.0 — AX primitives

The session that tried to send a WeChat message could not press Return, could
not read a truncated tree, and had no click path for a non-AXPressable
control. This version adds those primitives without weakening the
shared-pointer gate.

- `type` treats newlines and `press_enter` as Return/Enter instead of
  inserting a literal character (the WeChat composer U+FFFC failure).
- `key` remains the named key-press tool (`return`, `backspace`, chords).
- `get_app_state` filters (`query`, `role`), paginates (`limit`, `offset`),
  and truncates oversized dumps instead of eating the middle of the JSON.
  `detail:"compact"` is actually smaller. `find_elements` searches a cached
  `state_id`.
- `focus` and `get_value` act on observed elements; text-field values stay
  in the state dump.
- Accessibility clicks will focus a field that exposes AXFocused even when
  it is not AXPressable (Qt search boxes).
- `strategy:"app"` is the missing middle: a pointer event allowed only when
  the point is inside the bound app's window, then the cursor is restored.
  `strategy:"event"` still requires shared-desktop authorization.
- Coordinate targets accept `space:"screen"` so AX screen points do not need
  a hand conversion through the latest raster.
- `ocr_region` limits OCR to a screen rect. `run_actions` batches up to 8
  steps.
- Receipts no longer tell the model to use tools that are not in this
  catalog.

0.4.0 is a Developer ID-signed, notarized universal macOS build from commit 249ae77fad9162c2af11d5460d91b2b5b909c06c, with its packaging receipt in [docs/releases/0.4.0.json](docs/releases/0.4.0.json). Source suite at that commit: 245 passed, 0 failed, 15 platform skips. It was published on 2026-09-13 (PDT) as the [v0.4.0 GitHub release](https://github.com/Hmbown/codewhale-cu-plugin/releases/tag/v0.4.0); the setup page at https://codewhale.net/computer-use offers the download and **Check for updates…** in an installed 0.3.1 app offers it.

0.3.1 is the first public macOS build: a Developer ID-signed, notarized universal app built from commit 9f6c39f738c0d8e8dcc93af11af5e00d19081b60, with its packaging receipt in [docs/releases/0.3.1.json](docs/releases/0.3.1.json). It was published on 2026-09-13 as the [v0.3.1 GitHub release](https://github.com/Hmbown/codewhale-cu-plugin/releases/tag/v0.3.1); the setup page at https://codewhale.net/computer-use offers the download. Earlier versions were developed privately; their notes are kept below for context.

## 0.3.1 — macOS beta

- Retire the helper when its menu-bar owner disconnects, so reopening the app
  restores human controls with input still stopped.
- Preserve a replacement helper's socket and run receipt during old-session
  cleanup.
- Show the result of an update after relaunch, including failed installs.
- Report the manifest version to MCP hosts and explain how to repair a missing
  registered app without bypassing it.
- Limit the public plugin host eligibility to macOS. Windows and Linux remain
  experimental source-only backends pending targeting, human controls and
  native qualification.

Qualification record. The public build was produced on 2026-09-13 from commit
`9f6c39f738c0d8e8dcc93af11af5e00d19081b60` (clean `main`); all 33 packaged
runtime files are byte-identical to that commit. The archive
`Codewhale-Computer-Use-0.3.1-macos-universal.zip` (79,720,031 bytes, SHA-256
`76752d33fff60d62b5445452e5a7f21396eb5aace6dbf632fc2a172f75e4720a`) is signed
with "Developer ID Application: Hunter Bown (5RDNSHA5TY)" under the hardened
runtime, is universal (arm64 and x86_64), bundles Node 24.21.0 and requires
macOS 13.5+. Apple notarization submission
`769ff14d-ee5c-4db5-a3b9-f733c2743e6e` was Accepted; the ticket is stapled,
`codesign --verify --deep --strict` passes, and `spctl` accepts the app with
source "Notarized Developer ID". The source suite at that commit passes
(240 passed, 0 failed, 15 platform skips). The build scripts ran with Node
v25.8.0 on the maintainer Mac; hosted CI pins Node 22. Later on 2026-09-13 the
drag-to-Applications disk image
`Codewhale-Computer-Use-0.3.1-macos-universal.dmg` (88,246,026 bytes, SHA-256
`91491faa6d44b8e4b52113fea1831c07c402fdd8f673323c8125468d0d89be3a`) was built
from that same stapled app by `scripts/package-dmg.mjs`, signed, notarized
(submission `a24464ec-f3ed-4670-b873-fcacb8a1bef3` Accepted), stapled and
added to the v0.3.1 release as the human download; the archive is unchanged
and remains the updater's input. Earlier on the same
Mac, a signed 0.3.1 candidate passed the menu-bar owner crash and reopen check
with isolated state, and the updater's apply step replaced an installed
notarized 0.3.0 with that notarized 0.3.1 build, kept the previous bundle and
restarted with controls stopped.

Still open, recorded as open and not as done: a clean-machine install with
fresh Accessibility and Screen Recording grants; a model-driven task through
an installed Codewhale Engine; the non-admin Applications-directory update;
and the real post-publication **Check for updates…** path from an installed
older notarized build. See
[docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md).

## 0.3.0 — notarized locally, never published

- Whale-and-pointer identity with light, dark, small and monochrome assets.
- Marketplace artwork, publisher and host-platform labels.
- macOS menu-bar setup with live Accessibility and Screen Recording status.
- A disposable background edit-and-capture check with an observed result.
- Live app/mode status, Pause and Stop. Pausing cancels active and queued
  input; stopped sessions stay invalid after new sessions are allowed.
- Installed-helper routing takes precedence over embedded binaries and fails
  closed when the helper is unavailable.
- Self-contained macOS packaging with a pinned universal Node runtime,
  notarization gates and verified updates that preserve the prior install.

Native panel and updater: macOS 13.5+. Other host platforms retain their
existing MCP setup. The 0.3.0 universal archive was Developer ID signed and
accepted by Apple notarization (record in
[docs/releases/0.3.0.json](docs/releases/0.3.0.json)) and installed on one
Mac, but it was never published as a release. Source availability alone is not
a notarization verdict.

## 0.2.2

Background field focus, text selection, accessibility scrolling and context
menus on macOS. Default observations follow the selected app. Foreground
gestures stop when the user changes apps instead of reclaiming focus.
