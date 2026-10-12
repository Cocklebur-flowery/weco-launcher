# Launcher accounts and Stable updates

The launcher is a thin client of the independently maintained Rust weco-auth
service. PostgreSQL and verified official responses own identity decisions;
renderer input cannot assert that an account is premium or already activated.
The integrated source is on Mac mini under `Dev/ModDev/town-launcher`.

## Player flow

Players prefer Microsoft Java login: request a device code, open the validated
official Microsoft page, authorize and wait for the bounded polling result. The
service verifies Xbox, Java entitlement and official profile before provisioning
an account. No separate registration or QQ quota is required.

Service-account users register a 3–16-character name and a 12–128-byte password,
send their short-lived challenge to the official Bot in the designated MC group,
and enter the code from the Bot's reply to their own request. Pending accounts
cannot start. A QQ identity can activate only one service account. Candidate codes
are not exposed/auto-confirmed by the UI. Regeneration replaces old proof.

Passwords are not saved. Session/refresh credentials stay in the main process and
an OS-encrypted vault, never settings JSON or renderer snapshots. Linux needs a
supported keyring; `basic_text`/unknown backends are refused. Native vault behavior
and code-signing prompts still need verification on each deployment platform.
Logout clears local credentials and requests server session revocation. Existing
HMCL accounts are neither imported nor modified.

## Public distribution configuration

Before packaging, fill `resources/launcher-profile.json` with the HTTPS auth URL,
HTTPS signed Stable manifest URL, Minecraft address/port and Ed25519 public release
keys. The package includes this file. It is public, not a place for Bot/database/COS
secrets or the release signing private key. Existing installed private preferences
are not overwritten by updated defaults.

An empty public-key list or placeholder URL is not a working production release.
Generate a private Ed25519 publisher key outside Git, protect it, and put only its
public PEM in the distribution profile. It is unrelated to the Authlib RSA metadata
key. The separate backend deployment guide covers QQ/Microsoft/TLS configuration.

## Update and launch behavior

Stable start always checks its signed remote manifest and refuses unavailable,
invalid, preview or wrong-channel releases. Missing official Java/MC/NeoForge
dependencies are installed into a fresh owned workspace before Mod activation.
Only missing or changed release bytes are downloaded; unchanged files and cached
downloads are reused after validation. Player settings, worlds and caches are not
release-managed. Pre-download without runtime installation does not activate Mods.

No file activation while a game process holds the workspace lease. Installation
uses persistent rollback; a failed update preserves the prior files but does not
silently launch an old Stable release. A signed higher sequence is mandatory for
new content, including an intentional content rollback. Use a separate workspace
for DEV rather than converting Stable in place.

After update, the launcher refreshes authoritative login and prepares verified
game parameters. Premium uses native `msa`/Mojang without a client agent; service
accounts use their verified profile/token and the pinned original authlib-injector
1.2.8 artifact. The game server must remain online-mode and verify through the
approved server-side endpoint. The launcher does not toggle server authentication.

## Validation and deployment boundary

41 focused tests, type checking, production build and a native ARM64 package pass.
The package archive includes the public profile. Mock Rust integration covers both
account types, Bot reply/confirmation, QQ quota, renewal and encrypted restart.
Actual Authlib verification is exercised separately against the Rust fixture.
These checks do not run a Minecraft world or send real QQ messages.

Real Microsoft/QQ credentials, production TLS/database roles, COS/official download
acceptance, in-game secure-profile/chat and non-ARM64-macOS runtime checks remain
external acceptance. The current package is unsigned with placeholder distribution
configuration. No deployment, cloud publication or player-data migration occurred.
