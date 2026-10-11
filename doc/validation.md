# P0 / P1 / P2 validation — 2026-10-11

This is a development milestone, not a public launcher release.
Canonical source and compilation: `/Volumes/T7/MC_lifeserver/Dev/ModDev/town-launcher` on Mac mini.
Local test artifacts: `/Users/aoihana/Downloads/town-launcher-test-20261011` on MBP.
No Stable deployment, COS configuration, server restart, or server configuration change occurred.

## Implementation

- P0: inspected separate DEV/Stable client inventories; pinned MC 1.21.1,
  NeoForge 21.1.250 and Java 21; defined signed release schema v1 and file ownership.
- P1: Electron/Vue launcher using XMCL core 2.15.1 and installer 6.1.2; independent
  workspace, read-only client import, Java detection/managed-runtime installation,
  official clean bootstrap, development identity and game process lease.
- P2: explicit trusted Ed25519 keys, SHA-256/size verification, multiple URL fallback,
  range resume, download cache reuse, preparation without activation, guarded
  ownership, rollback journal, interrupted-process recovery and player-file preservation.

The initial target matrix is Windows x64, Linux x64 and macOS arm64/x64.
This does not assert that all targets have been built or run.
Microsoft login, external authentication, launcher self-update, automatic channel
discovery, cloud publication and background preparation during gameplay are not implemented.
Only explicit offline development identity is available; server authentication is unchanged.

## Checks

| Check | Result | Evidence / limits |
| --- | --- | --- |
| TypeScript check | PASS | `npm run typecheck` on Mini; not a full Vue SFC type check |
| Focused tests | PASS | `npm test`: 22 passed, 0 failed |
| Production compilation | PASS | `npm run build`: Vite + runtime TypeScript compilation |
| macOS arm64 app packaging | PASS | `npm run pack -- --mac --arm64`; unsigned development app |
| Package transfer integrity | PASS | Mini and MBP archive SHA-256 match |
| Source diff review | PASS | New source reviewed for scope, secrets and whitespace; parent migration changes left intact |
| Runtime dependency audit | PASS | `npm audit --omit=dev`: 0 known vulnerabilities at check time |
| Full dependency audit | FAIL | 8 moderate findings in the electron-builder development dependency chain; no high/critical findings |
| Existing client import | PASS | 31 Mods copied into a new 2.2 GB workspace; accounts, worlds, MCP grants and chunk caches not copied |
| Actual macOS Minecraft process | PASS | Java 21/NeoForge launch; game log reached title screen; user exited normally and log contains `Stopping!` |
| Current packaged settings UI | PASS | Reproduced reactive-proxy IPC cloning failure, fixed plain-data submission; settings now persist |
| Current packaged P2 UI | PASS | Trusted key import, A preparation, A installation, A-to-B update; UI and disk hashes agree |
| UI cache reuse | PASS | Fixture request log contains one `/a` and one `/b`; A activation reused its prepared bytes |
| DEV login / gameplay | NOT RUN | Native UI inventory does not expose the Java game window; copied client has no MCP grants |
| Game-exit state display / app-quit-while-playing | NOT RUN | User exited the game before final launcher observation; no runtime assertion made from source alone |
| Clean official bootstrap | BLOCKED | Official asset downloads repeatedly timed out or failed hash validation; integrity was not bypassed |
| Managed Java installation | NOT RUN | Existing Java 21 used for the macOS game launch |
| Windows/Linux/macOS Intel runtime | NOT RUN | No corresponding native environment used |
| CI platform matrix | NOT RUN | Workflow source exists but has not been pushed or executed |
| OS signing/notarization/installers | NOT RUN | Native unpacked development app only; default Electron icon retained |
| Public cloud update / real Mod-release update | NOT RUN | P2 UI uses a harmless text-file fixture in a separate empty workspace |

The tests exercise malformed contracts, path traversal/aliases, signatures, ownership,
corruption, partial transfers, cancellation, truncation, disk shortage, symlinks,
preview activation refusal, real child-process leases and interrupted-process recovery.
Process recovery is tested; sudden power-loss durability is not promised without fsync.

## Artifact

Archive: `final/town-launcher-macos-arm64-p0-p2.zip`.
SHA-256: `02e50248b3d72e462463f6f86f7c4fad4be0358121275963674d084663c88480`.
The current packaged UI was retested after the settings fix.
The Minecraft launch observation used the earlier development package; current core
source passed tests/build, but a second full in-game acceptance on this exact archive
has not been performed.

Local game copy: `profile/workspaces/dev/game`.
Local disposable update workspace: `gui-update-profile/workspaces/dev/game`.
Fixture data and request evidence: `fixtures/`.
The fixture private signing key lived only in its process and was never saved or bundled.
The loopback HTTP fixture service was stopped after validation.
No SSH port forward was created. Mini DEV remains loopback-only on port 25566.

To reopen the same isolated game-test profile on MBP:

```sh
TOWN_LAUNCHER_TEST_DATA=/Users/aoihana/Downloads/town-launcher-test-20261011/profile \
  '/Users/aoihana/Downloads/town-launcher-test-20261011/final/Town Launcher.app/Contents/MacOS/Town Launcher'
```

Opening the app without this environment variable uses its own default application
profile, not the above test profile. It never adopts the original HMCL client in place.

## Preserved state and follow-up

The original HMCL clients, player settings, account files, worlds, server Mods,
permissions, PostgreSQL and public ingress were left unchanged. Mod-owned shared
OS directories may still be used by Mods themselves (for example Rinku's existing
user-level browser cache); this is not full OS-level sandboxing of Minecraft.
The existing parent Git migration changes were not staged or edited.
The new launcher directory has not been initialized as a Git repository or committed.

Before player distribution: finish clean-install network acceptance, choose the
authorized account system, perform native platform checks, resolve packaging audit
findings, and decide signing/notarization and the COS/release publishing workflow.
Do not enable Stable updates using the local fixture key.
