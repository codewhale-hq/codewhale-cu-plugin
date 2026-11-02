# Learning from agent-desktop

Reference inspected: `vercel-labs/agent-desktop` commit
[`9eb9b296192fcb70bda25e918cd6dd66abfa3d0d`](https://github.com/vercel-labs/agent-desktop/tree/9eb9b296192fcb70bda25e918cd6dd66abfa3d0d),
November 1, 2026. This comparison concerns source behavior, not a benchmark or
cross-platform qualification of either project.

| Principle | Codewhale CU 0.15.0 |
| --- | --- |
| Retain native AX objects so a replacement cannot inherit a reference | Adopted in the existing macOS resident helper. Observations keep their original AX objects and application launch identity. Resolution and semantic dispatch compare the live object with that retained identity, in addition to role and label. |
| Bridge native windows to exact WindowServer IDs | Adopted for ordinary native windows, with live owner and geometry validation. This avoids confusing a reopened document with a retained same-sized backing window. Hosted sheets keep their existing route. |
| Scope element references to observations | Existing `state_id` and per-computer observation caches remain the public contract. Internal native tokens are bound by the server and omitted from model-facing views. The helper retains 24 observations; expiration or restart requires a fresh observation. |
| Refuse ambiguity instead of choosing a nearby target | Existing named batches require one match and reject incomplete observations. Native paths that reorder or identify a different object now refuse even when the labels match. No broad search or nearest-control fallback is added. |
| Observe after dispatch and never replay uncertain delivery | Existing action receipts, `outcome_unknown`, cancellation cleanup, `wait_for` and batch end observations remain the authority. Dispatch alone does not prove the requested effect. |
| Keep the agent loop in the host | CU continues to use the Engine's existing composition and session authority. No additional agent loop, provider dependency or desktop daemon is introduced. |

The reference's retained-object implementation is
[`crates/macos/src/tree/resolve/retained.rs`](https://github.com/vercel-labs/agent-desktop/blob/9eb9b296192fcb70bda25e918cd6dd66abfa3d0d/crates/macos/src/tree/resolve/retained.rs).
Its native window bridge is
[`crates/macos/src/system/window/window_bridge.rs`](https://github.com/vercel-labs/agent-desktop/blob/9eb9b296192fcb70bda25e918cd6dd66abfa3d0d/crates/macos/src/system/window/window_bridge.rs).
Its process-instance validation is in
[`crates/macos/src/tree/resolve/mod.rs`](https://github.com/vercel-labs/agent-desktop/blob/9eb9b296192fcb70bda25e918cd6dd66abfa3d0d/crates/macos/src/tree/resolve/mod.rs).
The implementation here is independently written for Codewhale's Objective-C
helper and MCP runtime; no reference source is vendored or executed.

## Boundaries

Retained-object checks qualify semantic targets observed through the matching
macOS helper. Older helpers without native tokens retain their previous checks.
Standalone helpers cannot carry an observation into a different process; those
tokens fail closed. A native object may keep its identity while changing its
meaning, so label validation and fresh effect observation still matter.

Pointer gestures validate the observed object before entering their dedicated
input owner, then retain their existing window, geometry and renderer guards.
They do not acquire a cross-process native-object lease. Screenshots and raw
coordinates retain their separate capture identity and cannot prove an
unchanged UI. Windows UIA and Linux AT-SPI qualification remain separate.

The reference's larger locator language, skeleton/drill-down observations,
desired-state commands and unified delivery vocabulary are useful further
research; this release does not claim to implement them.

## Qualification method

An identical disposable AppKit application demonstrated the old runtime
activating an identically named replacement through a stale reference. The
candidate refused that reference with `element_stale` and unchanged action
counters, while a fresh reference worked. This is a matched defect experiment,
not a general performance comparison.

The real TextEdit workflow required editing a task-owned document, verifying
its saved UTF-8 bytes independently, closing it, reopening it and reading the
same text through accessibility before closing it again. This exposed the
native multiline value-write defect and the reopened-window routing defect;
neither was established by a setter's immediate readback alone.

Electron hover, pointer drag and HTML5 drop were checked through independent
renderer effects and trusted-event evidence, with fresh observations after UI
changes. Setup assertions do not count as additional successful workflows.
An invalid-arguments error cannot qualify an ambiguity refusal, stale oracle
files cannot establish readiness, and missing controls in a truncated response
cannot establish absence. Earlier invalid and interrupted attempts remain in
the local qualification record. No unconstrained model-planning result or
whole-desktop cursor-invariance claim follows from these runs.


## End-to-end efficiency after installation

The published 0.15.0 helper was subsequently installed globally and used by
Codewhale with real DeepSeek `deepseek-flash` on a task-owned TextEdit document.
The goal supplied the desired text and target process/window, without a tool
recipe. Acceptance required independent saved UTF-8 bytes, then closing and
reopening the exact document in a fresh process and reading the same text.

The first installed-Engine run took 188.352 seconds and 32 provider requests.
It passed the saved-result check but exposed inefficient discovery, input
before binding, repeated disabled-menu commands and restrictive guard
feedback. It is a functional result, not an efficiency qualification.

The post-release source changes expose common batch argument shapes directly
from the existing tool schemas and distinguish read scope from input binding.
They correct the background Save guidance: a document-targeted key confirms
its exact app key window; an app menu can be disabled without one. Compact
observations now flag shortened labels and values instead of presenting them
as complete text. No second runtime or permission path is introduced.

The later Cua Driver review simplified the same interface: rows now carry
opaque observation refs, discovery advertises canonical batch names, and text
replacement/insertion/selection have distinct contracts. Engine's existing
composition runtime also normalizes bare JSON MCP results into `.content`;
rich results and original receipt/spill accounting remain intact. No additional
agent loop or script runtime was added.

| Installed/development experiment | Seconds | Provider requests | Saved bytes and fresh-process reopen |
| --- | ---: | ---: | --- |
| Original installed Engine and published CU | 188.352 | 32 | Passed |
| Optimized Engine, original CU API, stopped diagnostic | 91.472 | 23 | Not an accepted completion |
| Exposed batch shapes and guidance | 27.854 | 7 | Passed |
| Global optimized CLI, patched user plugin | 35.039 | 8 | Passed |
| Pin only native batch; configuration rejected and reverted | 52.943 | 15 | Passed |
| JSON normalization and refs before text-contract correction | 147.025 | 26 | Passed; efficiency failure |
| Explicit text semantics and revised scoped dispatcher | 21.637 | 4 | Passed |

The 147-second attempt exposed an ambiguous omitted selection range, overly
restrictive focused-input test dispatch and confusion between the Engine's
outer return and `tools.call(...).content`. It is retained, not discarded as
noise. After correction, DeepSeek chose its own plan: read the existing note,
bind and observe in one batch, replace/save/observe in a second batch, and read
the saved file. It copied the returned ref directly, without speculative input
or a provided batch recipe. An independent operator then checked all 246 UTF-8
bytes and reopened the exact document in a fresh TextEdit process. The app
remained in the background during model execution; that does not establish
whole-desktop cursor invariance.

Task guards admitted only a dedicated app PID/window and task file. Later
experiments allowed reading that exact saved file, filled safe observation
scope defaults, admitted arbitrary task-field drafts instead of enforcing the
answer, and accepted focused input where normal dispatch supports it. The
latest note run supplied its own explicit action targets; its guard only filled
observation scope. These changes, different discovery settings and distinct
Engine builds prevent attributing a matched speedup to one change or claiming
general planner parity. All attempts remain in the qualification packet.

A distinct LibreOffice Calc task required correcting a quantity, adding
subtotal/total formulas, applying currency formatting, preserving a Unicode
note and saving XLSX. Its acceptance oracle read saved values, formulas and
number formats independently; the final workbook was not supplied in the
prompt. The first diagnostic was stopped after 151.842 seconds / 25 requests
because its test hook rejected valid focused input after a named click. The
corrected hook removed synthetic focus tracking. That trial failed after
128.103 seconds / 19 requests: reported cell input produced no saved changes,
a later semantic insertion failed, and Engine then stopped with an undeclared
tool-prefix drift assertion. The workbook stayed byte-identical to its seed.
These are failed outcomes and are retained alongside the successful note;
the short-note result does not qualify spreadsheet editing.

The subsequent native candidate unifies ordinary background keys and event
text on the existing confirmed-window route. A deterministic operator workflow
then saved the complete Calc budget correctly: every worksheet value,
requested formulas, currency styles and a fresh-process UI reopen passed.
The caller explicitly selected the current address before replacing it and
waited for a transient AX row instead of repeating input. Earlier failed
controls are retained. TextEdit also saved and reopened 39 exact UTF-8 bytes
including Chinese text and emoji through event typing. These prove native
routes and saved effects; they are not another DeepSeek success or a latency
comparison. A separately qualified Engine candidate fixed the demonstrated
C5 tool-change assertion. Its first Calc diagnostic was stopped after 92.793
seconds / 23 requests because a narrow grant blocked private target guards;
the workbook stayed unchanged. After that boundary was corrected, the next
run completed its Engine turn in 72.030 seconds / 16 requests but LibreOffice
crashed and again saved no changes. Cua's known VCL limitation and independent
controls showed unreliable background coordinate input. CU now refuses it
before either semantic point delivery or raw events, while keeping refs and
keyboard operations available. The matching refusal/keyboard control and 28
affected existing checks pass; this is still not a successful model workbook
journey. See [the Cua follow-up](CUA_PARITY.md#november-2-background-text-follow-up).

A later goal-only Calc run passed the complete independent saved-file oracle
and fresh-process reopen in 408.076 seconds / 79 provider requests. It is a
functional pass and an efficiency failure. A subsequent repeat failed at
69.900 seconds / 19 requests after an unconfirmed combo focus and select-all;
its saved file stayed unchanged. The current native follow-up reuses one
confirmed text-focus routine across click, focus, typing, keys and literal
replacement, preserving selection and stopping unconfirmed focus before later
input. Native saved/reopen controls and 28 affected existing checks pass;
two later runs on that source also passed every saved value, formula,
format and fresh-process reopen. They took 510.857 seconds / 119 requests
and 452.323 seconds / 72 requests. The first exposed a hook that rejected
supported repeated arrow keys; the second removed that duplicate validation.
Both are functional passes, not efficiency parity. The harness also
corrected the canonical resource-reader name and removed a forced window-zero
observation default. Those method changes prevent a matched speedup claim.

The default view now skips empty layout groups without removing them from
the native target cache or explicit searches. A passive same-workbook
comparison replaced 21 empty rows with useful controls at the same 80-row
limit. Full and explicit-role views and saved workbook bytes stayed identical.
The denser payload grew from 12,829 to 13,613 bytes; no token or latency
reduction is inferred from that observation.

These are local source/development measurements. Published 0.15.0 assets retain
their original source and signature. The operator's user plugin has unreleased
frontend/guide changes over the published helper, and the global CLI is a
local development Engine, not a published 0.10.3 release. The raw receipts,
failed controls and configuration transitions remain in the local
`cu-global-0150-20261101` and `cu-efficiency-20261101` artifact packets.
