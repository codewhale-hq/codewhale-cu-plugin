# Plugin and native helper distribution

Release status is recorded in [CHANGELOG.md](../CHANGELOG.md). The published
0.12.0 release includes the notarized macOS helper. The 0.13.0 working tree is
a candidate: its native app has been built and signed, but live qualification
and publication remain pending.

Computer Use is an ordinary plugin, installed and updated through Codewhale's
**Connectors** from a stable published release using the existing plugin
installer. The separate native helper owns macOS permissions, approval and
Pause/Stop controls. Neither component is embedded in Engine, and neither
requires an Engine release to update.

The 0.13.0 candidate plans a portable `computer-use.tar.gz` asset alongside the
native installers in this repository's stable release. That asset is not yet
published. It supplies the plugin runtime, MCP entry point and skills for the
existing installer. Native app updates continue through its own updater.

The public entry point is [codewhale.net/computer-use](https://codewhale.net/computer-use).
The plugin marketplace links there; this repository's GitHub Releases stores
the versioned files. The website reads only this repository's latest
non-draft, non-prerelease release. With GitHub API access it requires a tag
`vX.Y.Z`, exactly one `Codewhale-Computer-Use-X.Y.Z-macos-universal.zip` (at
most 256 MiB) and exactly one `release.json` (at most 16 KiB) uploaded at the
canonical download URLs, and `release.json` fields `version`, `archive`,
`platform`, `arch`, `notarized`, `sha256` and `size` matching the tag and
GitHub's own SHA-256 asset digest. A missing release shows pending; a failed
check shows unknown.

The standalone download carries its native launcher, accessibility helper,
practice app and Node 24.21.0 for Apple silicon and Intel. It requires macOS
13.5+. No Node installation, compiler, npm install or terminal setup is needed
to open the downloaded app. Codewhale launches the installed plugin through
its existing connector system; other MCP hosts use their own server launch
configuration. The separately installed helper owns local input once
registered. On macOS, a missing helper returns `app_setup_required` before
computer access, with instructions to install it and open it once.

## Build and qualify

```sh
npm test
node scripts/prepare-node-runtime.mjs
node scripts/build-app.mjs --platform macos --node-runtime dist/node
node scripts/package-macos.mjs --notary-profile YOUR_SAVED_KEYCHAIN_PROFILE
node scripts/package-dmg.mjs --notary-profile YOUR_SAVED_KEYCHAIN_PROFILE
```

`package-dmg.mjs` builds the drag-to-Applications disk image from the stapled
app: a branded window (`assets/macos/dmg-background.svg`, rendered to the
tracked 1x and 2x PNGs), the app icon and an Applications shortcut. It needs
[dmgbuild](https://github.com/dmgbuild/dmgbuild) on the build Mac (`pip install
dmgbuild`, or pass `--dmgbuild <path>`), which writes the Finder layout
directly instead of scripting Finder. The image is Developer ID signed,
notarized as its own submission, stapled, checked with Gatekeeper, mounted
and inspected, then recorded under `dmg` in `release.json`.

`npm run build:branding` rewrites the tracked PNG assets and is only for
artwork changes; it is not part of the release sequence. `npm ci` is only
needed to run the tests, since the runtime has no npm dependencies.

Node downloads are pinned by version and the hashes in `app/node-lock.json`.
Only the fixed binary and license members are extracted from verified Node
archives. The universal runtime is signed with a JIT entitlement; the other
native executables do not receive that entitlement.

Packaging requires a Codewhale Developer ID signature, submits to Apple's
notary service using an existing Keychain profile, waits for **Accepted**,
staples the app and checks Gatekeeper. A failed or missing notarization does
not produce a release archive. Keep `notarization.json`, `release.json` and
`SHA256SUMS.txt` alongside the archive as release evidence. See
[Apple's notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow).
Omitting `--notary-profile` re-packages an already stapled candidate without a
new submission and writes `submissionId: null`; a published release must be
packaged with `--notary-profile` so the receipt names the accepted submission.

The archive is named `Codewhale-Computer-Use-VERSION-macos-universal.zip` and
the disk image `Codewhale-Computer-Use-VERSION-macos-universal.dmg`. Publish
both, `release.json` and `SHA256SUMS.txt` together with a stable `vVERSION`
release in this repository after every applicable gate in
[the release checklist](RELEASE_CHECKLIST.md) has a recorded result. The
website offers the disk image as the download when `release.json`'s `dmg`
entry and GitHub's SHA-256 asset digest agree, and the archive otherwise; the
updater always downloads the archive, verifies it against GitHub's digest and
does not read `release.json`; `SHA256SUMS.txt` is a human-readable receipt
that no code consumes. Keep the release draft until these four assets and,
for 0.13.0, the portable plugin asset have uploaded and their applicable
checks have passed. The website refreshes
availability within five minutes of publication; no hard-coded website version
needs to change. Packaging does not tag, publish, or change
the separate Codewhale Engine release. The same release may carry an explicitly named unsigned Windows x64 preview
ZIP and its source/hash receipt. It is experimental, not a signed production
installer. Linux remains source/Docker-based; physical-device and signing
qualification are separate from source and CI checks.

## Installation and updates

Install and update the plugin through **Connectors**, selecting a stable
published plugin release. For the native helper, open the disk image and drag
the app into Applications. Open it once to register the helper, then use its
setup panel. The versioned macOS archive on the same release is what **Check
for updates…** installs; `computer-use.tar.gz` is the separate portable plugin
asset planned for 0.13.0. Restart plugin connections after an update so they
use the installed version. Changing a source checkout updates neither the
installed plugin nor the native app.

For a developer build, `npm run install:app` installs in `~/Applications`.
It stages and verifies the complete app before replacement and retains the
previous bundle. A self-contained bundle is copied without changing its
notarized resource seal. Developer builds without bundled Node pin the local
runtime and are signed again before installation.

**Check for updates…** contacts this repository's GitHub Releases only when
clicked.
The updater offers stable, newer versions with an exact asset name and a
[GitHub SHA-256 asset digest](https://docs.github.com/en/rest/releases/assets).
Choosing **Install VERSION…** downloads a bounded archive, validates its
paths before extraction, then checks the digest, bundle version, Codewhale
signing team and Gatekeeper's notarized Developer ID verdict. Stapled-ticket
validation happens during packaging, so consumers do not need Xcode. It stops input, retains
the previous app and restarts. Existing sessions stay stopped. There is no
background polling or silent update installation.

The inline catalog icon is a bounded PNG data URI, at most 32 KiB and 256 by
256 pixels. It is display metadata, never a trust grant. Browsing artwork
does not fetch a publisher URL or render executable SVG content.
