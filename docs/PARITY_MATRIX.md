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

# Parity matrix — linux-x11

- commit: `da7dfb53449de4777ff18ddf2df3f65738f6333f`
- node v22.22.0; linux 6.18.44-fc-v114; display `:0` geometry 1440 900
- suite: `parity/tasks.json`; chrome: Chromium 141.0.7390.37; python3: Python 3.12.3; tk: 8.6
- date: 2026-10-11T21:16:45.908Z; repeats: 5
- Codex baseline: untested (no codex results)

| task | issue | Codewhale | Codex | status | median elapsed | median tool calls | pointer displacement | foreground | notes |
|---|---|---|---|---|---|---|---|---|---|
| browser.download | #2 | 5/5 | untested | demonstrated | 17518ms | 2 | 0px | taken 5/5 | - |
| browser.drag_drop | #2 | 0/5 | untested | untested | 0ms | 0 | 0px | preserved | skipped: held-input gestures require a persistent input owner — the desktop helper or the · known limitation: the direct route refuses left_click_drag (input_owner_required) by design; run with --helper to drive the Linux desktop helper, which owns held input. |
| browser.dynamic_content | #2 | 5/5 | untested | demonstrated | 49612ms | 4 | 0px | taken 5/5 | - |
| browser.element_click | #2 | 5/5 | untested | demonstrated | 18219ms | 2 | 0px | taken 5/5 | optional_a11y |
| browser.form_submit | #2 | 5/5 | untested | demonstrated | 3911ms | 9 | 0px | taken 5/5 | - |
| browser.iframe_click | #2 | 5/5 | untested | demonstrated | 17508ms | 2 | 0px | taken 5/5 | - |
| browser.modifiers | #3 | 5/5 | untested | demonstrated | 18061ms | 4 | 0px | taken 5/5 | - |
| browser.outside_raster_fails | #4 | 5/5 | untested | demonstrated | 2100ms | 3 | 0px | preserved | - |
| browser.scroll_reveal | #2 | 5/5 | untested | demonstrated | 4168ms | 3 | 0px | taken 5/5 | - |
| browser.stale_element | #2 | 5/5 | untested | demonstrated | 19351ms | 3 | 0px | taken 5/5 | optional_a11y |
| browser.tabs | #2 | 5/5 | untested | demonstrated | 2999ms | 4 | 0px | taken 5/5 | - |
| browser.unicode_type | #3 | 4/5 | untested | partial | 18149ms | 3 | 0px | taken 5/5 | fail: step3 expect {"path":"uni","equals":"héllo wörld 日本 🐳"} never held; last={"name":"","agree":false,"color":"","submitted |
| browser.upload | #2 | 5/5 | untested | demonstrated | 5768ms | 5 | 0px | taken 5/5 | known limitation: same Chromium chooser behavior: type the path, then click Open; Return in the location entry discards it. On desktops where xdg-desktop-portal supplies the chooser instead, the dialog is a different application entirely and this window_title target will not resolve — record that honestly if it shows. |
| browser.zoom_click | #4 | 5/5 | untested | demonstrated | 17670ms | 3 | 0px | taken 5/5 | - |
| control.cancellation | #6 | 5/5 | untested | demonstrated | 3938ms | 2 | 0px | preserved | - |
| control.permission_denied | #6 | 5/5 | untested | demonstrated | 151ms | 2 | 0px | preserved | - |
| control.reconnect_no_replay | #6 | 5/5 | untested | demonstrated | 2350ms | 4 | 0px | preserved | - |
| control.stop_blocks_actions | #6 | 5/5 | untested | demonstrated | 2023ms | 3 | 0px | preserved | - |
| native.drag_square | #3 | 0/5 | untested | untested | 0ms | 0 | 0px | preserved | skipped: held-input gestures require a persistent input owner — the desktop helper or the · known limitation: the direct route refuses left_click_drag (input_owner_required) by design; run with --helper to drive the Linux desktop helper, which owns held input. |
| native.entry_apply | #3 | 5/5 | untested | demonstrated | 1859ms | 4 | 0px | taken 5/5 | - |
| native.list_scroll_select | #3 | 5/5 | untested | demonstrated | 2182ms | 3 | 0px | taken 5/5 | - |
| native.menu_command | #3 | 5/5 | untested | demonstrated | 2125ms | 4 | 0px | taken 5/5 | - |
| native.modal_dialog | #3 | 0/5 | untested | missing | 5999ms | 7 | 0px | taken 5/5 | fail: step10 expect {"path":"dialog","equals":"closed"} never held; last={"entry":"blocked","applied":"","menu":[],"selected": · known limitation: KWin does not give the transient Tk dialog X input focus, so typed text does not reach it; passes on the isolated Xvfb route |
| native.modifiers | #3 | 5/5 | untested | demonstrated | 17057ms | 3 | 0px | taken 5/5 | - |
| native.second_window | #3 | 5/5 | untested | demonstrated | 2413ms | 4 | 0px | taken 5/5 | - |
| native.select_text | #3 | 5/5 | untested | demonstrated | 16857ms | 2 | 0px | taken 5/5 | - |
| native.unicode_type | #3 | 5/5 | untested | demonstrated | 2119ms | 4 | 0px | taken 5/5 | - |

