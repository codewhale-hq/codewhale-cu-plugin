# Cua reference and Codewhale parity

Original comparison reviewed October 8, 2026; the dated Phase 3 section below records later macOS work. This is a source comparison and implementation plan.
Upstream documentation, local protocol fixtures, native application receipts,
installed builds and real cloud tasks are separate evidence.

## October 31 macOS Phase 3 source candidate

The source after published 0.14.0 implements Electron/Chromium renderer hover,
pointer-capture drags and intercepted HTML5 drops without opening a Node
inspector or moving the hardware cursor. It connects only to an existing
loopback renderer endpoint explicitly enabled on the bound process. It does
not enable one, restart the person's app or change a browser profile. Stock
apps without this endpoint refuse these gestures; accessible controls and
Chromewhale remain the alternatives. Native and renderer window identity,
viewport, visible page, title, URL and document loader are checked, with
geometry read in an isolated JavaScript context. Existing consent, input
ownership, resident guards and cancellation remain the authority.

Native drag sessions are detected and cancelled with an unconfirmed-drop
refusal. Tk raw pointer input refuses at runtime. Web keyboard-scroll fallback
requires confirmed page/scroll-area focus and refuses text controls. Menus use
exact, unique parent-scoped titles at arbitrary depth with cleanup on failure.
No competing tool, browser registry, input owner or model loop was added.

On macOS 26.1, the installed signed development helper and the global
Codewhale plugin were exercised against disposable Electron 45.2.1 and Chrome
156.0.8078.76 fixtures. Electron passed hover, both drag types, six-level menu
invocation, missing/disabled/duplicate menu refusals with cleanup, keyboard
scroll and cursor/foreground isolation. Chrome passed the same gesture and
scroll effects; it was initialized in foreground before control was measured
in background behind a separate disposable front fixture. That does not
qualify a cold background Chrome launch. Chromium 136.0.7075.0 exposed browser
chrome but no usable page AX tree and remains unqualified. Native AppKit drag
cancellation and Tk 9's refusal were confirmed with independent fixture state.
A renderer that overwrote its main-world geometry, visibility and JSON
functions could not spoof the isolated geometry read. Separate no-endpoint
proof confirmed refusal before pointer input.

Real Codewhale/DeepSeek evidence and exact source fingerprints are retained in
`CW/artifacts/cu-phase3-20261031/REPORT.md`. Hardware input interrupted some
instrumented attempts; those are retained separately from uncontested task
receipts. Other macOS versions, off-Space input/capture, a live locked screen,
broad Electron application coverage and a notarized release of this candidate
remain unqualified. Published 0.14.0 is unchanged.

## Reference versions

