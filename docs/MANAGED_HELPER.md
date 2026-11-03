# Helper lifecycle inside Codewhale

This source contract lets the containing desktop update its nested helper.
It reuses the helper's host challenge, socket-owned sessions, registration,
cleanup queue and native human controls. It introduces no MCP tool, backend
operation, private-key store or additional lease authority. Published 0.16.0
does not implement this protocol; its signed bundle remains a separate cohort.

## Desktop identity and first launch

Load the fixed bundled `src/app-socket.mjs` implementation in the desktop's
main process. Keep a random 32-byte installation seed in the desktop's existing
encrypted credential storage, independent of account sign-out, with no plaintext
fallback. Do not log or expose it to the renderer or model. The library does
not persist the seed or export its derived private key.

Call `setAppHostIdentity({ledgerKey: Buffer, label: string})` before opening any
session. `appHostPublicKey()` returns only the derived Ed25519 public SPKI as
base64, and refuses an ephemeral identity.

`bootstrapManagedApp({bundlePath, expectedBuild, expectedVersion})` checks the
physical helper location inside its containing `.app`, the on-disk runtime
fingerprint and plugin version. It launches through `/usr/bin/open -n -g`
with explicit `--env CODEWHALE_CU_DESKTOP_OWNER_KEY=<public SPKI>`. Configured
isolated CU state/socket variables also use explicit LaunchServices environment
arguments. A plain environment on the `open` process is insufficient.

The daemon requires its existing inherited native control channel and that its
loaded plugin physically belongs to that helper. It pins the public key and
containing application in the existing atomic, fsynced `app.json` registration.
Later helper/desktop restarts retain that pin; a different key or physical
installation refuses. Bootstrap is not computer-access approval and cannot
change human Pause/Stop or existing host trust.

An existing unowned, unsupported or wrong-build helper is preserved and
refused. The initial migration owner must close it through existing native
controls and install a separately qualified managed-capable bundle. Neither a
PID nor a `list_sessions` result authorizes terminating it.

## Authenticated messages

Use existing `openAppSession(sessionId)` and `appSessionRequest(request, options)`.
They own the live lease socket and perform the existing Ed25519 challenge.
The manager's session ID must be unique to its desktop process. Update messages
require that session's live token and proof of the pinned persistent key.
Different Engine/MCP host identities must close their leases before preparation.

```js
{
  tool: "managed_update",
  sessionId,
  action: "status" | "prepare" | "retire" | "complete" | "abort",
  updateId,
  currentBuild,
  nextBuild,
  nextVersion
}
```

`status` needs no transaction fields. Other actions need `updateId`, a UUIDv4.
`prepare` additionally requires the exact running `currentBuild`, staged
`nextBuild` (16 lowercase hexadecimal characters each) and `nextVersion`.
Package metadata must bind the next fingerprint/version to the verified
containing application; Squirrel/native staging validation precedes preparation.
Messages contain no executable path, arbitrary launch argv or process signal.

Successful replies contain `{ok:true, managed, control:{mode,cleanupPending}, app}`.
Failures contain `{ok:false,error:{code,message},managed}`. `hello.app` advertises
`managedUpdateProtocol:1` and content-free `managed` state:

```js
{
  protocol: 1,
  publicKey,
  container,
  helperBundle,
  phase: "idle" | "draining" | "drained" | "retired",
  updateId,
  currentBuild,
  nextBuild,
  nextVersion
}
```

Transaction fields are absent in idle state. The public key is not private
credential material. Ownership, cleanup and unknown-outcome failures stay
distinct from a successful retirement.

## Drain, retirement and replacement

Preparation checks all live leases synchronously before awaiting anything.
A foreign authenticated host, absent/nonpersistent key, unproved key, pending
consent/exclusion operation, background check or native cleanup refuses busy.
Nothing is killed. The eligible transaction writes its admission fence before
aborting queued work and awaiting existing session/input cleanup. Only verified
cleanup reaches `drained`; a cleanup or storage failure remains blocked.
New ordinary leases/actions refuse while pending. The pinned owner may
reconnect and authenticate for recovery. Native Pause/Stop and cleanup remain
available, while native practice checks cannot start during the update.

`retire` binds the same transaction and commits the old helper to exit.
Its successful response follows final cleanup, listener retirement and removal
of its own run receipt. Keep the existing `openAppSession` lease and require
both that matching successful response and closure of that exact lease socket
before allowing the containing application's native replacement. Socket closure
alone can be a crash or cancellation. A timeout before the successful response
does not establish retirement. Do not use a later PID lookup or SIGTERM.

After retirement commitment the old process cannot race an abort/completion to
clear the fence. Its native launcher exits with the daemon. The desktop's
existing OS/package updater owns atomic outer-app replacement and rollback;
the nested helper does not alter the signed containing bundle.

## Recovery and completion

The public owner pin and pending transaction survive desktop/helper exit in
the existing registration. Ordinary `ensureApp`/`launchApp` cannot auto-launch
a pending helper. Read `readRegistration({strict:true})` for recovery; invalid
registration fails closed rather than silently losing the fence.

`launchManagedApp({updateId,action:"complete"|"abort"})` requires the same
persistent desktop identity. It checks the physical path and on-disk next
fingerprint/version for completion, or old fingerprint for rollback. It uses
the same explicit LaunchServices environment path. A different running helper
is refused, never terminated. The checked launch returns that exact helper's
hello identity; it does not clear the fence.

On the newly started helper, `complete` requires retired phase and exact
running/on-disk next identity. `abort` requires exact old running/on-disk
identity after cancellation or outer rollback. Both settle cleanup before
clearing only that transaction. Neither resumes persisted Pause/Stop nor
replays old work; old leases stay stopped. If old and next fingerprints are
equal, completion still requires retirement and a fresh process.

An owner disconnect does not remove the fence. Inspect status after an unknown
response. Matching preparation can report/retry its durable phase; interrupted
draining can be retried or aborted after cleanup. Unknown/missing disk identity
stays fenced for the containing application's updater to repair. Never choose
completion merely because the desktop version changed.

## Evidence boundary

Source protocol controls use isolated recording backends and fake nested app
trees. They cover ownership refusals, admission fencing before blocked cleanup,
held-work cancellation, human Pause/Stop, ordered retirement, exact replacement,
cleanup/storage failures, crashes and recovery. Existing session, consent,
shutdown and control regressions remain separate checks. These do not qualify
LaunchServices bootstrap, signed package updates, permission attribution,
mounted installs or real saved-app outcomes. Those belong to the desktop and
packaging owners' exact-artifact acceptance before release.