# Parity matrix — linux-x11 (desktop helper)

- commit: `da7dfb53449de4777ff18ddf2df3f65738f6333f`
- node v22.22.0; linux 6.18.44-fc-v114; display `:0` geometry 1440 900
- suite: `parity/tasks.json`; chrome: Chromium 141.0.7390.37; python3: Python 3.12.3; tk: 8.6
- date: 2026-10-11T21:36:13.520Z; repeats: 5
- Codex baseline: untested (no codex results)

| task | issue | Codewhale | Codex | status | median elapsed | median tool calls | pointer displacement | foreground | notes |
|---|---|---|---|---|---|---|---|---|---|
| browser.download | #2 | 5/5 | untested | demonstrated | 17554ms | 2 | 0px | taken 5/5 | - |
| browser.drag_drop | #2 | 5/5 | untested | demonstrated | 2568ms | 2 | 0px | taken 5/5 | known limitation: the direct route refuses left_click_drag (input_owner_required) by design; run with --helper to drive the Linux desktop helper, which owns held input. |
| browser.dynamic_content | #2 | 5/5 | untested | demonstrated | 49583ms | 4 | 0px | taken 5/5 | - |
| browser.element_click | #2 | 5/5 | untested | demonstrated | 18367ms | 2 | 0px | taken 5/5 | optional_a11y |
| browser.form_submit | #2 | 5/5 | untested | demonstrated | 3889ms | 9 | 0px | taken 5/5 | - |
| browser.iframe_click | #2 | 5/5 | untested | demonstrated | 17525ms | 2 | 0px | taken 5/5 | - |
| browser.modifiers | #3 | 5/5 | untested | demonstrated | 18119ms | 4 | 0px | taken 5/5 | - |
| browser.outside_raster_fails | #4 | 5/5 | untested | demonstrated | 2118ms | 3 | 0px | preserved | - |
| browser.scroll_reveal | #2 | 5/5 | untested | demonstrated | 4206ms | 3 | 0px | taken 5/5 | - |
| browser.stale_element | #2 | 5/5 | untested | demonstrated | 19420ms | 3 | 0px | taken 5/5 | optional_a11y |
| browser.tabs | #2 | 5/5 | untested | demonstrated | 3027ms | 4 | 0px | taken 5/5 | - |
| browser.unicode_type | #3 | 5/5 | untested | demonstrated | 18122ms | 3 | 0px | taken 5/5 | - |
| browser.upload | #2 | 5/5 | untested | demonstrated | 5761ms | 5 | 0px | taken 5/5 | known limitation: same Chromium chooser behavior: type the path, then click Open; Return in the location entry discards it. On desktops where xdg-desktop-portal supplies the chooser instead, the dialog is a different application entirely and this window_title target will not resolve — record that honestly if it shows. |
| browser.zoom_click | #4 | 5/5 | untested | demonstrated | 17711ms | 3 | 0px | taken 5/5 | - |
| control.cancellation | #6 | 5/5 | untested | demonstrated | 3936ms | 2 | 0px | preserved | - |
| control.permission_denied | #6 | 0/5 | untested | untested | 0ms | 0 | 0px | preserved | skipped: on the helper route the desktop helper owns the display session, so emptying the |
| control.reconnect_no_replay | #6 | 5/5 | untested | demonstrated | 2356ms | 4 | 0px | preserved | - |
| control.stop_blocks_actions | #6 | 5/5 | untested | demonstrated | 2009ms | 3 | 0px | preserved | - |
| native.drag_square | #3 | 5/5 | untested | demonstrated | 1766ms | 2 | 0px | taken 5/5 | known limitation: the direct route refuses left_click_drag (input_owner_required) by design; run with --helper to drive the Linux desktop helper, which owns held input. |
| native.entry_apply | #3 | 5/5 | untested | demonstrated | 1827ms | 4 | 0px | taken 5/5 | - |
| native.list_scroll_select | #3 | 5/5 | untested | demonstrated | 2177ms | 3 | 0px | taken 5/5 | - |
| native.menu_command | #3 | 5/5 | untested | demonstrated | 2132ms | 4 | 0px | taken 5/5 | - |
| native.modal_dialog | #3 | 0/5 | untested | missing | 6077ms | 7 | 0px | taken 5/5 | fail: step10 expect {"path":"dialog","equals":"closed"} never held; last={"entry":"blocked","applied":"","menu":[],"selected": · known limitation: KWin does not give the transient Tk dialog X input focus, so typed text does not reach it; passes on the isolated Xvfb route |
| native.modifiers | #3 | 5/5 | untested | demonstrated | 16997ms | 3 | 0px | taken 5/5 | - |
| native.second_window | #3 | 5/5 | untested | demonstrated | 2392ms | 4 | 0px | taken 5/5 | - |
| native.select_text | #3 | 5/5 | untested | demonstrated | 16866ms | 2 | 0px | taken 5/5 | - |
| native.unicode_type | #3 | 5/5 | untested | demonstrated | 2189ms | 4 | 0px | taken 5/5 | - |

