# Parity matrix — linux-xvfb (isolated)

- commit: `4f597edf8bf6f4ce63a2f179aeea1da8b1aea6e1`
- node v22.22.0; linux 6.18.44-fc-v114; display `:99` geometry 1600 1200
- suite: `parity/tasks.json`; chrome: Chromium 141.0.7390.37; python3: Python 3.12.3; tk: 8.6
- date: 2026-10-11T20:36:21.144Z; repeats: 5
- Codex baseline: untested (no codex results)

| task | issue | Codewhale | Codex | status | median elapsed | median tool calls | pointer displacement | foreground | notes |
|---|---|---|---|---|---|---|---|---|---|
| browser.download | #2 | 5/5 | untested | demonstrated | 17536ms | 2 | 0px | preserved | - |
| browser.drag_drop | #2 | 0/5 | untested | untested | 0ms | 0 | 0px | preserved | skipped: held-input gestures require a persistent input owner — the desktop helper or the · known limitation: the direct route has no input owner and refuses left_click_drag (input_owner_required) by design; run with --helper to drive the Linux desktop helper, which owns held input. |
| browser.dynamic_content | #2 | 5/5 | untested | demonstrated | 49615ms | 4 | 0px | preserved | known limitation: reps right after a fixture relaunch raced the oracle: the window mapped before Chromium published the CU-FIXTURE title state, so the first expect sampled nulls (observed 2026-09-16 as 1/5 then 2/5 fails across two runs). The X11 driver now waits for a readable oracle state before launchFixture returns; kept as a note on what the wait is for. |
| browser.element_click | #2 | 5/5 | untested | demonstrated | 18159ms | 2 | 0px | preserved | optional_a11y |
| browser.form_submit | #2 | 5/5 | untested | demonstrated | 3791ms | 9 | 0px | preserved | - |
| browser.iframe_click | #2 | 5/5 | untested | demonstrated | 17601ms | 2 | 0px | preserved | - |
| browser.modifiers | #3 | 5/5 | untested | demonstrated | 18038ms | 4 | 0px | preserved | - |
| browser.outside_raster_fails | #4 | 5/5 | untested | demonstrated | 2062ms | 3 | 0px | preserved | - |
| browser.scroll_reveal | #2 | 5/5 | untested | demonstrated | 4241ms | 3 | 0px | preserved | - |
| browser.stale_element | #2 | 5/5 | untested | demonstrated | 19354ms | 3 | 0px | preserved | optional_a11y |
| browser.tabs | #2 | 5/5 | untested | demonstrated | 3044ms | 4 | 0px | preserved | - |
| browser.unicode_type | #3 | 5/5 | untested | demonstrated | 18097ms | 3 | 0px | preserved | known limitation: non-ASCII chars go through per-char `key U<hex>` (deterministic case fix), but under heavy host load XTEST can still drop a remapped char — observed 2026-09-16 as a single missing é/日 in ~1/5 reps. A delivery-layer flake on a loaded container, not a mapping defect; a starved Xvfb run is exactly where it shows. |
| browser.upload | #2 | 5/5 | untested | demonstrated | 5774ms | 5 | 0px | preserved | known limitation: Chromium's GTK file chooser commits a typed location-entry path only via the Open button — Return in the entry closes the dialog with no selection (a stock GTK3 FileChooserDialog commits the same path on Return, so this is Chromium's wrapper). The dialog also carries no AT-SPI elements, so only a window-relative pointer click reaches it. |
| browser.zoom_click | #4 | 5/5 | untested | demonstrated | 17658ms | 3 | 0px | preserved | - |
| control.cancellation | #6 | 5/5 | untested | demonstrated | 3957ms | 2 | 0px | preserved | - |
| control.permission_denied | #6 | 5/5 | untested | demonstrated | 147ms | 2 | 0px | preserved | - |
| control.reconnect_no_replay | #6 | 5/5 | untested | demonstrated | 2335ms | 4 | 0px | preserved | - |
| control.stop_blocks_actions | #6 | 5/5 | untested | demonstrated | 1932ms | 3 | 0px | preserved | - |
| native.drag_square | #3 | 0/5 | untested | untested | 0ms | 0 | 0px | preserved | skipped: held-input gestures require a persistent input owner — the desktop helper or the · known limitation: the direct route has no input owner and refuses left_click_drag (input_owner_required) by design; run with --helper to drive the Linux desktop helper, which owns held input. |
| native.entry_apply | #3 | 5/5 | untested | demonstrated | 1866ms | 4 | 0px | preserved | - |
| native.list_scroll_select | #3 | 5/5 | untested | demonstrated | 2204ms | 3 | 0px | preserved | - |
| native.menu_command | #3 | 5/5 | untested | demonstrated | 2247ms | 4 | 0px | preserved | - |
| native.modal_dialog | #3 | 0/5 | untested | missing | 6103ms | 7 | 0px | preserved | fail: step10 expect {"path":"dialog","equals":"closed"} never held; last={"entry":"blocked","applied":"","menu":[],"selected": · known limitation: Tk's simpledialog is toolkit-modal only: it sets WM_TRANSIENT_FOR + grab_set but no _NET_WM_STATE_MODAL, so a stacking WM lets the parent Apply click take X input focus (verified under openbox and metacity). The grab still blocks the click (applied stays empty) but the typed answer then goes to the parent and the dialog stays open. Passes where the WM keeps focus on the transient. |
| native.modifiers | #3 | 5/5 | untested | demonstrated | 17036ms | 3 | 0px | preserved | - |
| native.second_window | #3 | 5/5 | untested | demonstrated | 2476ms | 4 | 0px | preserved | - |
| native.select_text | #3 | 5/5 | untested | demonstrated | 16899ms | 2 | 0px | preserved | - |
| native.unicode_type | #3 | 5/5 | untested | demonstrated | 2178ms | 4 | 0px | preserved | known limitation: per-char `key U<hex>` + `shift+` for cased capitals fixes the level-0 lowercase remap (Ü→ü). Residual: under heavy host load XTEST can still drop a remapped char — an X11 delivery characteristic, not a mapping defect. |

