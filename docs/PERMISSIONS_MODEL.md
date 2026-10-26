# Permission model for Computer Use — and what Codewhale should copy

Status: **proposal, partly implemented**. Written 2026-10-22 after a live
driving session exposed that Computer Use cannot be authorized at all in Full
Access, and that the reason is structural rather than a missing branch. The
Engine since lets Full Access ask for a consent decision (its commit
`ad697b35f5`, 2026-10-22); the four-layer split in sections 4 to 7, a
host-owned grant store and a `/plugin permissions` view are not built. The
plugin side still verifies a host attestation or a client elicitation before
it records an allow; since 0.12.1, on macOS under a host with neither, the
helper app shows a Touch ID / password approval panel and enforces allows in
its daemon (or, when `CODEWHALE_CU_NATIVE_PROMPT=1` is set without the helper,
asks with an interim `osascript` dialog; see `docs/LIMITATIONS.md`).

## 1. The finding, in one paragraph

Codewhale has four different things that all get called "permission", and three
of them are wired into each other. A plugin's **declared capabilities** (what it
may ever attempt) are reviewed at trust time and then forgotten. The **person's
standing grant** (which apps this helper may drive) lives in the plugin's own
signed ledger. The **turn posture** (Ask / Auto-Review / Full Access / Never)
decides how often the agent interrupts. And a **per-action question** (approve
this exact call) is expressed as an approval card. Computer Use's standing grant
is currently routed *through* the posture, so the most permissive posture —
Full Access — is the one posture where the grant can never be made. That is a
category error, not a bug in a branch.

## 2. Evidence: what happens today

Reproduced on 2026-10-22 with `deepseek-v4-flash` driving Finder through
`mcp_plugin-12-computer-use-computer_*`. Ask and Full Access were exercised
live; Auto-Review and Never are read from the preparation code, not run.

| Posture | `consent {action:"allow", app:"com.apple.finder"}` | How established |
| --- | --- | --- |
| Ask | Approval card renders; approving records the grant. Works. | run live |
| Full Access | Refused at preparation. Retried in Ask immediately afterwards, and the identical call then succeeded. | run live |
| Auto-Review | Refused at preparation (`card_available` requires `Suggest`). | read from code |
| Never | Refused at preparation, and the disposition would deny it too. | read from code |

The refusal comes from `crates/tui/src/core/engine/tool_preparation.rs`
(`card_available` requires `!auto_approve && approval_mode == Suggest`). The
disposition layer would *also* auto-deny it, in
`crates/tui/src/core/authority.rs` (`AutoDenyFullAccessPolicyHold`), because a
forced prompt under Full Access is treated as a policy hold that cannot open its
own UI.

Three separate mechanisms police one feature:

1. `crates/tui/src/tools/approval_cache.rs::computer_use_user_gate` — a
   hardcoded list of tool-name suffixes (`_consent`, `_consent_allow`,
   `_consent_revoke`, `_app_script`) that switches a call into
   "needs a human" mode. It knows about Computer Use by *name*.
2. `src/consent.mjs` in the plugin — its own per-app ledger with its own
   HMAC-signed entries, its own session-vs-persisted semantics, its own key in
   `~/.codewhale-cu/consent.json`.
3. `crates/tui/src/mcp.rs` (`COMPUTER_USE_DECISION_META`, `attest_decision`) —
   a fourth key, a nonce, a MAC, threaded through the MCP transport so the
   engine can prove "a human pressed Allow" to the plugin.

Plus the ordinary approval posture and the plugin trust/enable state, which are
the two that actually generalize.

The result is a feature that has to be understood five ways at once, and a
default posture in which it silently cannot work.

## 3. How other platforms split this

### Chrome extensions — declared vs optional

