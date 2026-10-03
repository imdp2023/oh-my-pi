# Personal macOS shell and signed content updates

Status: Accepted for the imdp2023 personal distribution.

## Context

The fork owner requested public GitHub Actions builds on release-version changes,
macOS arm64 only, and content updates without reinstalling Electron or purchasing
an Apple Developer certificate. The owner explicitly requested development on
`main` for this task, overriding the request-worktree workflow. This does not
authorize publishing secrets, bypassing OS protections, or weakening agent tools.

Replacing a running renderer directory reproduces missing lazy-module errors.
Replacing a signed app bundle in place also changes OS-integrity inputs. Updating
only the renderer cannot keep the main/preload/sidecar contract coherent.

## Decision

Use a distinct personal packaging lane with an immutable, ad-hoc-signed Electron
shell, physical packaged production dependencies (`asar: false`) and a fixed
CommonJS bootstrap. The existing upstream signed distribution remains unchanged.
The personal bootstrap owns a release-key trust root, bounded HTTPS downloads,
signature verification, compatibility checks and atomic activation pointers.

Content releases contain main, preload, renderer and agent-runtime JavaScript as
one versioned, gzip-compressed JSON file. Archive entries are regular files only;
paths, byte limits, checksums, signatures and required entry points are validated
before extraction. The shell embeds the public Ed25519 key. Only CI receives the
private key. This signature is independent of Apple signing and is not optional.

Verified content is extracted into a fresh run directory outside the application
bundle. Its `node_modules` points to the fixed shell's physical dependencies.
Rust, native libraries, Electron, packaged resources and the loader remain in the
shell. A conservative source fingerprint plus shell version rejects incompatible
payloads. Database/Rust migrations therefore require a new shell, not rollback of
a mutated database. Installer and payload versions share the release input.

Download does not activate anything. Explicit restart sets a pending pointer;
startup checks again and records a trial before importing code. Only a successful
host/renderer readiness check commits the trial as active. If startup fails before
that acknowledgement, the next launch selects the previous known-good version or
the embedded baseline and suppresses the failed version. No active directory is
overwritten. This is restart-time content replacement, not live code injection.

## Alternatives

1. Keep electron-updater and Apple Developer ID signing: less custom machinery,
   but contrary to the personal no-certificate requirement.
2. Overwrite `app.asar`/renderer files in place: rejected for integrity, stale
   assets, interrupted writes and insufficient rollback guarantees.
3. Independently patch arbitrary files including native code: rejected for the
   first version; multiplies ABI, migration and OS-permission risks.

## Consequences

The first install is manual. Future compatible updates reuse Electron and native
dependencies but still require a restart. Native/runtime changes require a new
shell installer. macOS may require explicit first-open approval; the app does not
disable Gatekeeper or strip quarantine automatically. The personal profile is
separate from the original distribution and does not silently import its data.

Public releases and CI logs are public; no runtime profile or credentials belong
in either. A release with an absent signing key must fail closed. Only trusted
main-branch code may publish; external pull requests must not receive that key.
Initial cloud build/install verification remains a separate deployment gate from
local tests. A passing fixture does not prove an unsigned DMG opens on every Mac.