# Parity matrix — linux-xvfb (isolated, desktop helper)

- commit: `4f597edf8bf6f4ce63a2f179aeea1da8b1aea6e1`
- node v22.22.0; linux 6.18.44-fc-v114; display `:99` geometry 1600 1200
- suite: `parity/tasks.json`; chrome: Chromium 141.0.7390.37; python3: Python 3.12.3; tk: 8.6
- date: 2026-10-11T20:55:50.612Z; repeats: 5
- Codex baseline: untested (no codex results)

| task | issue | Codewhale | Codex | status | median elapsed | median tool calls | pointer displacement | foreground | notes |
|---|---|---|---|---|---|---|---|---|---|
| browser.download | #2 | 5/5 | untested | demonstrated | 17587ms | 2 | 0px | preserved | - |
| browser.drag_drop | #2 | 5/5 | untested | demonstrated | 2563ms | 2 | 0px | preserved | known limitation: the direct route has no input owner and refuses left_click_drag (input_owner_required) by design; run with --helper to drive the Linux desktop helper, which owns held input. |
| browser.dynamic_content | #2 | 5/5 | untested | demonstrated | 49557ms | 4 | 0px | preserved | known limitation: reps right after a fixture relaunch raced the oracle: the window mapped before Chromium published the CU-FIXTURE title state, so the first expect sampled nulls (observed 2026-09-16 as 1/5 then 2/5 fails across two runs). The X11 driver now waits for a readable oracle state before launchFixture returns; kept as a note on what the wait is for. |
| browser.element_click | #2 | 5/5 | untested | demonstrated | 18182ms | 2 | 0px | preserved | optional_a11y |
| browser.form_submit | #2 | 5/5 | untested | demonstrated | 3868ms | 9 | 0px | preserved | - |
| browser.iframe_click | #2 | 5/5 | untested | demonstrated | 17514ms | 2 | 0px | preserved | - |
| browser.modifiers | #3 | 5/5 | untested | demonstrated | 18073ms | 4 | 0px | preserved | - |
| browser.outside_raster_fails | #4 | 5/5 | untested | demonstrated | 2139ms | 3 | 0px | preserved | - |
| browser.scroll_reveal | #2 | 5/5 | untested | demonstrated | 4277ms | 3 | 0px | preserved | - |
| browser.stale_element | #2 | 5/5 | untested | demonstrated | 19368ms | 3 | 0px | preserved | optional_a11y |
| browser.tabs | #2 | 5/5 | untested | demonstrated | 3067ms | 4 | 0px | preserved | - |
| browser.unicode_type | #3 | 5/5 | untested | demonstrated | 18166ms | 3 | 0px | preserved | known limitation: non-ASCII chars go through per-char `key U<hex>` (deterministic case fix), but under heavy host load XTEST can still drop a remapped char — observed 2026-09-16 as a single missing é/日 in ~1/5 reps. A delivery-layer flake on a loaded container, not a mapping defect; a starved Xvfb run is exactly where it shows. |
| browser.upload | #2 | 5/5 | untested | demonstrated | 5790ms | 5 | 0px | preserved | known limitation: Chromium's GTK file chooser commits a typed location-entry path only via the Open button — Return in the entry closes the dialog with no selection (a stock GTK3 FileChooserDialog commits the same path on Return, so this is Chromium's wrapper). The dialog also carries no AT-SPI elements, so only a window-relative pointer click reaches it. |
| browser.zoom_click | #4 | 5/5 | untested | demonstrated | 17654ms | 3 | 0px | preserved | - |
| control.cancellation | #6 | 5/5 | untested | demonstrated | 3933ms | 2 | 0px | preserved | - |
| control.permission_denied | #6 | 0/5 | untested | untested | 0ms | 0 | 0px | preserved | skipped: on the helper route the desktop helper owns the display session, so emptying the |
| control.reconnect_no_replay | #6 | 5/5 | untested | demonstrated | 2293ms | 4 | 0px | preserved | - |
| control.stop_blocks_actions | #6 | 5/5 | untested | demonstrated | 2006ms | 3 | 0px | preserved | - |
| native.drag_square | #3 | 5/5 | untested | demonstrated | 1809ms | 2 | 0px | preserved | known limitation: the direct route has no input owner and refuses left_click_drag (input_owner_required) by design; run with --helper to drive the Linux desktop helper, which owns held input. |
| native.entry_apply | #3 | 5/5 | untested | demonstrated | 1834ms | 4 | 0px | preserved | - |
| native.list_scroll_select | #3 | 5/5 | untested | demonstrated | 2161ms | 3 | 0px | preserved | - |
| native.menu_command | #3 | 5/5 | untested | demonstrated | 2211ms | 4 | 0px | preserved | - |
| native.modal_dialog | #3 | 0/5 | untested | missing | 6064ms | 7 | 0px | preserved | fail: step10 expect {"path":"dialog","equals":"closed"} never held; last={"entry":"blocked","applied":"","menu":[],"selected": · known limitation: Tk's simpledialog is toolkit-modal only: it sets WM_TRANSIENT_FOR + grab_set but no _NET_WM_STATE_MODAL, so a stacking WM lets the parent Apply click take X input focus (verified under openbox and metacity). The grab still blocks the click (applied stays empty) but the typed answer then goes to the parent and the dialog stays open. Passes where the WM keeps focus on the transient. |
| native.modifiers | #3 | 5/5 | untested | demonstrated | 17003ms | 3 | 0px | preserved | - |
| native.second_window | #3 | 5/5 | untested | demonstrated | 2485ms | 4 | 0px | preserved | - |
| native.select_text | #3 | 5/5 | untested | demonstrated | 16847ms | 2 | 0px | preserved | - |
| native.unicode_type | #3 | 5/5 | untested | demonstrated | 2232ms | 4 | 0px | preserved | known limitation: per-char `key U<hex>` + `shift+` for cased capitals fixes the level-0 lowercase remap (Ü→ü). Residual: under heavy host load XTEST can still drop a remapped char — an X11 delivery characteristic, not a mapping defect. |