`manifest.json` splits `permissions` (granted at install, warned about) from
`optional_permissions` and `optional_host_permissions` ("granted by the user at
runtime, instead of at install time"). Chrome's own docs recommend optional
permissions "wherever the functionality of your extension permits, to provide
users with informed control over access to resources and data." Changing
`host_permissions` later triggers a new warning.

Lesson: **the manifest declares the ceiling; the user narrows at runtime.** A
capability the manifest never declared cannot be granted later by prompting.

### Chrome site permissions — three scopes, one question

For camera, location, microphone and friends the prompt offers exactly three
answers:

- "Allow this time" — current visit only, asks again next time
- "Allow while visiting the site" — persists for that site
- "Never allow"

Lesson: **one question, three scopes, and the scope is the user's choice at the
moment of asking.** Not a posture setting they had to configure beforehand.

### Android — install-time vs runtime, and re-check every time

Install-time (normal/signature) permissions are granted at install. Runtime
("dangerous") permissions prompt, can be revoked in Settings, and the docs are
explicit: "Don't assume that these permissions have been previously granted—check
them and, if needed, request them before each access."

Lesson: **grant state is not a boolean you cache at startup**; the owner
re-checks at use, because the user can revoke out from under you.

### macOS TCC — per app × per service, owned by the app the user sees

Screen Recording, Accessibility, Microphone and friends are per-application and
per-service, live in System Settings, and cannot be granted by the app itself.
An installed helper owns the grant; another process cannot quietly borrow it.
(Computer Use already respects this: `request_access` returns `via:"app"` or
`via:"direct"` and refuses to fall back between them.)

Lesson: **the grant belongs to whoever holds the OS permission**, and the user is
told which one that is. A second, parallel grant ledger must not pretend to be
the OS one.

### Figma plugins — network allowlist, and a written reason for `*`

`networkAccess.allowedDomains` is an enforced allowlist (`["none"]`,
`["*.example.com"]`, or `["*"]`). Including `"*"` **requires** a `reasoning`
string, and the allowlist is shown on the plugin's public page.

Lesson: **the broadest grant costs an explanation.** Cheap to copy, and it makes
wildcards reviewable.

### VS Code — declared capability support

`package.json` carries a `capabilities` object (`untrustedWorkspaces`,
`virtualWorkspaces`) plus `restrictedConfigurations` — the extension states up
front what it can do in a limited workspace, and the host uses that declaration
to decide whether to run it at all.

Lesson: **declare support explicitly, default to restricted.** An undeclared
capability is treated as unsupported, not as allowed.

### MCP — annotations are hints, elicitation is the question

The spec's `ToolAnnotations` (`readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint`) are explicitly "**hints** … Clients should
never make tool use decisions based on ToolAnnotations received from untrusted
servers." `elicitation` is the standard way for a server to ask the *user* a
question mid-call, with the client owning the UI and the decline path.

Lesson: **don't build your security model on server-supplied hints.** Codewhale
already does the right thing here — it reviews and hash-pins a plugin's declared
surface at trust time, which is strictly stronger than MCP hints.

### Anthropic's computer-use guidance

Ask "a human to confirm decisions that might result in meaningful real-world
consequences and any tasks requiring affirmative consent", and perform that check
**before each block runs**, because "a batch can complete a multistep action
within one turn."

Lesson: **confirmation is per consequential action, not per session** — and a
batch must not be able to carry an approval past its own boundary. (Codewhale's
`computer_use_batch_hidden_gate` already does this. Keep it.)

## 4. The four layers all of them share

Every platform above separates these. Codewhale has 1 and 4, and bolts 2 and 3
onto 4.

1. **Declared capabilities** — static, in the manifest, reviewed once, hash-pinned.
   Answers *what may this plugin ever attempt?*
2. **Grants** — durable, per (plugin, capability, subject), owned by the person,
   revocable in one visible place, scoped `once | session | app | always`.
   Answers *what has the person already allowed?*
3. **Per-action confirmation** — transient, one call, no persistence.
   Answers *do they want this one?*
4. **Execution posture** — per session, decides **how often the agent
   interrupts**, nothing else. Answers *how chatty should the loop be?*

The invariant Codewhale is missing:

> **Posture decides whether to ask. It never decides whether a capability is
> allowed, and it can never stand in for a person's answer.**

Under that invariant, Full Access means "don't interrupt me about things I have
already allowed", and an ungranted capability still asks — or, in a posture with
no UI, is refused *with the remedy named*. That is the opposite of today, where
Full Access refuses the grant and Ask can make it.

## 5. Why MCP annotations are not enough (measured)

Dumped from the live server, all 38 tools: 13 report `readOnlyHint: true`, 18
report `destructiveHint: true`, and 18 report `openWorldHint: true`.

```
read:        request_access, list_displays, list_apps, list_windows, wait_for,
             get_app_state, screenshot, zoom, cursor_position, list_sessions,
             get_value, find_elements, wait
write:       preview, computer, consent, switch_display, kill_app, browser,
             trajectory, set_window_frame, open_application, click, pointer,
             left_click_drag, scroll, type, key, set_value, focus, run_actions,
             select_text, perform_action, invoke_menu, clipboard, recording,
             app_script, stop_computer_control
destructive: computer, kill_app, browser, set_window_frame, open_application,
             click, pointer, left_click_drag, scroll, type, key, set_value,
             focus, run_actions, select_text, perform_action, invoke_menu,
             clipboard, app_script
```

Eighteen are `write,destructive,openWorld` or `write,destructive,idempotent,openWorld`
— indistinguishable by annotation. `scroll` and `type` and `kill_app` and
`app_script` all look the same to a host that reads only the hints. (One more,
`open_application`, hides behind the schema default: `destructiveHint` defaults to
`true` when unset, so a host that honours the spec must treat it as destructive
even though the server never says so.) And `screenshot` is `read` while
`get_app_state` is `read`, even though both expose everything on the user's
screen.

So the plugin cannot rely on its own MCP annotations, and the host cannot either.
**The capability vocabulary has to be richer than the MCP annotations, declared
per tool, and reviewed at trust time.**

## 6. Plugin-specific notes: what Computer Use should declare

Proposed capability classes for this plugin. These are what `plugin.json` would
declare, and what the helper enforces at its socket as well — a narrowed server
must not be able to smuggle one past the boundary that actually sends input.

| Capability | Tools | Tier | Scope subject |
| --- | --- | --- | --- |
| `desktop.observe` | `screenshot`, `zoom`, `get_app_state`, `get_value`, `find_elements`, `list_windows`, `list_displays`, `cursor_position`, `wait_for`, `wait`, `list_sessions` | read | display, or app |
| `desktop.input` | `click`, `pointer`, `left_click_drag`, `scroll`, `type`, `key`, `set_value`, `focus`, `select_text`, `perform_action`, `invoke_menu` | act | **app** |
| `desktop.launch` | `open_application`, `kill_app`, `set_window_frame` | act | app |
| `desktop.batch` | `run_actions`, `find_elements` (as a pre-step) | act | inherits from every step it contains |
| `desktop.script` | `app_script` | consequential | language + script digest |
| `desktop.clipboard` | `clipboard` (read/write) | consequential | direction |
| `desktop.record` | `recording`, `trajectory`, `preview` | act | display |
| `desktop.control` | `stop_computer_control` | act (narrowing — never gated) | — |
| `desktop.consent` | `consent`, `request_access` | **meta** (this is the grant channel itself; see below) | — |
| `browser.*` | `browser` | act | isolated profile only |
| `computers.admin` | `computer` (list/switch/register/spawn/remove) | consequential | computer id |

Notes specific to this plugin:

- **`consent` is not a tool, it is the grant channel.** Today it is modelled as
  a gated tool, which is why it needs a special case in the host. In the target
  model it disappears from the tool surface: the host owns grants, and the
  helper is told the effective grant set when a session opens. That deletes
  `computer_use_user_gate` entirely.
- **`request_access` stays** — but as *reporting*: it returns the platform (TCC)
  permission state, the helper identity (`via`), and the plugin's current
  logical grants. It never asks for anything.
- **`stop_computer_control` must never be gated.** A stop control that can be
  denied is not a stop control. Same for `consent {action:"deny"|"revoke"}`:
  narrowing must always work.
- **The app is the unit of trust for input**, not the tool. One grant per app,
  because that is what a person can reason about ("Codewhale may use Finder"),
  and it survives the plugin adding a new click verb.
- **The helper owns the enforcement, the host owns the answer.** The helper is
  what actually sends input, so it must enforce; but it must not be the store of
  record, or an upgrade loses grants and a compromised host can self-grant.
  Keep the current HMAC attestation — generalize it, don't add another key.
- **Platform ≠ logical.** macOS TCC (Screen Recording, Accessibility) is a
  *different* grant from "Codewhale may drive Finder". Both must be present.
  `request_access` should report them as two separate lists, clearly labelled,
  so a user is never told "you granted it" when only one of the two is true.
- **One app approval covers its foreground control.** Explicitly selecting
  `activate:true` for an approved app needs no second consent prompt. A
  foreground capability may still be declared and reported separately; it
  must not create another approval ceremony. Explicit foreground denials,
  app revocation and Pause/Stop continue to apply.

## 7. What Codewhale should build

### 7.1 Data model

```jsonc
// plugin.json — declared, reviewed at trust, hash-pinned with the bundle
"capabilities": {
  "desktop.observe":     { "tier": "read" },
  "desktop.input":       { "tier": "act", "subject": "app" },
  "desktop.script":      { "tier": "consequential", "reason": "…required when tier is consequential…" },
  "desktop.clipboard":   { "tier": "consequential", "subject": "direction" }
}
```

```jsonc
// ~/.codewhale/plugins/grants.json — owned by the engine, signed, revocable
{ "version": 1, "grants": [
  { "plugin": "computer-use", "capability": "desktop.input",
    "subject": "app:com.apple.finder", "scope": "app",
    "decision": "allow", "at": "2026-10-22T…", "mac": "…" }
]}
```

`scope`: `once` (single call, consumed), `session` (this MCP connection),
`app`/`subject` (durable for that subject), `always` (durable, requires
`reason` on the declaration for consequential tiers — the Figma rule).

### 7.2 Resolution

```
resolve(call) =
  not declared            -> Refuse("the plugin never asked for this")
  granted(subject, scope) -> Ask posture? then per-action policy : Allow
  not granted             -> posture can show UI ? Prompt(with scopes) : Refuse(naming /plugin permissions)

consequential tier always adds a per-call confirmation, even when granted.
```

Posture appears exactly once, at "should I interrupt", never at "may I".

### 7.3 What gets deleted

- `tools/approval_cache.rs::computer_use_user_gate` and its suffix list.
- `core/engine/tool_preparation.rs`'s special case (the `card_available`
  branch) — the generic path handles it.
