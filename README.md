# tokspot-app

## Production readiness

This is an OPD queue prototype and is not approved for real patient data. See [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md) for the audit, priority fixes, secure Firebase architecture, migration plan, and clinic rollout roadmap.

Doctor PIN sign-in is intentionally disabled. Do not re-enable it or use real patient records until Firebase Auth doctor provisioning, Firestore Security Rules, trusted queue APIs, audit logging, and retention controls are deployed and tested.

## Focused checks

Run the domain checks with Node.js:

```powershell
node --test tests\queue-domain.test.cjs
```

Run every check (rules suite skips itself unless the emulator is running):

```powershell
node --test tests\queue-domain.test.cjs tests\firestore-rules.test.cjs
```

## Migration switch (prototype → trusted backend)

All write paths on `book.html`, `frontdesk.html` and `doctor.html` now go
through `js/api.js` (`window.TokSpotAPI`). It has one runtime switch:

- **default = `prototype`** — identical behaviour to the old inline
  Firestore transactions (counter inside a transaction, unguessable
  `crypto.randomUUID()` token ids, lock-enforced transitions via
  `js/queue-domain.js`). The demo keeps working unchanged.
- **`window.TOKSPOT_API_MODE = 'functions'`** — every write path instantly
  switches to the trusted callables (`issueToken`, `transitionToken`,
  `cancelToken`). The read paths (`track.html`, `token.html`,
  `display.html`) intentionally stay on Firestore snapshots in prototype
  mode; in functions mode switch them to `getTokenStatus` / `getDoctorQueue`
  / `getTvFeed` (the adapter fails loudly until you do).

Domain integrity is guarded by `tests/domain-sync.test.cjs`: the client
matrix (`js/queue-domain.js`) must match the server matrix
(`functions/queue-domain.js`) or the suite fails.

## Secure backend (reference, not yet wired to the static pages)

- `firestore.rules` — default-deny, tenant-isolated ruleset (the target). Do
  NOT deploy it on top of the un-migrated static site; migrate the pages to
  the Functions callables first (`issueToken`, `transitionToken`,
  `getTokenStatus`, `getDoctorQueue`, `getTvFeed`, `cancelToken`,
  `provisionDoctor`, `revokeDoctor`, `registerPushToken`).
- `functions/` — Firebase Functions reference API (`firebase deploy --only functions`).
- `firebase.json` + root `package.json` — emulator config and tooling
  (`npm install && npm run emulators`).
- `scripts/migrate-legacy-data.js` — Admin-SDK cleanup of legacy
  pin/recovery/notes fields and `serving` status (dry-run by default).

Run the security-rules suite against the emulator:

```powershell
npm install
npm run emulators            # terminal 1 (set JAVA_HOME to the bundled JBR if Java is not installed)
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node --test tests\firestore-rules.test.cjs   # terminal 2
```

Or run rules tests in one shot (no manual terminals). If Java is not on your
system PATH, use the JDK bundled with Android Studio:

```powershell
$env:Path = "C:\Program Files\Android\Android Studio\jbr\bin;" + $env:Path
npx firebase emulators:exec --project tokspot-rules-test --only firestore "set FIRESTORE_EMULATOR_HOST=127.0.0.1:8080&& node --test tests\firestore-rules.test.cjs"
```

Full suite (rules tests run against the emulator when one is up; otherwise they
skip cleanly):

```powershell
node --test tests\queue-domain.test.cjs tests\domain-sync.test.cjs tests\api-adapter.test.cjs tests\firestore-rules.test.cjs
```

Emulator-backed full run (everything green, last verified 2026-09-29: 24/24):

```powershell
$env:Path = "C:\Program Files\Android\Android Studio\jbr\bin;" + $env:Path
npx firebase emulators:exec --project tokspot-rules-test --only firestore (
  "set FIRESTORE_EMULATOR_HOST=127.0.0.1:8080&& node --test tests/queue-domain.test.cjs tests/domain-sync.test.cjs tests/api-adapter.test.cjs tests/firestore-rules.test.cjs"
)
```