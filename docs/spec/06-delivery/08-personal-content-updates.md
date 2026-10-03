# Personal macOS release and content-update contract

Scope: public `imdp2023/oh-my-pi`, macOS arm64, personal distribution only.

The display name is `oh-my-pi` as of release 0.16.1 / shell 1.0.1. Native
bundle/executable and DMG/ZIP names follow that display name. Installation IDs,
update keys, the personal profile `PI-Desktop Personal` and data root
`~/.pi-desktop-personal` do not change with branding. Legacy installed/development
profiles likewise retain their existing storage names. A rename of the native
bundle requires a shell install rather than content-only activation.

## Release identity

`release-version.json` is the human-edited release input. Its `version` is a
stable SemVer; `apps/desktop/personal-build.json` supplies `shellVersion` to
independently identify the fixed loader/runtime contract. The
build prepares package/app version surfaces consistently without committing CI
generated files. A normal code push without a version change does not publish.
Existing published versions are immutable. Trusted `main` builds test and stage
all artifacts before making a release discoverable.

## Wire format

- `content-manifest.json`: exact UTF-8 bytes signed by Ed25519.
- `content-manifest.sig`: base64 signature over those bytes.
- Manifest: `schema: 1`, `version`, `shellVersion`, `compatibility` (SHA-256),
  `platform: darwin`, `arch: arm64`, exact artifact name
  `content-<version>-darwin-arm64.json.gz`, `size`, `sha256`.
- Payload: gzip JSON `{schema: 1, files: [{path, data}]}`; data is canonical
  base64. Only `out/` and `agent-runtime/` regular entries are accepted. No
  traversal, absolute paths, hidden entries, duplicate/case-colliding paths or
  native library/executable suffixes. Required main, preload, renderer and sidecar
  entries must exist. Compressed limit 256 MiB, expanded JSON limit 512 MiB.
- All network requests use HTTPS. Redirects are bounded and restricted to the
  configured GitHub release paths and GitHub asset hosts. Responses are streamed
  with byte/time limits. No credential is embedded in the client.

## Activation

1. Check verifies the manifest signature before trusting version/URLs/compatibility.
2. Download verifies payload length, digest and contents, then stages an immutable
   version directory. Current execution and activation pointer are unchanged.
3. Explicit restart rejects busy agent/live-work state and persists `pending`.
4. Bootstrap verifies again, creates a fresh run directory and writes `trial`
   before importing that release. Dependencies and native resources stay fixed.
5. Host plus renderer health acknowledgement writes `active` and clears `trial`.
   Unacknowledged trials roll back on the next launch. Failed versions are not
   automatically retried. A newly installed shell never boots older content.

No automatic install on quit. User data is outside the version directory. No
database restore/downgrade is implied by content rollback. Runtime/native/Rust/
database-incompatible releases use full shell installation instead.

## Verification gates

Unit tests cover signed inputs, tampering, path/size boundaries, compatibility,
network redirects, pointer transitions, cancellation and preservation of old data.
The Electron fixture exercises the production bootstrap, external module
resolution, lazy renderer assets, successful activation and next-launch rollback.
The complete Actions build plus first installation must be verified separately;
do not report local fixture success as a deployed or published update.
