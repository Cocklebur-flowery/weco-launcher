# P0 baseline and update contracts

Status: approved P0/P1/P2 implementation; no COS or Stable deployment.
Canonical source: Mac mini Dev/ModDev/town-launcher.
Minecraft 1.21.1; NeoForge 21.1.250; Java major version 21.
The inspected local rctdev instance has 31 Mods, the local Stable instance 30.
XMCL unzip 2.2.0 publishes an unresolved workspace dependency and references
an absent index.ts. Core 2.15.1 / installer 6.1.2 are selected as the previous
coherent independently published pair. No third-party source or binary is edited.
Undici is pinned to 7.29.1 through npm overrides after the initial audit identified
vulnerabilities in the SDK's old exact pin. Re-run compatibility tests and audit.
Those are separate inventories, not an assertion that they are interchangeable.
DEV currently uses online-mode=false, port 25566. Its settings are not modified.
HMCL accounts.json contains no accounts. No existing authentication token is imported.

## Platform scope

Required OS families: Windows, Linux, macOS.
Initial targets: Windows x64, Linux x64, macOS arm64/x64.
ARM Windows/Linux and Linux distribution compatibility require additional runtime validation.
Building a package is not successful in-game validation.

## Release schema v1

A release has schemaVersion=1, releaseId, channel=dev|stable, activation=preview|active,
minecraft, neoforge, platforms, and files.
Each file has path, size, sha256, policy=managed|default, urls.
URLs use HTTPS; HTTP is allowed only for explicit loopback test fixtures.
Source hashes validate bytes; an Ed25519 signed envelope authenticates an immutable release.
Trust keys are local configuration, never accepted from the envelope itself.
Remote manifests contain data, not commands, account tokens or cloud keys.
Platform/loader requirements must match before installation.

Only mods/, resourcepacks/, defaultconfigs/ and reviewed config/ paths may be managed.
No options.txt, worlds, screenshots, launcher accounts, MCP grants, DH/Seamless caches or logs.
Path traversal, Windows-reserved names, case aliases, duplicates and symlinks are rejected.
Default files are installed once and thereafter user-owned.
Previously unowned differing files and user-modified managed files block activation.
Deletion is limited to unchanged files recorded as owned in the previous successful release.

## Installation lifecycle

A workspace is explicitly initialized with an ownership marker.
It must not be an existing HMCL game root; imports copy into a new managed workspace.
A cross-process exclusive lock serializes update and game execution.
Downloads enter content-addressed staging, support range resume, and verify exact size/hash.
No activation while a game process is alive.
Installation uses a persistent undo journal; startup recovery restores the prior whole release.
This covers process interruption, not a promise of power-loss durability without filesystem fsync.
Disk-space checks and fault-injection tests precede use with real client files.
Preview can be prepared but not activated. Stable changes require a later P5 decision.

## Exclusions and acceptance

No cloud setup, server modification, launcher self-update, forced game exit, or token migration.
P1 validates XMCL startup against an isolated copy; clean bootstrap installs trusted official game dependencies.
P2 tests changed-file reuse, managed/default ownership, corruption, cancellation, truncation,
resume, concurrent lock, crash recovery, path attacks, protected paths, symlinks and disk shortage.
Microsoft/external authentication requires its own approved identity configuration, not borrowed keys.
Windows/Linux in-game checks remain NOT RUN until performed on those systems.
Pack is native-architecture only and reuses a checksum-verified unpacked Electron runtime.
Cross-architecture distribution commands fetch their own runtime; they are not yet validated.