# Parity matrix — linux-xvfb (isolated, docker)

- commit: `82032cdcc9a25d638391b29eaf9a775b48acf4cf`
- node v24.21.0; linux 6.18.44-fc-v114; display `:99` geometry 1600 1200
- suite: `parity/tasks.json`; chrome: Chromium 154.0.8037.92 built on Debian GNU/Linux 12 (bookworm); python3: Python 3.11.2; tk: 8.6
- date: 2026-10-11T21:59:24.993Z; repeats: 5
- Codex baseline: untested (no codex results)

| task | issue | Codewhale | Codex | status | median elapsed | median tool calls | pointer displacement | foreground | notes |
|---|---|---|---|---|---|---|---|---|---|
| browser.download | #2 | 5/5 | untested | demonstrated | 17540ms | 2 | 0px | preserved | - |
| browser.drag_drop | #2 | 0/5 | untested | untested | 0ms | 0 | 0px | preserved | skipped: held-input gestures require a persistent input owner — the desktop helper or the · known limitation: the direct route has no input owner and refuses left_click_drag (input_owner_required) by design; run with --helper to drive the Linux desktop helper, which owns held input. |
| browser.dynamic_content | #2 | 5/5 | untested | demonstrated | 49617ms | 4 | 0px | preserved | known limitation: reps right after a fixture relaunch raced the oracle: the window mapped before Chromium published the CU-FIXTURE title state, so the first expect sampled nulls (observed 2026-09-16 as 1/5 then 2/5 fails across two runs). The X11 driver now waits for a readable oracle state before launchFixture returns; kept as a note on what the wait is for. |
| browser.element_click | #2 | 5/5 | untested | demonstrated | 18446ms | 2 | 0px | preserved | optional_a11y |
| browser.form_submit | #2 | 5/5 | untested | demonstrated | 4045ms | 9 | 0px | preserved | - |
| browser.iframe_click | #2 | 5/5 | untested | demonstrated | 17590ms | 2 | 0px | preserved | - |
| browser.modifiers | #3 | 5/5 | untested | demonstrated | 18041ms | 4 | 0px | preserved | - |
| browser.outside_raster_fails | #4 | 5/5 | untested | demonstrated | 2088ms | 3 | 0px | preserved | - |
| browser.scroll_reveal | #2 | 5/5 | untested | demonstrated | 4184ms | 3 | 0px | preserved | - |
| browser.stale_element | #2 | 5/5 | untested | demonstrated | 19556ms | 3 | 0px | preserved | optional_a11y |
| browser.tabs | #2 | 5/5 | untested | demonstrated | 3065ms | 4 | 0px | preserved | - |
| browser.unicode_type | #3 | 2/5 | untested | partial | 5777ms | 3 | 0px | preserved | fail: step3 expect {"path":"uni","equals":"héllo wörld 日本 🐳"} never held; last={"name":"","agree":false,"color":"","submitted · known limitation: non-ASCII chars go through per-char `key U<hex>` (deterministic case fix), but under heavy host load XTEST can still drop a remapped char — observed 2026-09-16 as a single missing é/日 in ~1/5 reps. A delivery-layer flake on a loaded container, not a mapping defect; a starved Xvfb run is exactly where it shows. |
| browser.upload | #2 | 5/5 | untested | demonstrated | 5205ms | 5 | 0px | preserved | known limitation: Chromium's GTK file chooser commits a typed location-entry path only via the Open button — Return in the entry closes the dialog with no selection (a stock GTK3 FileChooserDialog commits the same path on Return, so this is Chromium's wrapper). The dialog also carries no AT-SPI elements, so only a window-relative pointer click reaches it. |
| browser.zoom_click | #4 | 5/5 | untested | demonstrated | 17622ms | 3 | 0px | preserved | - |
| control.cancellation | #6 | 5/5 | untested | demonstrated | 3914ms | 2 | 0px | preserved | - |
| control.permission_denied | #6 | 5/5 | untested | demonstrated | 119ms | 2 | 0px | preserved | - |
| control.reconnect_no_replay | #6 | 5/5 | untested | demonstrated | 2270ms | 4 | 0px | preserved | - |
| control.stop_blocks_actions | #6 | 5/5 | untested | demonstrated | 2027ms | 3 | 0px | preserved | - |
| native.drag_square | #3 | 0/5 | untested | untested | 0ms | 0 | 0px | preserved | skipped: held-input gestures require a persistent input owner — the desktop helper or the · known limitation: the direct route has no input owner and refuses left_click_drag (input_owner_required) by design; run with --helper to drive the Linux desktop helper, which owns held input. |
| native.entry_apply | #3 | 5/5 | untested | demonstrated | 1839ms | 4 | 0px | preserved | - |
| native.list_scroll_select | #3 | 5/5 | untested | demonstrated | 2114ms | 3 | 0px | preserved | - |
| native.menu_command | #3 | 5/5 | untested | demonstrated | 2165ms | 4 | 0px | preserved | - |
| native.modal_dialog | #3 | 0/5 | untested | missing | 5969ms | 7 | 0px | preserved | fail: step10 expect {"path":"dialog","equals":"closed"} never held; last={"entry":"blocked","applied":"","menu":[],"selected": · known limitation: Tk's simpledialog is toolkit-modal only: it sets WM_TRANSIENT_FOR + grab_set but no _NET_WM_STATE_MODAL, so a stacking WM lets the parent Apply click take X input focus (verified under openbox and metacity). The grab still blocks the click (applied stays empty) but the typed answer then goes to the parent and the dialog stays open. Passes where the WM keeps focus on the transient. |
| native.modifiers | #3 | 5/5 | untested | demonstrated | 16928ms | 3 | 0px | preserved | - |
| native.second_window | #3 | 5/5 | untested | demonstrated | 2369ms | 4 | 0px | preserved | - |
| native.select_text | #3 | 5/5 | untested | demonstrated | 16879ms | 2 | 0px | preserved | - |
| native.unicode_type | #3 | 5/5 | untested | demonstrated | 3290ms | 4 | 0px | preserved | known limitation: per-char `key U<hex>` + `shift+` for cased capitals fixes the level-0 lowercase remap (Ü→ü). Residual: under heavy host load XTEST can still drop a remapped char — an X11 delivery characteristic, not a mapping defect. |

