# Personal macOS content updates

- Added a separate macOS arm64 personal distribution for `imdp2023/oh-my-pi`.
- A release-version change on `main` can trigger GitHub Actions to test, package
  and publish a complete release with a full first-install shell and a smaller
  signed content payload. Existing published versions are not replaced.
- Compatible updates download without modifying the running application and
  activate only on an explicit idle restart. Startup failure before the health
  acknowledgement restores the previous release on the next launch.
- Personal profiles are separate from upstream PI-Desktop data. Electron,
  native/Rust changes and incompatible storage contracts require a new shell.
- This lane does not require an Apple Developer ID certificate or notarization;
  macOS first-open approval may still be required. Content signatures remain
  mandatory and are independent of Apple's signing system.