- The plugin's private ledger *as a store of record*; it becomes an enforcement
  cache fed by the host at session open.

What stays: the nonce + HMAC attestation (generalized to any capability
decision), the batch hidden-gate (renamed to a generic "a batch may not carry a
consequential capability"), and `via: "app" | "direct"` platform ownership.

### 7.4 UX

- `/plugin permissions` — one list: declared capabilities, current grants with
  scope and subject, revoke buttons. This is the "System Settings" surface the
  model needs.
- A **session indicator** while `desktop.input` or `desktop.observe` is live —
  the camera-dot / screen-recording-icon idea. Cheap, and it is the thing that
  makes background control feel safe rather than spooky.
- Full Access shows "1 capability waiting for your answer" instead of failing
  invisibly. Never shows it as a dead end: name the command.

### 7.5 Acceptance

1. In Full Access, `desktop.input` on an ungranted app **asks once** and then
   works; asking is never refused for being in Full Access.
2. In Never, the same call is refused, and the refusal names the grant command.
3. A model cannot create or widen a grant in any posture (the property K1
   protects today) — including inside `run_actions`.
4. Revoking a grant takes effect on the next call, not the next session.
5. A grant survives a plugin upgrade only if the declaring hash still covers
   that capability.
6. `stop_computer_control` and `consent.deny` are never denied by the model's
   own posture.

## 8. Open questions

- Should grants be per **app** or per **app + verb class** (`observe` vs
  `input`)? Recommendation: separate grants for observe and input, because
  watching a window and typing into it are different risks, and a user may
  reasonably allow the first and not the second.
- Do `always` grants need an expiry (Android-style "unused permission" expiry)?
  Recommendation: yes for `desktop.foreground`, no for per-app `input`.
- Does the *engine* or the *helper app* present the grant UI? macOS says the
  TCC owner is the app, but the logical grant can live with the engine. The
  safest split: engine owns logical grants, helper owns TCC, `request_access`
  reports both, and neither can silently substitute for the other.

## 9. Appendix: how this maps onto the parked patch

A minimal patch was written before this document and then reverted, parked at
`backups/cu-permissions-wip-20261022/full-access-consent-card.patch`. It makes
Full Access open the card instead of refusing, by threading a
`human_decision_required` flag into
`resolve_approval_request_disposition`. It fixes the dead end and keeps K1.

It is **not** the right shape: it adds a sixth parameter and a special case to
the very conflation this document is about. Apply it only as a stopgap if the
dead end must ship before §7 lands.