# Parity matrix — linux-xvfb (isolated, docker, desktop helper)

- commit: `a6a96e320553f4c13a39e38c91e8bf0d2eff771c`
- node v24.21.0; linux 6.18.44-fc-v114; display `:99` geometry 1600 1200
- suite: `parity/tasks.json`; chrome: Chromium 154.0.8037.92 built on Debian GNU/Linux 12 (bookworm); python3: Python 3.11.2; tk: 8.6
- date: 2026-10-11T22:40:37.329Z; repeats: 5
- Codex baseline: untested (no codex results)

| task | issue | Codewhale | Codex | status | median elapsed | median tool calls | pointer displacement | foreground | notes |
|---|---|---|---|---|---|---|---|---|---|
| browser.download | #2 | 5/5 | untested | demonstrated | 17522ms | 2 | 0px | preserved | - |
| browser.drag_drop | #2 | 5/5 | untested | demonstrated | 2486ms | 2 | 0px | preserved | known limitation: the direct route has no input owner and refuses left_click_drag (input_owner_required) by design; run with --helper to drive the Linux desktop helper, which owns held input. |
| browser.dynamic_content | #2 | 5/5 | untested | demonstrated | 49550ms | 4 | 0px | preserved | known limitation: reps right after a fixture relaunch raced the oracle: the window mapped before Chromium published the CU-FIXTURE title state, so the first expect sampled nulls (observed 2026-09-16 as 1/5 then 2/5 fails across two runs). The X11 driver now waits for a readable oracle state before launchFixture returns; kept as a note on what the wait is for. |
| browser.element_click | #2 | 5/5 | untested | demonstrated | 18459ms | 2 | 0px | preserved | optional_a11y |
| browser.form_submit | #2 | 5/5 | untested | demonstrated | 4009ms | 9 | 0px | preserved | - |
| browser.iframe_click | #2 | 5/5 | untested | demonstrated | 17507ms | 2 | 0px | preserved | - |
| browser.modifiers | #3 | 4/5 | untested | partial | 17996ms | 4 | 0px | preserved | fail: step2 key "ctrl+shift+k" failed: input_owner_unknown input refused: no managed application window has keyboard focus; cl |
| browser.outside_raster_fails | #4 | 5/5 | untested | demonstrated | 2121ms | 3 | 0px | preserved | - |
| browser.scroll_reveal | #2 | 5/5 | untested | demonstrated | 4129ms | 3 | 0px | preserved | - |
| browser.stale_element | #2 | 5/5 | untested | demonstrated | 19605ms | 3 | 0px | preserved | optional_a11y |
| browser.tabs | #2 | 5/5 | untested | demonstrated | 3103ms | 4 | 0px | preserved | - |
| browser.unicode_type | #3 | 4/5 | untested | partial | 2964ms | 3 | 0px | preserved | fail: step3 expect {"path":"uni","equals":"héllo wörld 日本 🐳"} never held; last={"name":"","agree":false,"color":"","submitted · known limitation: non-ASCII chars go through per-char `key U<hex>` (deterministic case fix), but under heavy host load XTEST can still drop a remapped char — observed 2026-09-16 as a single missing é/日 in ~1/5 reps. A delivery-layer flake on a loaded container, not a mapping defect; a starved Xvfb run is exactly where it shows. |
| browser.upload | #2 | 5/5 | untested | demonstrated | 5179ms | 5 | 0px | preserved | known limitation: Chromium's GTK file chooser commits a typed location-entry path only via the Open button — Return in the entry closes the dialog with no selection (a stock GTK3 FileChooserDialog commits the same path on Return, so this is Chromium's wrapper). The dialog also carries no AT-SPI elements, so only a window-relative pointer click reaches it. |
| browser.zoom_click | #4 | 5/5 | untested | demonstrated | 17650ms | 3 | 0px | preserved | - |
| control.cancellation | #6 | 5/5 | untested | demonstrated | 3926ms | 2 | 0px | preserved | - |
| control.permission_denied | #6 | 0/5 | untested | untested | 0ms | 0 | 0px | preserved | skipped: on the helper route the desktop helper owns the display session, so emptying the |
| control.reconnect_no_replay | #6 | 5/5 | untested | demonstrated | 2207ms | 4 | 0px | preserved | - |
| control.stop_blocks_actions | #6 | 5/5 | untested | demonstrated | 1996ms | 3 | 0px | preserved | - |
| native.drag_square | #3 | 5/5 | untested | demonstrated | 1692ms | 2 | 0px | preserved | known limitation: the direct route has no input owner and refuses left_click_drag (input_owner_required) by design; run with --helper to drive the Linux desktop helper, which owns held input. |
| native.entry_apply | #3 | 5/5 | untested | demonstrated | 1821ms | 4 | 0px | preserved | - |
| native.list_scroll_select | #3 | 5/5 | untested | demonstrated | 2108ms | 3 | 0px | preserved | - |
| native.menu_command | #3 | 5/5 | untested | demonstrated | 2145ms | 4 | 0px | preserved | - |
| native.modal_dialog | #3 | 0/5 | untested | missing | 6031ms | 7 | 0px | preserved | fail: step10 expect {"path":"dialog","equals":"closed"} never held; last={"entry":"blocked","applied":"","menu":[],"selected": · known limitation: Tk's simpledialog is toolkit-modal only: it sets WM_TRANSIENT_FOR + grab_set but no _NET_WM_STATE_MODAL, so a stacking WM lets the parent Apply click take X input focus (verified under openbox and metacity). The grab still blocks the click (applied stays empty) but the typed answer then goes to the parent and the dialog stays open. Passes where the WM keeps focus on the transient. |
| native.modifiers | #3 | 5/5 | untested | demonstrated | 16944ms | 3 | 0px | preserved | - |
| native.second_window | #3 | 5/5 | untested | demonstrated | 2428ms | 4 | 0px | preserved | - |
| native.select_text | #3 | 5/5 | untested | demonstrated | 16874ms | 2 | 0px | preserved | - |
| native.unicode_type | #3 | 5/5 | untested | demonstrated | 3535ms | 4 | 0px | preserved | known limitation: per-char `key U<hex>` + `shift+` for cased capitals fixes the level-0 lowercase remap (Ü→ü). Residual: under heavy host load XTEST can still drop a remapped char — an X11 delivery characteristic, not a mapping defect. |

