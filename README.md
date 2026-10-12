# Town Launcher

Independent RCT launcher. Canonical development and compilation run on Mac mini.
Existing HMCL clients and all servers remain untouched.

## Commands

Use the existing Node 24 installation. Run `npm ci`, `npm run typecheck`,
`npm test`, `npm run build`, `npm run prepare:electron`, then `npm run start`.
Electron's runtime download must complete its checksum verification before launch.
`npm run pack` reuses that runtime and is native-architecture only.
Packaging targets: `dist:mac`, `dist:win`, `dist:linux`.
Unsigned packages are development artifacts, not public releases.

## Ownership

XMCL is consumed as pinned MIT-licensed dependencies, not copied application code.
Dependency licenses remain in their packages. Project licensing is undecided.
No cloud credential, player token or account is bundled. The owned Microsoft
application ID is configured by weco-auth, not borrowed from another launcher.
Unverified offline profiles are restricted to explicit loopback DEV fixtures;
Stable requires an authoritative activated service or verified premium account.

See [contracts](doc/contracts.md) and [validation](doc/validation.md).
The [release producer](doc/publishing.md) generates and signs real-file release
plans without cloud publication or changing existing clients/servers.
Runtime evidence is intentionally ignored.

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
