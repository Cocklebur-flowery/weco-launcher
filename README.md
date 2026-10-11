# Town Launcher — P0/P1/P2

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
No Microsoft application ID, cloud credential, player token or account is bundled.
Development accounts are explicitly offline accounts; this does not change server authentication.

See [contracts](doc/contracts.md) and [validation](doc/validation.md).
The [DEV release producer](doc/publishing.md) generates and signs real-file release
plans without cloud publication or changing existing clients/servers.
Runtime evidence is intentionally ignored.
