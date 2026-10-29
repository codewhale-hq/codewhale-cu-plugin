# Set up Computer Use

Install the separate [Computer Use app](https://codewhale.net/computer-use),
open it once, then open **Computer Use…** from the whale in the macOS menu bar.
The app starts quietly; connecting a model does not open Settings or take
keyboard focus.

1. In **Accessibility**, choose **Allow…**, then enable **Codewhale Computer
   Use** in System Settings. This permits reading controls and sending input.
2. In **Screen Recording**, choose **Allow…**, then enable the same app. This
   permits app screenshots. If it is not listed, use **+** in System Settings
   and select **Codewhale Computer Use** from Applications. macOS may require
   quitting and reopening the app, or show another screen-capture approval when
   you first use it.
3. Return to the panel. It should show **Ready**. The granted permission rows
   remain available under **Settings…**.
4. In Codewhale's **Connectors**, install, review and enable the ordinary
   Computer Use plugin from a stable published plugin release, then start a
   task. The portable plugin release asset is planned for 0.13.0 and is not
   yet published; see [distribution](DISTRIBUTION.md). With the 0.13.0 candidate
   plugin and helper, the first request to read or operate this Mac opens the
   native trust panel. Choose
   **Trust until revoked…** and confirm with Touch ID or your Mac password.
   Choose **Deny** to refuse.

Codewhale proves the same installation key across connections, so changing apps,
tasks or models does not ask again. Hosts without a persistent pairing key get
approval for that connection. This is key pairing, not verification of the
host's vendor code signature; see the [trust boundary](LIMITATIONS.md).
App exclusions, exact-script approval and consequential-action confirmations
still apply. `consent {action:"status"}` reports current helper trust without
opening a prompt.

The native trust flow and compact Codewhale controller are 0.13.0 candidate
features. A signed candidate passed human approval, reconnect after helper
restart, background input/capture and human revocation on one maintainer Mac.
The simplified native UI and release packaging still need qualification;
publication remains pending. Older installed clients can retain their own
consent cards or per-app gates. Update the plugin through Connectors and the
separate helper through its app updater, then restart their connections.
Changing this checkout updates neither installed component.

## Working controls

**Background** uses app-scoped accessibility actions and process-bound input.
Unsupported actions fail with an explanation. **Foreground** shares the
desktop and requires the user's authorization. Neither is a second desktop.

The candidate's compact **Codewhale controller** names the app and has a direct
**Stop computer use** button; its menu also offers **Pause**. It remains
reachable when the app is hidden or covered. It is Codewhale UI, not an
identical macOS system indicator. The
live screenshot preview stays off unless you ask to watch; `preview` with
`enabled:true` opens it. Its Close button, the menu-bar **Close preview** action,
or `enabled:false` stops watching.
It also hides after 60 seconds of session inactivity or when the session ends.

**Pause** cancels pending requests and releases held input. **Resume** allows
new requests in those sessions. **Stop computer use** ends all current sessions
and invalidates their input bindings and leases. **Resume computer use** does not revive stopped
requests: begin a new task. Paused/stopped state survives helper restarts.
To withdraw lasting permission, open **Settings… → Remembered access** and
choose **Turn off** for the connection. Previous connections are hidden until
you select **Show previous connections**. App `consent deny` or `revoke` only narrows access;
an agent cannot clear a native exclusion or re-enable a revoked host.

If input release fails, the panel stays blocked and explains the failure.
Quit and reopen the helper before starting another task. The model cannot
resume the helper through MCP or operate its own safety panel.

For troubleshooting, **Settings… → Run background check** edits a temporary
practice window, presses Apply and captures it. Keep your pointer still briefly
for that optional check. It does not touch your documents or clipboard. Pointer
or foreground movement makes the isolation result inconclusive.

## Common problems

| What you see | What to do |
| --- | --- |
| `app_setup_required` on macOS | Install the separate Computer Use app from the setup page, open it once and finish its permission setup. Then retry. Installing the plugin alone does not install or authorize the native helper. |
| `browser_unavailable` says Chromium "runs as root without its sandbox" | Run the Computer Use server as a non-root user. Codewhale does not add `--no-sandbox`. To use a launcher you control, set `CODEWHALE_CU_BROWSER_APP` to it. |
| Keystrokes refused with `popup_open` (Linux) | A menu or popup item is open in the target app. Send `key escape`, observe, then retry. |
| Input refused with `window_blocked_by_dialog` (Linux X11) | Interact with the related dialog, or close it before returning to its parent window. Some non-modal dialogs use the same window metadata and are refused too. |
| `window_not_capturable` after opening or changing a Mac window | Wait for the window to finish appearing, then observe its windows again and retry. A window that remains unavailable cannot be captured through that route. |
| Input refused with `input_owner_unknown` (Linux, Windows) | No window manager is publishing its stacking order, or the Wayland compositor is not sway or Hyprland, or windows of two apps overlap at the point. Run a window manager (openbox works on Xvfb), use X11, or move the overlapping window. |
| No trust panel appears | Check `request_access` for the helper version and owner, then `consent {action:"status"}`. An already trusted installation needs no new prompt. Discovery/status alone does not ask; the first content/action request does. Both plugin and helper need the new host-trust protocol. Source changes alone do not update an installed client. |
| Asked again after each connection | A host without a persistent private pairing key receives connection-scoped approval. For Codewhale, verify the installed plugin is current and its existing secret store is available. Do not copy secrets or edit saved trust to suppress prompts. |
| Two approval prompts | Older clients can show their own consent card before the helper panel. A first script also needs its exact-script approval after installation trust. Ordinary app changes do not require per-app prompts on the updated route. |
| `app_denied` or `consent_declined` | The person refused access. Continue without that app; do not rename the target or retry through another tool. |
| `host_revoked` | The person revoked installation access. Only they can reconsider through the native controls; a new task or model must not work around it. |
| `host_auth_failed` or `host_auth_required` | The connection did not prove its pairing key. Restart the updated MCP connection. Do not reuse another session's lease or proof. |
| `host_trust_unavailable` | Check Computer Use for a Keychain or persistence error. Access stays blocked until the person resolves it. Do not change to direct mode or delete trust data. |
| `consent_pending` | A helper approval panel is waiting for the person. Do not operate the panel through computer-use tools; Stop cancels it. |
| `consent_required` for input aimed at another app | Confirm the selected app and the receipt's actual target. Bind the intended app with `open_application`; honor exclusions. Older/direct routes still use per-app consent. Never change target spellings or routes to defeat a refusal. |
| `kill_app` reports `still_running` | The app asked to save or refused to quit. Ask the user; use `force:true` only if unsaved work can be discarded. |
| Permission stays missing | Confirm the app name in Settings. Quit and reopen after changing Screen Recording. Use a current signed build. |
| Run background check is disabled | Grant both permissions, allow control and wait for the current action to finish. |
| Check is inconclusive | Keep the pointer still and stay in the same app for the next check. The previous trial is not counted as passing isolation. |
| Helper unavailable | Open Computer Use from Applications. Check its panel and log. Reinstall if its path no longer exists. The client will not bypass an installed helper. |
| The menu icon disappeared and reopening a 0.3.0 build does nothing | Quit the orphaned Computer Use helper in Activity Monitor, then reopen the app and allow new sessions yourself. Builds from 0.3.1 retire the helper and recover on reopen; which builds are published is recorded in [CHANGELOG.md](../CHANGELOG.md). |
| App needs shared pointer input | Prefer an advertised accessibility action. Otherwise explicitly authorize foreground use or choose a separate computer. |
| A web page shows only the toolbar and tab strip | Re-observe. Builds from 0.6.0 enable the app's enhanced accessibility and retry once automatically, but a page can still be mid-load — call `get_app_state` again after it settles. |
| Click fails with `degenerate_frame` | The element is a collapsed placeholder (common in virtualized lists). Scroll the real row into view, re-observe, and target the fresh index. |
| `set_value` on a number field does not stick | Numeric controls (`AXIncrementor`/`AXSlider`/`AXStepper`) now take numbers and report `verified`; if the receipt says the control kept its own value, `focus` the element and `type` the value instead. |
| No stable installer available | The updater found no published stable release that passes its checks; release status is recorded in [CHANGELOG.md](../CHANGELOG.md). Build and install from source, or check again later. Being on the newest source commit is not the same as having a published app. |
| Update verification failed | Keep using the installed version. Recheck later; do not disable signature or notarization checks. |
| An update stopped computer sessions | Read the update result in the panel, resolve any installation error and choose Allow new sessions when ready. Updates never resume stopped input automatically. Builds from 0.3.1 source show the apply result after relaunch. |

App log: `~/Library/Logs/Codewhale Computer Use/app.log`.
Update log: `~/Library/Logs/Codewhale Computer Use/update.log`.

## Getting help

Open an issue at
[github.com/codewhale-hq/codewhale-cu-plugin/issues](https://github.com/codewhale-hq/codewhale-cu-plugin/issues)
with the plugin version, macOS version, the failed action and the error text.
Remove private app contents, document text and credentials from any log
excerpt. For a suspected vulnerability, follow [SECURITY.md](../SECURITY.md)
instead of filing a public issue. Support is best-effort during the beta.

## Roll back

Updates retain the previous bundle under the installation directory's
`.codewhale-cu-backups/` folder. Quit Computer Use, move the current bundle
aside, and restore the saved bundle as **Codewhale Computer Use.app**. Open
it, check permissions and start a fresh task. Old sessions and stopped input
are not replayed. Only the two newest backups are kept (`CODEWHALE_CU_BACKUPS_KEEP`
raises that); copy one elsewhere if you need an older build.
