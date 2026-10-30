# Bar for shipping Computer Use on by default

The founder's goal (2026-10-28) is for Computer Use to be good enough that Codewhale includes it by default, at least on macOS, with explicit consent and permission prompts on first use. Amended 2026-10-30 on the owner's instruction to make Computer Use less restrictive: the first-use prompts are the two macOS grants (Accessibility, Screen Recording). The Codewhale-owned trust panel with Touch ID is no longer the default; it applies only in strict approval mode. Row 3 below states the new bar. This page sets that bar and records how far the 0.13.0 candidate is from it. The mechanism for turning it on by default is an Engine and product decision, made separately. A row passes only on the evidence named in its "Measured by" column; source tests alone pass no row.

## The bar

| # | Criterion | Bar for default-on (macOS) | Measured by |
| --- | --- | --- | --- |
| 1 | Reliability on core tasks | 27/27 tasks of the fixed `parity/tasks.darwin.json` suite *demonstrated* (5/5 repeats each, `parity/thresholds.json`). Plus 6/6 tasks of `parity/tasks.model-native.json` driven by a real model through Codewhale, at least 4/5 repeats each. Both runs use the signed release build on a Retina display and a non-Retina display | `scripts/parity-run.mjs` receipts in `parity/results/` |
| 2 | First-run setup | A person with a stock Mac and no developer tools reaches a working observe–act–verify loop in TextEdit. The only manual steps are opening the helper once, the two macOS grants (Accessibility, Screen Recording) and the native **Trust Codewhale** approval. No Node install, terminal command, config edit or restart | Clean macOS user account, recorded step list |
| 3 | Consent and safety model | Nothing reads or operates the Mac before the person has granted macOS Accessibility and Screen Recording to the helper. In the default standard approval mode no further Codewhale prompt stands in the way; strict mode (`CODEWHALE_CU_APPROVAL=strict`) restores the native trust panel. App denies, final-action confirmations, exact-script approval and Pause/Stop work without capture and hold across reconnects. Every refusal names what is missing (app, OS grant or host) | Existing consent/control suites, plus one live run of each refusal path |
| 4 | Cost while unused | No process, network request, prompt bytes or disk writes until first use. After first use, an idle MCP server costs ≤ 50 MB RSS and no CPU. Tool schemas stay deferred behind tool search, and server instructions fit Codewhale's 4,096-byte limit (`MAX_SERVER_INSTRUCTIONS_BYTES`) | `ps` on an idle session; `tools/list` and `initialize` sizes |
| 5 | Disable and uninstall | Disabling the plugin in Connectors stops its MCP server and removes its tools. Helper **Turn off** revokes the pairing. One documented action removes the helper app, `~/.codewhale-cu` and the log folder, and lists the macOS grants the person may revoke in System Settings | Manual check, recorded |
| 6 | Crash-free rate | ≥ 99.5% of helper sessions end cleanly over at least 2 weeks of dogfooding on the release build. No MCP server crash in the parity and model runs. Unclean ends are counted from `~/Library/Logs/Codewhale Computer Use/app.log` (starts vs. shutdowns) and `DiagnosticReports` | Log count over the dogfood window |
| 7 | Windows and Linux | Not on by default. They stay opt-in and labelled experimental (unsigned Windows preview; Linux X11 from source or Docker) until each has a signed or packaged helper and its own row 1 run | `docs/PARITY_MATRIX.md` |

## Where 0.13.0 stands (2026-10-28)

| # | Status | Evidence and gap |
| --- | --- | --- |
| 1 | **Not met** | The last macOS run is `darwin-aqua-2026-09-15.json` (27 tasks demonstrated, 0.6-era source). It has not been re-run on 0.13.0. A run needs the founder's Mac with Accessibility granted to the build, so it has never been run by an agent. There is no model-native receipt on macOS yet (CW-6299/C16). |
| 2 | **Not met** | The marketplace plugin runs `node mcp/server.mjs`, so Node 20+ must already be on `PATH`. A stock Mac fails that, and a GUI-launched Codewhale may not see Homebrew's `PATH`. The release helper bundles Node 24, but the marketplace plugin cannot use it. Install, trust, enable and the first tool call through Codewhale 0.10.2 work with a temp HOME (`artifacts/cu-plugin-release-20261028/install-proof.log`). |
| 3 | **Mostly met in source** | The native host-trust pairing, controller, exclusions and confirmations are in 0.13.0. The consent and control suites pass in CI. The paired-helper path has had one live trust/revoke run, on an earlier signed candidate. The revised approval panel and its keyboard and screen-reader behaviour are not qualified. |
| 4 | **Partly met** | Idle MCP server measured: 67–75 ms to `initialize`, about 41 MB RSS, 0.06 s CPU after 5 s, and no child processes. The 38 tool schemas (50 KB) are deferred behind tool search by the Engine. Server instructions were 6,491 bytes, so Codewhale cut the second half of the guide; they are now 4,015 bytes. Not yet measured: whether Codewhale starts the server at session start or at first use. In the install proof it stayed disconnected until it was asked to reconnect. The bar requires first use. |
| 5 | **Not met** | Connectors disable works (Runtime API `disable`), and so does helper **Turn off**. There is no single user-facing uninstall: `npm run remove:app` is a developer script, and `~/.codewhale-cu` (compiled helpers, recordings, consent) is left behind. |
| 6 | **Unmeasured on 0.13.0** | Across every helper version on the maintainer Mac, `app.log` shows 170 starts and 162 clean shutdowns, and there are no helper crash reports. That counts development builds and reboots, so it is not a crash-free rate. The 2-week window on the signed 0.13.0 build has not started. |
| 7 | **Met (off by default)** | Windows input through the preview helper was refused until `d8d2360` and works now, in source and CI only. Linux is labelled experimental. |

## What closes the gap

1. Publish the signed 0.13.0 release. Then run the macOS parity suite and the model-native suite on it with the founder present. This closes rows 1 and 6 and starts the dogfood window.
2. Remove the separate Node requirement on macOS. The helper the person must install anyway already carries Node 24. The Engine should launch the Computer Use MCP server with it, or the helper should serve the MCP stdio session itself, rather than require a system Node (row 2).
3. Measure when Codewhale starts the server. If it starts at session start, defer it to first use (row 4).
4. Add an **Uninstall Computer Use…** action to the helper's Settings that removes the app, `~/.codewhale-cu` and the logs, and names the macOS grants to revoke (row 5).
