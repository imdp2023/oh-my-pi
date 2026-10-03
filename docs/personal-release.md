# Personal macOS Release Lane

The `personal-mac-release` workflow builds only public `imdp2023/oh-my-pi`
macOS arm64 self-use releases. It uses an ad hoc signature (`identity: "-"`)
and does not notarize or modify the official production build configuration.
The GitHub-hosted `macos-14` arm64 runner is explicitly selected. Pull
requests never publish releases. A push to `main` starts this lane only when
the `version` in root `release-version.json` differs from the value in the
pre-push commit; `workflow_dispatch` can rerun a release manually. Tags use
the immutable `personal-vVERSION` format. The workflow creates a draft, uploads
the complete set of assets, verifies them, then publishes it.

## Signing key setup

Generate one Ed25519 key pair offline. Export the private key as base64 PKCS#8
DER and add it to repository Actions secrets as
`CONTENT_UPDATE_PRIVATE_KEY`. Put the matching public key as base64 SPKI DER in
`release-version.json` under `publicKey`, then commit a version bump. Do not
commit or print the private key. An empty public key deliberately makes builds
fail with a clear configuration error until an operator provisions a key. The workflow validates
that the secret and committed public key match before producing a payload.

## Artifacts

Each release contains a full `.dmg` and `.zip` shell installer,
`content-VERSION-darwin-arm64.json.gz`, `content-manifest.json`, and
`content-manifest.sig`. The detached Ed25519 signature is base64 over the exact
manifest bytes. The manifest includes the payload SHA-256 and a compatibility
fingerprint over Rust sources and lockfiles, Node dependency lock state, fixed
content-shell files, build metadata, packaged immutable resources, and build
scripts. Package/Cargo version-only fields are normalized so a version bump
does not change compatibility. The payload includes every regular file beneath
`apps/desktop/out` and `packages/agent-runtime/dist-bundle`, including generated
runtime chunks; it does not require a `package.json`. Payload limits are 256 MiB
compressed and 512 MiB uncompressed.

The generated `apps/desktop/content-shell-config.json` is build-only and is not
committed. The package adds `apps/desktop/content-shell/**`, uses
`asar: false`, `content-shell/launcher.cjs` as its main entry, and stores native
host files and runtime resources in their existing resource locations. The
personal app identity is `io.github.imdp2023.pi-personal`.

Run `node scripts/test-personal-release.mjs` to check trigger selection,
payload contents, bounds-related manifest metadata, and detached signature
verification without accessing GitHub or printing key material.
