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
