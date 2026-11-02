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

A frozen optimized Engine with these schema/guidance changes completed one
ordinary task in 27.854 seconds / seven provider requests; a run through the
global CLI took 35.039 seconds / eight requests. Both independently passed
saved bytes and fresh-process reopen/read. Neither used a supplied batch
recipe. Pinning only the native batch was worse: 52.943 seconds / 15 requests,
also functionally successful; that configuration was reverted. A separate
91.472-second diagnostic with the original CU API was stopped after 23
requests and is not an accepted completion. The initial 188-second profile,
corrected guard feedback and changed discovery settings prevent attributing a
matched speedup to one change or claiming general planner parity.

These are local source/development measurements. Published 0.15.0 assets retain
their original source and signature. The operator's later user-plugin schema
patch and optimized Engine installation are separate from that release. The
raw receipts, failed controls and configuration transitions remain in the
local `cu-global-0150-20261101` and `cu-efficiency-20261101` artifact packets.