# Parity matrix — darwin-aqua

- commit: `f1cceb105177d8eb67bc191878de7885e10cd06f`; date: 2026-09-15T15:53:38.719Z
- rendered from the committed summary `parity/results/darwin-aqua-2026-09-15.json` (run recorded on another host)

| task | issue | Codewhale | status | median elapsed | median tool calls | pointer displacement | notes |
|---|---|---|---|---|---|---|---|
| browser.download | #2 | 5/5 | demonstrated | 2243ms | 2 | 0px | - |
| browser.drag_drop | #2 | 5/5 | demonstrated | 4197ms | 2 | 0px | - |
| browser.dynamic_content | #2 | 5/5 | demonstrated | 3533ms | 4 | 0px | - |
| browser.element_click | #2 | 5/5 | demonstrated | 2140ms | 2 | 0px | optional_a11y |
| browser.form_submit | #2 | 5/5 | demonstrated | 4996ms | 8 | 0px | - |
| browser.iframe_click | #2 | 5/5 | demonstrated | 2291ms | 2 | 0px | - |
| browser.modifiers | #3 | 5/5 | demonstrated | 2545ms | 4 | 0px | - |
| browser.outside_raster_fails | #4 | 5/5 | demonstrated | 2120ms | 3 | 0px | - |
| browser.scroll_reveal | #2 | 5/5 | demonstrated | 4044ms | 3 | 0px | - |
| browser.stale_element | #2 | 5/5 | demonstrated | 3188ms | 3 | 0px | optional_a11y |
| browser.tabs | #2 | 5/5 | demonstrated | 2717ms | 4 | 0px | - |
| browser.unicode_type | #3 | 5/5 | demonstrated | 2861ms | 3 | 0px | - |
| browser.upload | #2 | 5/5 | demonstrated | 17262ms | 11 | 0px | - |
| browser.zoom_click | #4 | 5/5 | demonstrated | 2310ms | 3 | 0px | - |
| control.cancellation | #6 | 5/5 | demonstrated | 4156ms | 2 | 0px | - |
| control.permission_denied | #6 | 5/5 | demonstrated | 367ms | 2 | 0px | - |
| control.reconnect_no_replay | #6 | 5/5 | demonstrated | 2329ms | 4 | 0px | - |
| control.stop_blocks_actions | #6 | 5/5 | demonstrated | 2098ms | 3 | 0px | - |
| native.drag_square | #3 | 5/5 | demonstrated | 3919ms | 2 | 0px | - |
| native.entry_apply | #3 | 5/5 | demonstrated | 2591ms | 4 | 0px | - |
| native.list_scroll_select | #3 | 5/5 | demonstrated | 2184ms | 3 | 0px | - |
| native.menu_command | #3 | 5/5 | demonstrated | 2811ms | 4 | 0px | - |
| native.modal_dialog | #3 | 5/5 | demonstrated | 5464ms | 7 | 0px | - |
| native.modifiers | #3 | 5/5 | demonstrated | 2285ms | 3 | 0px | - |
| native.second_window | #3 | 5/5 | demonstrated | 3199ms | 4 | 0px | - |
| native.select_text | #3 | 5/5 | demonstrated | 3306ms | 2 | 0px | - |
| native.unicode_type | #3 | 5/5 | demonstrated | 2550ms | 4 | 0px | - |

## Platforms

| surface | status |
|---|---|
| macOS Retina | untested — see docs/LIMITATIONS.md |
| macOS non-Retina | untested — see docs/LIMITATIONS.md |
| macOS mixed | untested — see docs/LIMITATIONS.md |
| Linux X11 | 24/27 tasks demonstrated at 5 repeats (linux-xvfb (isolated), 2026-10-11); separate run: 25/27 tasks demonstrated at 5 repeats (linux-xvfb (isolated, desktop helper), 2026-10-11) |
| Wayland | untested — see docs/LIMITATIONS.md |
| Windows | untested — see docs/LIMITATIONS.md |
| HarmonyOS (hdc) | untested — see docs/LIMITATIONS.md |
| SSH remote | untested — see docs/LIMITATIONS.md |
| Codex / Claude Desktop fresh session | untested — see docs/LIMITATIONS.md |
| signed-update permission persistence | untested — see docs/LIMITATIONS.md |
