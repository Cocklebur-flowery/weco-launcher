# Weco Launcher

An independent, unofficial Minecraft: Java Edition launcher and modpack updater
developed for the Weco community, licensed under GNU GPL v3.0 only.
It targets Windows, Linux, and macOS and is under active development.

The launcher uses pinned XMCL core and installer libraries, an Electron desktop
runtime, and a Vue interface. It supports isolated game workspaces, signed Stable
updates, Microsoft-account authentication, and a separate community authentication
provider. It is not affiliated with Mojang or Microsoft.

This repository publishes launcher source, tests, and documentation, not a ready
production client or Minecraft distribution. It contains no game files, server
worlds, authentication backend, cloud credentials, or account vault.
Existing HMCL clients and servers are not changed by this source publication.

## Commands

Use the existing Node 24 installation. Run `npm ci`, `npm run typecheck`,
`npm test`, `npm run build`, `npm run prepare:electron`, then `npm run start`.
Electron's runtime download must complete its checksum verification before launch.
`npm run pack` reuses that runtime and is native-architecture only.
Packaging targets: `dist:mac`, `dist:win`, `dist:linux`.
Unsigned packages are development artifacts, not public releases.
Windows/Linux and Intel-Mac in-game acceptance remain outstanding; target support
and packaging configuration do not imply completed native runtime validation.
Internal package and application identifiers retain the existing Town names for
compatibility.

## Ownership

XMCL is consumed as pinned MIT-licensed dependencies, not copied application code.
Dependency licenses remain in their packages and are not replaced by this
project's GPL license. See [third-party notices](resources/THIRD_PARTY_NOTICES.txt).
No cloud credential, player token or account is bundled. The owned Microsoft
application ID is configured by weco-auth, not borrowed from another launcher.
Unverified offline profiles are restricted to explicit loopback DEV fixtures;
Stable requires an authoritative activated service or verified premium account.

See [contracts](doc/contracts.md) and [validation](doc/validation.md).
The [release producer](doc/publishing.md) generates and signs real-file release
plans without cloud publication or changing existing clients/servers.
Runtime evidence is intentionally ignored.
Milestone documents include dated development snapshots; publishing this source
does not activate a game release or deploy its external services.

## Verified accounts and Stable updates

The main process consumes the Rust weco-auth service. Service accounts require
official QQ group activation; Microsoft Java accounts use the configured owned
application and do not consume a QQ quota. Passwords are never saved. The desktop
vault uses OS safeStorage and refuses Linux plaintext fallback. Renderer state
does not contain account/game bearers or Microsoft refresh credentials.

Fill `resources/launcher-profile.json` with public HTTPS authentication and Stable
manifest addresses, game entry and Ed25519 verification keys before packaging.
It must never contain Bot Secret, COS secret keys or signing private keys. New
players receive these public defaults; existing private preferences remain intact.
See [account and release setup](doc/accounts-and-updates.md).

Starting Stable checks its current signed release before launching, validates
hashes and monotonic sequence, and installs only while the game is stopped.
Official sessions launch without a client agent; activated service accounts use
the pinned unmodified adapter. Existing clients, caches and servers are not
replaced in place. Real QQ/Microsoft/COS/game acceptance remains external setup.

## License

Copyright (C) 2026 Cocklebur-flowery and contributors.

Project-owned source in this repository is licensed under the GNU General Public
License, version 3 only (SPDX: `GPL-3.0-only`). You may redistribute and modify it
under those terms. It is provided without any warranty, including implied
warranties of merchantability or fitness for a particular purpose.
See [LICENSE](LICENSE) for the full terms.

Third-party dependencies and the separately downloaded, unmodified
authlib-injector adapter retain their own licenses, copyrights, and notices.
This license does not grant rights to Minecraft game files, unrelated Weco
repositories, or third-party trademarks.
