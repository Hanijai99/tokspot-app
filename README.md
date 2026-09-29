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

All write paths on `book.html`, `frontdesk.html` and `doctor.html` go
through `js/api.js` (`window.TokSpotAPI`). Reading the queue is migrated
too — `track.html`, `token.html` and `display.html` poll the sanitized
callables (`getTokenStatus`, `getTvFeed`) in functions mode, fall back to
snapshots in prototype mode. It has one runtime switch:

- **default = `prototype`** — identical behaviour to the old inline
  Firestore transactions (counter inside a transaction, unguessable
  `crypto.randomUUID()` token ids, lock-enforced transitions via
  `js/queue-domain.js`). The demo keeps working unchanged. Browser-originated
  `sms_queue` writes are still enqueued in this mode (legacy behaviour).
- **`window.TOKSPOT_API_MODE = 'functions'`** — every write path switches to
  the trusted callables (`issueToken` with idempotency keys + SMS outbox
  enqueue, `transitionToken` with rate limits, `cancelToken`), and the read
  paths switch to sanitized polling. Number-only lookups now require a
  hospital code (server-scoped `getTokenByNumber`); the TV launch and doctor
  login resolve codes via `resolveHospitalByCode`. In this mode `sms_queue`
  rows are created only by the server — the browser never enqueues SMS.

Domain integrity is guarded by `tests/domain-sync.test.cjs`: the client
matrix (`js/queue-domain.js`) must match the server matrix
(`functions/queue-domain.js`) or the suite fails.

## Secure backend (reference, not yet wired to the static pages)

- `firestore.rules` — default-deny, tenant-isolated ruleset (the target). Do
  NOT deploy it on top of the un-migrated static site; migrate the pages to
  the Functions callables first.
- `functions/` — Firebase Functions reference API. Includes rate limiting on
  every callable, idempotent `issueToken`, timezone-safe "today"
  (`hospitals/{slug}.timezone`, default `Asia/Kolkata`), server-side SMS
  outbox enqueue + `flushSmsOutbox` admin drain, `listAuditEvents`
  (admin-only), `getMyDoctorProfile` (self-service), `resolveHospitalByCode`,
  `getTokenByNumber` (code-scoped), and a daily `retentionRunner` scheduled
  job (tokens 90 days / audit 365 / sms 30).
- `firestore.indexes.json` — composite indexes required by the app queries
  (deployed with `firebase deploy --only firestore`).
- `firebase.json` + root `package.json` — emulator config and tooling
  (`npm install && npm run emulators`).
- `scripts/migrate-legacy-data.js` — Admin-SDK cleanup of legacy
  pin/recovery/notes fields and `serving` status (dry-run by default).
- `scripts/seed-demo.js` — emulator demo hospital (`HOSP-DEMO`, 3 doctors,
  day queue + locks + audit trail). Dry-run by default; pass `--commit`.
- `.github/workflows/ci.yml` — CI runs the unit suites + emulator rules
  suite on every push/PR.

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

Emulator-backed full run (everything green, last verified 2026-09-29:
18 unit + 11 rules = 29 tests, plus seed-demo — see below):

```powershell
$env:Path = "C:\Program Files\Android\Android Studio\jbr\bin;" + $env:Path
npx firebase emulators:exec --project tokspot-rules-test --only firestore (
  "set FIRESTORE_EMULATOR_HOST=127.0.0.1:8080&& node --test tests/queue-domain.test.cjs tests/domain-sync.test.cjs tests/api-adapter.test.cjs tests/firestore-rules.test.cjs && node scripts/seed-demo.js --commit"
)
```