# Parity matrix — linux-x11 (xfce)

- commit: `e3658a708b70f1bbe880e8f01a678ab5a4a29d36`
- node v22.22.0; linux 6.18.44-fc-v114; display `:0` geometry 1440 900
- suite: `parity/tasks.json`; chrome: Chromium 141.0.7390.37; python3: Python 3.12.3; tk: 8.6
- date: 2026-10-11T23:12:17.198Z; repeats: 5
- Codex baseline: untested (no codex results)

| task | issue | Codewhale | Codex | status | median elapsed | median tool calls | pointer displacement | foreground | notes |
|---|---|---|---|---|---|---|---|---|---|
| browser.download | #2 | 5/5 | untested | demonstrated | 17589ms | 2 | 0px | taken 5/5 | - |
| browser.drag_drop | #2 | 0/5 | untested | untested | 0ms | 0 | 0px | preserved | skipped: held-input gestures require a persistent input owner — the desktop helper or the · known limitation: the direct route refuses left_click_drag (input_owner_required) by design; run with --helper to drive the Linux desktop helper, which owns held input. |
| browser.dynamic_content | #2 | 5/5 | untested | demonstrated | 49731ms | 4 | 0px | taken 5/5 | - |
| browser.element_click | #2 | 5/5 | untested | demonstrated | 18380ms | 2 | 0px | taken 5/5 | optional_a11y |
| browser.form_submit | #2 | 5/5 | untested | demonstrated | 4459ms | 9 | 0px | taken 5/5 | - |
| browser.iframe_click | #2 | 5/5 | untested | demonstrated | 17610ms | 2 | 0px | taken 5/5 | - |
| browser.modifiers | #3 | 5/5 | untested | demonstrated | 18308ms | 4 | 0px | taken 5/5 | - |
| browser.outside_raster_fails | #4 | 5/5 | untested | demonstrated | 2119ms | 3 | 0px | preserved | - |
| browser.scroll_reveal | #2 | 5/5 | untested | demonstrated | 4323ms | 3 | 0px | taken 5/5 | - |
| browser.stale_element | #2 | 5/5 | untested | demonstrated | 19541ms | 3 | 0px | taken 5/5 | optional_a11y |
| browser.tabs | #2 | 5/5 | untested | demonstrated | 3228ms | 4 | 0px | taken 5/5 | - |
| browser.unicode_type | #3 | 4/5 | untested | partial | 18319ms | 3 | 0px | taken 5/5 | fail: step3 expect {"path":"uni","equals":"héllo wörld 日本 🐳"} never held; last={"name":"","agree":false,"color":"","submitted |
| browser.upload | #2 | 5/5 | untested | demonstrated | 6012ms | 5 | 0px | taken 5/5 | known limitation: same Chromium chooser behavior: type the path, then click Open; Return in the location entry discards it. On desktops where xdg-desktop-portal supplies the chooser instead, the dialog is a different application entirely and this window_title target will not resolve — record that honestly if it shows. |
| browser.zoom_click | #4 | 5/5 | untested | demonstrated | 17836ms | 3 | 0px | taken 5/5 | - |
| control.cancellation | #6 | 5/5 | untested | demonstrated | 3951ms | 2 | 0px | preserved | - |
| control.permission_denied | #6 | 5/5 | untested | demonstrated | 148ms | 2 | 0px | preserved | - |
| control.reconnect_no_replay | #6 | 5/5 | untested | demonstrated | 2350ms | 4 | 0px | preserved | - |
| control.stop_blocks_actions | #6 | 5/5 | untested | demonstrated | 2012ms | 3 | 0px | preserved | - |
| native.drag_square | #3 | 0/5 | untested | untested | 0ms | 0 | 0px | preserved | skipped: held-input gestures require a persistent input owner — the desktop helper or the · known limitation: the direct route refuses left_click_drag (input_owner_required) by design; run with --helper to drive the Linux desktop helper, which owns held input. |
| native.entry_apply | #3 | 5/5 | untested | demonstrated | 2198ms | 4 | 0px | taken 5/5 | - |
| native.list_scroll_select | #3 | 5/5 | untested | demonstrated | 2318ms | 3 | 0px | taken 5/5 | - |
| native.menu_command | #3 | 5/5 | untested | demonstrated | 2375ms | 4 | 0px | taken 5/5 | - |
| native.modal_dialog | #3 | 0/5 | untested | missing | 6576ms | 7 | 0px | taken 5/5 | fail: step10 expect {"path":"dialog","equals":"closed"} never held; last={"entry":"blocked","applied":"","menu":[],"selected": · known limitation: KWin does not give the transient Tk dialog X input focus, so typed text does not reach it; passes on the isolated Xvfb route |
| native.modifiers | #3 | 5/5 | untested | demonstrated | 17239ms | 3 | 0px | taken 5/5 | - |
| native.second_window | #3 | 5/5 | untested | demonstrated | 2583ms | 4 | 0px | taken 5/5 | - |
| native.select_text | #3 | 5/5 | untested | demonstrated | 16951ms | 2 | 0px | taken 5/5 | - |
| native.unicode_type | #3 | 5/5 | untested | demonstrated | 2419ms | 4 | 0px | taken 5/5 | - |

