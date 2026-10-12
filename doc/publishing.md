# Launcher release producer

Current source supports DEV and reviewed Stable publication. The dated P3.1
acceptance below is a historical snapshot; authentication and remote Stable
consumption now have their own source/tests and `accounts-and-updates.md` guide.
The launcher is an independent Git repository; no remote/push is configured.

Stable plans add `channel: "stable"`, a positive `sequence`, and
`stableBaseline: {serverRoot, serverOnly, clientOnly}`. `serverRoot` is an explicitly
selected read-only server directory. Shared client Mod bytes must match installed
server hashes; server/client-only entries are exact reviewed paths. Old plans with
no channel continue to produce DEV. No unfinished DEV build is implicitly promoted.

Upload only owned immutable artifacts, verify the signed release/download hashes,
then publish the copied signed `manifest.json` as the HTTPS Stable channel object.
Keep the private signing key and input operator paths out of COS/player packages.
The producer does not upload or mutate cloud state. See `doc/accounts-and-updates.md`
and the backend's `doc/deployment.md` before an approved cutover.

## Historical P3.1 baseline

The producer runs on Mac mini in `Dev/ModDev/town-launcher`. It does not configure
COS, publish a channel pointer, modify a game server, or upgrade installed Mods.
The consumer release schema remains v1. Producer plans are private operator inputs.
No new package dependencies are introduced.

Source changes are limited to eight files: `src/catalog.ts`, `src/publisher.ts`,
`scripts/publish.mjs`, `scripts/release-smoke.mjs`, `test/publisher.test.ts`,
`doc/publishing.md`, `package.json` and `README.md`. Existing runtime/UI code,
release-consumer schemas, dependency versions and the lockfile are unchanged.
The launcher directory has not been initialized as a Git repository or committed.

## File boundaries

`scan` hashes candidate files under `mods/`, `resourcepacks/`, `config/` and
`defaultconfigs/`. It never traverses accounts, worlds, assets/libraries or caches.
Private-name/state files (including local storage, databases, credentials and backups)
are excluded. Every configuration/resource-pack candidate needs explicit review.
Exclusion heuristics are not a substitute for reviewing configuration contents.
Unsupported paths and symlinked Mods block a complete release.

Project provenance requires an exact-byte match to an explicitly selected artifact.
Names like `townui.jar` do not prove ownership. Modrinth lookup uses SHA-512 and
verifies file size, official CDN URL and exact project/version identifiers.
Metadata not declaring the current loader/game version requires explicit compatibility
review; this accommodates intentional Connector compatibility without silently approving it.
CurseForge resolution is not implemented without approved API credentials.
Reviewed manual official-page/URL bindings are supported; unknown sources block build.
No third-party JAR is copied into publication output or uploaded to a cloud service.

## Commands

Use Node 24 and the existing project environment. Paths below are operator-selected.
Outputs must be new paths outside the source client; existing outputs are never overwritten.

```sh
npm run publish -- scan CLIENT_ROOT NEW_INVENTORY.json
npm run publish -- resolve CLIENT_ROOT NEW_CATALOG.json PROJECT_PROOFS.json
npm run publish -- build CLIENT_ROOT PLAN.json PRIVATE_KEY.pem NEW_RELEASE_DIRECTORY
npm run publish -- compare RELEASE_A/manifest.json RELEASE_B/manifest.json PUBLIC_KEY.pem
npm run publish -- verify RELEASE/manifest.json NEW_DOWNLOAD_CACHE PUBLIC_KEY.pem
```

The optional project proof input is an array:

```json
[{ "project": "TownUI", "artifact": "/absolute/path/to/reviewed/build/libs/townui.jar" }]
```

A reviewed publish plan selects files, pins their scan-time SHA-256 and defines policy.
All Mod JARs in the source inventory must be included; the tool cannot silently drop
unresolved Mods to make a release appear complete. Unselected configuration files remain
outside the release. Configuration defaults should normally use `default`; use `managed`
only for deliberately release-controlled configuration.

```json
{
  "schemaVersion": 1,
  "releaseId": "rct-dev-001",
  "platforms": ["darwin-arm64"],
  "files": [{
    "path": "mods/example.jar",
    "sha256": "SCAN_SHA256",
    "policy": "managed",
    "source": {
      "kind": "modrinth",
      "projectId": "EXACT_PROJECT_ID",
      "versionId": "EXACT_VERSION_ID",
      "pageUrl": "https://modrinth.com/mod/EXACT_PROJECT_ID/version/EXACT_VERSION_ID",
      "urls": ["EXACT_OFFICIAL_URL"],
      "gameVersions": ["1.21.1"],
      "loaders": ["neoforge"]
    }
  }]
}
```