| Component | Version | Release commit |
| --- | --- | --- |
| [Cua Driver](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.34.0) | 0.34.0 | `b0968e1b12834e485dda68789541a3cc57664a9f` |
| [Base SDK / CLI](https://github.com/trycua/cua/releases/tag/cua-sdk-v0.3.1) | 0.3.1 | `3f01aec64307e989c5e10e73c9af68f91f94c13e` |
| [Spaces app](https://github.com/trycua/cua/releases/tag/cua-spaces-v0.7.0) | 0.7.0 | `e5c86b47ecbe9409a26a4eb954b32cd8c4ae9c28` |
| [spacesd](https://github.com/trycua/cua/releases/tag/cua-spacesd-v0.5.3) | 0.5.3 | `0d274d0d428ebb7c9f1345c377028c2315eecc2b` |

Driver's release notes explain that its GitHub prerelease badge reserves the
monorepo's Latest pointer; ordinary Driver SemVer is its stable channel.
Newer website documentation must not be assumed to describe every released
Spaces feature.

## October 6–8 Driver source integration

The review also covers unreleased Driver source through
[`4cbd0966c`](https://github.com/trycua/cua/commit/4cbd0966c5054753c22c2800157709ad4d3ca3ce).
These commits are newer than stable 0.34.0. Codewhale implements the useful
contracts in its existing tools; no upstream implementation is imported.

| Upstream change | Codewhale integration |
| --- | --- |
| [Slim observations and diffs #4743](https://github.com/trycua/cua/pull/4743) | `get_app_state {since:state_id}` or `since:"latest"` compares the same complete view. Full raw records remain available for live element revalidation. Scope changes, expired states and truncated walks/views return a full baseline. Diffs do not bind captures. |
| [Named batch targets #4820](https://github.com/trycua/cua/pull/4820) and [reliable batch shapes #4859](https://github.com/trycua/cua/pull/4859) | Existing `run_actions` accepts `args` as an alias and `find:{query,role,app_ref,window_id}` for a fresh unique lookup. Zero/multiple matches and stale elements refuse before input. Every action uses the existing consent, grant, route, lease and target gates. No action is automatically retried. Optional `observe` returns final state. |
| [Whole-window query #4855](https://github.com/trycua/cua/pull/4855) | The macOS adapter now forwards query/role to the native walk's existing deeper budget. Response limits remain post-filter limits. |
| [macOS key spellings #4858](https://github.com/trycua/cua/pull/4858) | Named keys normalize spaces, underscores and hyphens, with common arrow/page/keypad aliases. Single-character punctuation keeps its original mapping. |
| [Display-only previews #4881](https://github.com/trycua/cua/pull/4881) | Existing macOS preview polling is already separate from MCP observation state and raster pins. No new tool alias or competing capture cache is added. |

Batches validate plan shape before starting, stop on wait timeouts, and report
completed steps and known/unknown input delivery. The wait's returned state
must still satisfy its predicate. A failed final observation does not undo
earlier effects; per-call runtime checks can still refuse after earlier steps.
Named uniqueness and absence cannot be inferred from truncated walks. A closed
app satisfies an absence wait without producing a targetable state.
Failed wait rechecks remain ephemeral: they cannot replace the last usable
targeting state or evict pinned states. Batch aliases cannot select another computer.
Trajectory redaction and saved-capture refusal cover both
argument spellings. Named lookup requires uniqueness; it does not infer a
control from an ambiguous label or retry a previously dispatched action.

Wayland EIS delivery acknowledgements, optional perception/model extensions,
cursor-motion planning and broader native Windows/Linux behaviors remain
separate work. Source/protocol checks are not installed-helper, real-model,
cross-platform-native or release qualification.

## Existing authority and concrete gaps

The canonical plugin owns computer-use tools and packaged operating guidance.
Engine owns sessions, tool approval, model-visible context and receipts.
Keep those owners when adding capabilities. A Cua-style workflow must use
Codewhale's existing computers and provider lifecycle rather than introducing
another account, agent loop or registry.

| Capability | Codewhale source | Remaining proof or implementation |
| --- | --- | --- |
| App discovery and observation | `list_apps`, `list_windows`, `get_app_state`, OCR and state IDs | Actual native app/toolkit catalog and exact installed release |
| Semantic actions | Revalidated element identity, consent and background refusals | Continuous human coexistence; broader Windows/Linux qualification |
| Pixel capture identity | `raster_id` pins screenshot/OCR/zoom coordinates; stale pins refuse | Pins are optional for legacy clients and do not prove unchanged UI |
| Nested zoom | Server supplies the exact bound parent file to each backend | Native crop/image fidelity per platform; mocked transport proof is narrower |
| Browser control | Isolated browser here; signed-in Chrome through Chromewhale | Frame/navigation/download parity on the installed host |
| Human takeover | Existing pause/stop, lease and cancellation gates | Real contested-input and interrupted-action receipts |
| Separate desktops | Task-owned Docker desktop, registered SSH computers | Persistent cloud lifecycle and an actual remote task |
| Shared desktop viewing/files | Existing app preview and recordings | Scoped viewers, team presence, streaming and transfer capabilities |
| Persistent agents | Engine task/session authority remains the owner | Crash continuation and computer replacement acceptance |

Cua's [Driver tool contract](https://cua.ai/docs/cua-driver/reference/mcp-tools)
offers exact targets, capture-bound actions and structured action outcomes.
Codewhale uses its own advertised schemas: `raster_id` is not an alias for
Driver's `capture_id` or spacesd's `screenshot_id`. Codewhale pins are reusable
while current; they do not implement Driver's capture consumption contract.
Never prescribe upstream tool names to a Codewhale model.

## Teaching delivered by this slice

The existing `initialize.instructions` and five reviewed MCP resources carry
the updated guide. No second prompt source or training service is introduced.
It teaches models to carry the observed raster ID, use child IDs after zoom,
re-observe after replacement or UI changes, verify delivery and preserve all
permission, human-control and consequential-action gates. An omitted image
still cannot supply coordinates. OCR targets carry the same pin automatically.
The recording resource teaches the same contract. Saved capture-dependent
trajectory steps are marked non-replayable, including older files without that
marker; review and replay never strip or remap a pin to authorize new input.

`target_raster_id` records the conversion source; `parent_raster_id` records
the zoom source. A changed computer route or app bind retires capture context.
Coordinates without a pin retain compatibility with older clients; the new
guide never recommends dropping a pin to recover from a refusal.

## Qualification using the existing suite

Reuse [PARITY.md](PARITY.md)'s native fixtures, task DSL, independent oracles,
interference probes and retained retries. Add coverage to that suite as new
capabilities land. Do not create another model loop or hand-edit success rows.

The first source checks cover helper/direct/remote capture replacement, OCR,
child geometry and trusted crop sources, malformed/other-computer pins, route
retirement and no input on refusal. These mocked checks do not operate a real
desktop or establish behavioral parity. Native acceptance must also cover
multiple windows, changing focus, Unicode/IME, missing permissions, human
Pause/Stop, unknown delivery outcomes and file preservation on remote stop.

Keep Windows/Linux experimental until their existing release gates pass.
Cua's [platform matrix](https://cua.ai/docs/cua-driver/concepts/platform-support)
also distinguishes compositor, browser and app-family support; a cross-platform
binary is insufficient evidence for every native behavior.

## Spaces adoption boundary

The upstream [license map](https://github.com/trycua/cua/blob/7d69b8d80ccfb1a3f9ae747d63bc1ae237a0a406/LICENSING.md)
distinguishes MIT Driver/base SDK from FSL Spaces, spacesd and streaming
components. Its [commercial policy](https://github.com/trycua/cua/blob/7d69b8d80ccfb1a3f9ae747d63bc1ae237a0a406/COMMERCIAL.md)
requires commercial licensing for hosted or managed offerings built on Spaces.
This slice imports no Cua implementation. Use MIT components only after normal
dependency review; Spaces is a workflow reference until adoption is separately
decided. Keep credential transfer, viewer access and data retention explicit.

## October 31 performance source candidate

The macOS helper now executes ordinary native commands on a bounded serial
queue in the existing resident process. Its focus/menu monitor remains on its
own queue. Cancellation, timeout and owner disconnect cancel outstanding work;
each command releases its kernel input lock before replying. Held gestures
retain their dedicated owner pipe. Chromium gestures revalidate retained AX
window/web objects through that owner and check the isolated renderer's live
geometry, visibility and navigation/context events at every step. Older helpers
keep their existing per-call behavior.

The batch contract declares exact step names, resolves both named drag ends
from one fresh observation, reports rejected plans as zero completed steps/no
input, and returns a diff against the latest compatible view by default. The
4,093-byte guide recommends existing host composition for loops/branches and
uses `request_access` for diagnostics rather than requiring a probe per task.
Every action still passes its normal permission, consent, route and target
checks; a batch does not retry delivered or unknown input.

This follows the persistent-driver and composed-workflow direction in Cua's
[workflow guide](https://github.com/trycua/cua/blob/38dad235d3aa1aed0ef080a54de317953d324822/libs/cua-driver/rust/Skills/cua-driver/WORKFLOW.md),
[batch hint](https://github.com/trycua/cua/blob/38dad235d3aa1aed0ef080a54de317953d324822/libs/cua-driver/rust/crates/cua-driver-core/src/batch_nudge.rs)
and [state views](https://github.com/trycua/cua/blob/38dad235d3aa1aed0ef080a54de317953d324822/libs/cua-driver/rust/crates/cua-driver-core/src/window_state_view.rs),
reviewed at that pinned commit. The Engine's existing `execute_tools` VM owns
branching composition; no second model loop or scripting VM is added here.

On the measured macOS 26.1 / Electron 45.2.1 fixture, three hovers and six drags
(pointer capture and HTML5) per variant gave these tool-call medians:

| Operation | Prior source | Resident candidate |
| --- | ---: | ---: |
| Hover | 695 ms | 538 ms |
| Drag | 2,800 ms | 1,410 ms |

The resident candidate also confirmed native nested-menu execution and AppKit
Set Value/Apply. Its full live fixture run retained the cursor and foreground
across 1,532 independent samples. A later corrected accessibility label let
hover, drag and verification complete in one 1.90-second batch; that run's
whole-desktop cursor check was contested. Move/navigation during a drag
refused, and a cancelled drag released capture after two moves without a drop.
The cancellation client's original wait for a cancelled RPC response timed
out; that harness failure is preserved separately from the observed cleanup.

Existing focused checks passed (78 protocol/browser/transport/guide checks;
57 native checks; one opt-in live-window check skipped). The final batch-contract fix passed
the 44 affected existing checks, and the final guide passed its 11 checks.
An additional native protocol proof using existing synthetic primitives passed
11/11, including queued cancellation, timeout, lock release and pipe EOF.

A real installed Codewhale 0.10.2 / DeepSeek `deepseek-flash` controlled workflow
completed all five steps in one batch call in 10.11 seconds, with two provider
requests and independent hover/drag oracle confirmation. Provider requests
accounted for 4.97 seconds and the tool for 2.45 seconds; 2.69 seconds remained
outside those intervals. A prior variant with a diagnostic probe took 11.05
seconds and two tool calls. These runs were explicitly instructed to compose
the known steps. The target never became foreground and no physical key
events occurred; other pointer activity contested a whole-desktop idle claim.
This is not an unconstrained-planning speedup or a comparison against identical
original harness conditions. The original harness omitted batching and host
composition, and its fixture hid a changed visible label from AX.

These are signed development-source results after published 0.14.0. They do
not qualify a new release, other macOS versions or the remaining platform,
locked-screen, off-Space and upgrade/accessibility gates.