# Parity matrix — linux-x11 (xfce, desktop helper)

- commit: `e3658a708b70f1bbe880e8f01a678ab5a4a29d36`
- node v22.22.0; linux 6.18.44-fc-v114; display `:0` geometry 1440 900
- suite: `parity/tasks.json`; chrome: Chromium 141.0.7390.37; python3: Python 3.12.3; tk: 8.6
- date: 2026-10-11T23:32:09.034Z; repeats: 5
- Codex baseline: untested (no codex results)

| task | issue | Codewhale | Codex | status | median elapsed | median tool calls | pointer displacement | foreground | notes |
|---|---|---|---|---|---|---|---|---|---|
| browser.download | #2 | 5/5 | untested | demonstrated | 17671ms | 2 | 0px | taken 5/5 | - |
| browser.drag_drop | #2 | 5/5 | untested | demonstrated | 2673ms | 2 | 0px | taken 5/5 | known limitation: the direct route refuses left_click_drag (input_owner_required) by design; run with --helper to drive the Linux desktop helper, which owns held input. |
| browser.dynamic_content | #2 | 5/5 | untested | demonstrated | 49791ms | 4 | 0px | taken 5/5 | - |
| browser.element_click | #2 | 5/5 | untested | demonstrated | 18379ms | 2 | 0px | taken 5/5 | optional_a11y |
| browser.form_submit | #2 | 5/5 | untested | demonstrated | 4432ms | 9 | 0px | taken 5/5 | - |
| browser.iframe_click | #2 | 5/5 | untested | demonstrated | 17679ms | 2 | 0px | taken 5/5 | - |
| browser.modifiers | #3 | 5/5 | untested | demonstrated | 18261ms | 4 | 0px | taken 5/5 | - |
| browser.outside_raster_fails | #4 | 5/5 | untested | demonstrated | 2202ms | 3 | 0px | preserved | - |
| browser.scroll_reveal | #2 | 5/5 | untested | demonstrated | 4377ms | 3 | 0px | taken 5/5 | - |
| browser.stale_element | #2 | 5/5 | untested | demonstrated | 19450ms | 3 | 0px | taken 5/5 | optional_a11y |
| browser.tabs | #2 | 5/5 | untested | demonstrated | 3213ms | 4 | 0px | taken 5/5 | - |
| browser.unicode_type | #3 | 4/5 | untested | partial | 18335ms | 3 | 0px | taken 5/5 | fail: step3 expect {"path":"uni","equals":"héllo wörld 日本 🐳"} never held; last={"name":"","agree":false,"color":"","submitted |
| browser.upload | #2 | 5/5 | untested | demonstrated | 6104ms | 5 | 0px | taken 5/5 | known limitation: same Chromium chooser behavior: type the path, then click Open; Return in the location entry discards it. On desktops where xdg-desktop-portal supplies the chooser instead, the dialog is a different application entirely and this window_title target will not resolve — record that honestly if it shows. |
| browser.zoom_click | #4 | 5/5 | untested | demonstrated | 17763ms | 3 | 0px | taken 5/5 | - |
| control.cancellation | #6 | 5/5 | untested | demonstrated | 3950ms | 2 | 0px | preserved | - |
| control.permission_denied | #6 | 0/5 | untested | untested | 0ms | 0 | 0px | preserved | skipped: on the helper route the desktop helper owns the display session, so emptying the |
| control.reconnect_no_replay | #6 | 5/5 | untested | demonstrated | 2367ms | 4 | 0px | preserved | - |
| control.stop_blocks_actions | #6 | 5/5 | untested | demonstrated | 2105ms | 3 | 0px | preserved | - |
| native.drag_square | #3 | 5/5 | untested | demonstrated | 1854ms | 2 | 0px | taken 5/5 | known limitation: the direct route refuses left_click_drag (input_owner_required) by design; run with --helper to drive the Linux desktop helper, which owns held input. |
| native.entry_apply | #3 | 5/5 | untested | demonstrated | 2077ms | 4 | 0px | taken 5/5 | - |
| native.list_scroll_select | #3 | 5/5 | untested | demonstrated | 2309ms | 3 | 0px | taken 5/5 | - |
| native.menu_command | #3 | 5/5 | untested | demonstrated | 2298ms | 4 | 0px | taken 5/5 | - |
| native.modal_dialog | #3 | 0/5 | untested | missing | 6524ms | 7 | 0px | taken 5/5 | fail: step10 expect {"path":"dialog","equals":"closed"} never held; last={"entry":"blocked","applied":"","menu":[],"selected": · known limitation: KWin does not give the transient Tk dialog X input focus, so typed text does not reach it; passes on the isolated Xvfb route |
| native.modifiers | #3 | 5/5 | untested | demonstrated | 17178ms | 3 | 0px | taken 5/5 | - |
| native.second_window | #3 | 5/5 | untested | demonstrated | 2550ms | 4 | 0px | taken 5/5 | - |
| native.select_text | #3 | 5/5 | untested | demonstrated | 16922ms | 2 | 0px | taken 5/5 | - |
| native.unicode_type | #3 | 5/5 | untested | demonstrated | 2372ms | 4 | 0px | taken 5/5 | - |

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
| Linux X11 | 24/27 tasks demonstrated at 5 repeats (linux-xvfb (isolated), 2026-10-11); separate run: 25/27 tasks demonstrated at 5 repeats (linux-xvfb (isolated, desktop helper), 2026-10-11); separate run: 23/27 tasks demonstrated at 5 repeats (linux-x11, 2026-10-11); separate run: 25/27 tasks demonstrated at 5 repeats (linux-x11 (desktop helper), 2026-10-11); separate run: 23/27 tasks demonstrated at 5 repeats (linux-xvfb (isolated, docker), 2026-10-11); separate run: 23/27 tasks demonstrated at 5 repeats (linux-xvfb (isolated, docker, desktop helper), 2026-10-11); separate run: 23/27 tasks demonstrated at 5 repeats (linux-x11 (xfce), 2026-10-11); separate run: 24/27 tasks demonstrated at 5 repeats (linux-x11 (xfce, desktop helper), 2026-10-11) |
| Wayland | untested — see docs/LIMITATIONS.md |
| Windows | untested — see docs/LIMITATIONS.md |
| HarmonyOS (hdc) | untested — see docs/LIMITATIONS.md |
| SSH remote | untested — see docs/LIMITATIONS.md |
| Codex / Claude Desktop fresh session | untested — see docs/LIMITATIONS.md |
| signed-update permission persistence | untested — see docs/LIMITATIONS.md |