At the P3.1 baseline the generated release was DEV-only. Modrinth bindings are rechecked against live metadata
at build time; local files and project artifact proofs are hashed again. The signer accepts
only Ed25519 keys. CLI key files must be regular files, at most 16 KiB, and private (0600)
on POSIX systems; Windows ACL protection must be configured separately.

Publication output contains `manifest.json`, `provenance.json`, `public-key.pem` and
`COMPLETE.json`. The private key and operator artifact paths are not written there.
`COMPLETE.json` is written last and records the envelope hash. Incomplete output must not
be distributed. The signed manifest, not the completion/provenance metadata, is the trust
boundary. Private signing keys must stay outside Git and distribution packages.

`verify` checks the signature, downloads the complete selected release into a new cache,
and verifies every size/SHA-256; it does not activate files. `compare` reports file-content
and policy differences. Download URL changes alone do not mean changed file bytes.
Platform inclusion is operator approval, not evidence of an in-game test on that OS.

## Local real-file acceptance

```sh
npm run test:release -- CLIENT_ROOT NEW_EVIDENCE_DIRECTORY
```

This narrow smoke test uses actual client JARs, a selected TownRoad resource pack and
two reviewed configurations. It serves only an exact-file map on loopback, generates an
ephemeral signing key in memory, and installs into a disposable owned workspace.
It never launches Minecraft or changes the original client. Only the copied
`hideHighSpecNotice` property changes between A and B.

Local-test sources require `--local-test`, loopback HTTP and a `local-` release ID.
Do not upload these test manifests or trust the fixture key for real distribution.
Temporary workspaces and the HTTP listener are removed/stopped in `finally`.

## Acceptance — 2026-10-11

- PASS: Mini type checking, 30 focused tests (8 new), production compilation.
- PASS: actual 31-Mod / 34-file A-to-B update through the existing consumer.
  Cold installation fetched 398,437,806 bytes in 34 requests; B fetched only the
  changed 1,001-byte configuration in one request. Repeating B fetched zero files.
- PASS: managed-file hashes, user/default configuration preservation, player-file
  preservation, injected failure rollback, and original source hashes unchanged.
- PASS: exact Modrinth metadata matched 23 installed Mod JARs. This is provenance
  metadata verification, not a claim that all official URLs were downloaded in this check.
- PASS: current TownUI build matches its installed bytes; other selected current
  TownVehicle/TownMCP/TownRoad build bytes differ from this older local DEV baseline.
- BLOCKED: a complete public release needs the remaining source/version bindings
  and selected configuration/resource-pack review. No automatic replacement with newer
  builds and no unofficial fallback download were performed.
- NOT RUN: COS distribution, remote channel discovery, CurseForge API, game login,
  clean runtime bootstrap, native Windows/Linux/Intel-Mac game acceptance and public signing.

Detailed runtime evidence lives under ignored `evidence/p31/`; temporary client input
was an isolated copy, not a server/client deployment. Loopback traffic figures are
application file bytes, not measured Internet bandwidth or gameplay performance.

The seven unresolved installed Mod binaries are ApricityUI, TownVehicle/MachineMax,
SparkCore, Rinku, the old SeamlessChunks build, TownMCP and TownRoad. These are not
all unknown owners: several are known project forks whose currently selected build
proofs do not match the older installed bytes. Axiom has an exact source match but its
metadata declares Fabric; the intentional Connector arrangement still requires explicit
publish-plan compatibility approval. No automatic approval was recorded.

No signing/identity infrastructure is provisioned by this stage. Test manifests use a
temporary public key and a stopped loopback endpoint; they are not live release packages.
Internet download acceptance for the complete release, existing packaging-tool audit
findings and clean bootstrap remain separate outstanding checks.

## Authentication boundary

The requested future policy is premium-first: verified Java identities automatically
obtain a server profile; custom accounts are supplemental. Server entry still verifies
the session without asking the player to enter credentials again. Official UUIDs and
custom identities must remain separate; a same-name premium account does not silently
inherit another account's assets. Authentication, namespace/UUID migration and PostgreSQL
changes require a separate approved implementation plan. None is implemented by P3.1.
