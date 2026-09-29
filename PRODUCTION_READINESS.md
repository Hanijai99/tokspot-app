# TokSpot OPD Queue: Production Readiness Audit

Audit date: 2026-09-26
Scope: Static frontend backed by Firebase Authentication and Firestore. This review inspected the checked-out project files; no Firestore rules, Firebase Functions, Firebase CLI config, or deployed-project access are present in the repository/environment.

## 1. Executive Summary

### Round 2 verification (2026-09-26) — code state re-checked, fixes applied in place

A second pass verified the claims below against the actual files instead of trusting the document. Result: the hardening claims largely hold (P0 code-level items implemented), with three new gaps closed and the server-side target added as reference code:

- **Fixed (in this round):** token live-pass document IDs were guessable (`<date>-<doctor>-<counter>`), letting anyone enumerate a whole day of patients' tracking pages and see their names. `book.html` and `frontdesk.html` now issue `crypto.randomUUID()` doc IDs (the visible counter number is unchanged).
- **Fixed (in this round):** legacy `status: 'serving'` rows are not recognized by the queue state machine and could get stuck or bypass the active-token lock. `js/queue-domain.js` now normalizes `serving → called` in validation, lock checks, and analytics.
- **Fixed (in this round):** no HTTP security headers were set. `vercel.json` now sends `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, and a gstatic-aware CSP.
- **Added (reference, not yet wired):** `firestore.rules` (default-deny, tenant-isolated target), `firebase.json` + root `package.json` (emulator tooling), `functions/` trusted API (issueToken, transitionToken, getTokenStatus, getDoctorQueue, getTvFeed, cancelToken, provisionDoctor, revokeDoctor, registerPushToken, FCM notify), `scripts/migrate-legacy-data.js`, and `tests/firestore-rules.test.cjs`.
- **Round 3 (2026-09-29):** introduced `js/api.js`, the single runtime switch between prototype mode (exact current behaviour) and the trusted Functions backend. All write paths on book/frontdesk/doctor pages now go through it; flip `window.TOKSPOT_API_MODE='functions'` at pilot time to move every write to the server API at once. Extracted `functions/queue-domain.js` as the server-side twin of `js/queue-domain.js`, and `tests/domain-sync.test.cjs` fails on any drift between them. Added `tests/api-adapter.test.cjs` and **verified `firestore.rules` against the real Firestore emulator** (bundled Android Studio JBR as Java): 24/24 tests pass — 12 domain, 4 adapter, 4 client↔server drift, 6 rules-enforcement (anonymous token read/write denied, cross-tenant doctor denied, admin own-hospital reads allowed, assigned-doctor profile allowed, client audit-log writes denied). One rules hardening landed from the emulator run: `callerEmail()` guards the missing-`email` claim case that previously threw an evaluation error instead of a clean deny.
- **Round 4 (2026-09-29, code complete):** closed the remaining P0–P2 code gaps.
  - **Read-path migration:** `track.html`, `token.html` and `display.html` poll the sanitized callables in functions mode (`getTokenStatus`, `getTvFeed`, `getTokenByNumber`, `resolveHospitalByCode`); snapshot fallback preserved for prototype mode.
  - **Server API upgrades** (`functions/index.js`): rate limits on every callable; idempotent `issueToken` (retry-safe, no duplicate tokens); timezone-safe "today" via `hospitals/{slug}.timezone` (default `Asia/Kolkata`); server-side SMS outbox enqueue on issue/call + admin `flushSmsOutbox` drain (provider adapter stub); `listAuditEvents` (admin-only); `getMyDoctorProfile` (self-service); `getTokenByNumber` (code-scoped — kills the old cross-tenant number scan); daily `retentionRunner` (tokens 90 d / audit 365 d / sms 30 d).
  - **Doctor auth flow:** `doctor-login.html` gains a secure email/password sign-in (functions mode) → server-authoritative `getMyDoctorProfile` session; `admin.html` routes doctor creation through `provisionDoctor` and shows a security audit trail.
  - **Web push:** `js/push.js` + `TOKSPOT_VAPID_KEY` hook register patient devices in functions mode (backend already sends sanitized "Your turn!" via `tokenCalledNotify`).
  - **Enforcement readiness:** `firestore.indexes.json` for the app's composite queries; `scripts/seed-demo.js` (emulator-verified); `.github/workflows/ci.yml` runs all suites on every push.
  - **Test totals:** 18 unit tests pass locally; emulator run passes **11/11 rules tests** (5 new: doctor token-list denied, `sms_queue` write denied, `queueState` write denied, admin day-token list allowed, admin audit read own-tenant only) and the demo seed commits cleanly → **29 green + seed**, emulator-verified 2026-09-29.
- **Verified:** the TV board announces token numbers only, never names; the doctor PIN page and PIN/recovery writes remain disabled; admin and analytics pages are UI-gated by `adminUid`; token doc ids are unguessable.

**Deployment is required to take the trusted backend live.** Everything code-side is in place; until the rules + functions are deployed together on `tokenonspot` (Blaze plan) and the migration flag is flipped, the static site still runs the un-migrated prototype against the old permissive security posture. The next approval gate is:
1. verify + backup Firestore, run `scripts/migrate-legacy-data.js --commit`;
2. deploy `firestore.rules` + `functions` together (never rules alone);
3. flip `window.TOKSPOT_API_MODE='functions'`; enable App Check enforcement + set the FCM VAPID key;
4. run `scripts/seed-demo.js` against the live project and smoke-test booking → desk → call → complete → audit trail.

The conclusion is unchanged: **this build must not be deployed with real patient data until the Functions API + rules are deployed together and the static pages are migrated to them.**

TokSpot has a useful clinic-focused workflow: booking, front desk token issuance, doctor queue, waiting-room display, patient status tracking, and basic daily analytics. It is not safe for real patient information yet. Browser clients authenticate anonymously for public workflows and read/write tenant data directly; there is no checked-in Firestore ruleset or trusted API. A hospital code, hidden page, sessionStorage record, or frontend UID check cannot provide authorization.

Immediate code changes remove patient names from public displays, stop doctor PIN writes and browser PIN verification, require canonical Firebase UID linkage before opening a doctor desk, remove browser recovery-key lookup, prevent admin UI fallback to an unowned hospital, enforce queue transition rules and a per-doctor/day active-token lock for cooperating clients, correct token search routing/ambiguity, remove clinical-note capture, and replace fabricated wait estimates with measured timestamps. These reduce exposure and accidental data corruption but do not replace server-enforced authorization.

**Do not deploy this build with real patient data.** Doctor login is intentionally unavailable until secure account provisioning is implemented. Production launch requires Firebase Security Rules plus trusted Cloud Functions (or an equivalent API), followed by emulator and deployment verification.

## 2. Repo Strengths

- Focused OPD queue UX with distinct booking, front desk, doctor, token-pass, display, admin, and analytics pages.
- Firebase Auth is already used for admin email/password accounts; hospital records include an `adminUid` ownership field.
- Token allocation already uses a Firestore transaction and a hospital/day counter in both booking and desk issuance flows. The new helper validates the counter value.
- Queue records include `createdAt`, `calledAt`, `completedAt`, and date/status fields that can support measured operational analytics.
- Patient-facing pass and TV views are separate from staff workspaces; patient names have now been removed from public views.
- UI output often uses `textContent` or HTML escaping, and station workflows provide live updates through Firestore listeners.
- The product has not expanded into billing, clinical records, or other ERP workflows; that narrow scope should be preserved.

## 3. Critical Issues Found

### P0: Authorization, privacy, and credentials

- **No deployable authorization policy:** there is no `firestore.rules`, `firebase.json`, or `functions/` directory. Client code in `book.html`, `frontdesk.html`, `display.html`, `token.html`, `track.html`, `analytics.html`, and `doctor-login.html` calls Firestore directly. Public workflows call `signInAnonymously`; a hospital code is discoverable and is not an identity or authorization credential.
- **Cross-tenant data can be exposed:** hospital documents, doctor subcollections, and token subcollections contain private fields. Firestore rules cannot redact fields from a document, so public directory/TV/tracking access must use separate sanitized documents or a trusted projection endpoint.
- **Doctor PINs were plaintext and weak hashes:** `admin.html` wrote both `pin` and unsalted SHA-256 `pinHash`; a four-digit PIN has only 10,000 possibilities. `doctor-login.html` read doctor documents and accepted either value, including legacy plaintext. The PIN workflow is now removed/disabled, new PINs are not saved, admin edits delete the legacy fields, and `doctor.html` requires a non-anonymous UID matching `authUid`. Existing Firestore documents still need a controlled migration. No secure doctor provisioning endpoint currently exists, so doctors cannot sign in in this build.
- **Frontend-only admin/doctor checks:** admin UID matching and the doctor canonical-profile check are useful UI gates but remain bypassable unless identical policies are enforced in Firestore Rules/Functions. `sessionStorage` is not proof of identity.
- **Patient data on public routes:** the token pass and tracker subscribe directly to token documents and queue collections; token IDs are generated from date, doctor ID, and a counter and are not a secret. Names were removed from the pass and TV, but direct document/queue reads and phone data are still exposed if deployed rules permit them.
- **Clinical notes stored in queue records:** the doctor page offered prescription/consultation notes and wrote them to `doctorNotes`. This capture/write path is removed; existing fields require a retention/migration decision and must not be presented publicly.
- **Recovery secret in hospital documents:** `recoveryKey` was generated and displayed from the hospital document and queried from the public login page. Browser recovery lookup is disabled, the UI no longer displays/generates keys, and the legacy key is deleted when an admin next resolves their hospital. Existing records for hospitals whose admins have not signed in still need server-side cleanup.
- **Analytics route exposure:** `analytics.html` previously listed every hospital and allowed any visitor to select one. Its UI now requires a signed-in user and filters/checks by `adminUid`, but only Firestore rules can enforce this boundary.

### P1: Queue correctness, reliability, and analytics

- **Invalid and conflicting transitions:** direct `updateDoc` calls allowed completion/skip from waiting and racing clients could call different patients. `js/queue-domain.js` now defines valid transitions, writes event timestamps inside a transaction, and uses a per-hospital/doctor/day active-token lock. The desk/doctor pages use it; the existing counter transaction remains the source of token-number uniqueness. This is cooperative-client protection only until the same rules are implemented server-side. Legacy called tokens without locks require reconciliation before rollout.
- **Token lookup was misrouted and ambiguous:** the landing page sent a token number into hospital booking, and tracker search selected the first hospital match. It now routes to `token.html`; lookup normalizes padded numbers and refuses cross-hospital ambiguity. The current lookup still scans public hospital/token collections and must move behind a scoped endpoint.
- **Analytics fabricated wait:** the old average was derived from `(total / done) * 0.8`; public views also claimed fixed minutes per person. Analytics now averages actual `createdAt`→`calledAt` timestamps and returns no value when measurements are missing; token views make no numerical time promise.
- **Front-desk quota is a client-side count:** the phone limit can race and can be bypassed by the online booking flow. Enforce any limit in the trusted issuance transaction, or remove the product promise.
- **Hospital code/slug creation:** four-digit codes use `Math.random`; slug collisions can overwrite records if rules allow. Generate cryptographically random unique identifiers and create them server-side with collision checks.

### P2: Operational readiness and UX

- `js/push.js` has no VAPID key or token persistence flow. SMS queue writes originate from the browser; no worker/provider integration or delivery receipts are present. SMS and WhatsApp actions currently open local apps/web links rather than guaranteeing delivery.
- No server audit log, retention/deletion job, backup/restore runbook, monitoring/alerting, rate limiting, App Check, or emulator test setup is checked in.
- `vercel.json` only supplies static routes; it does not add security headers or enforce Firebase policies.
- Registration privacy acknowledgment is based on a client-side link-click delay. This is not a legal consent or authorization control. Privacy statements were corrected to disclose current limits; have counsel review them before launch.

## 4. Priority Fix List (P0/P1/P2)

### P0 — before any real patient data

1. Implement and deploy tenant-aware Firestore Rules with default deny. Separate public directory/queue projections from private hospital, doctor, and token records.
2. Add trusted Functions/API endpoints for hospital registration, doctor provisioning/revocation, token issuance, transitions, public token status, TV projections, and audit events. Do not authorize from hospital codes or anonymous UIDs.
3. Provision doctors as Firebase Auth users; bind canonical doctor records to immutable `authUid` and hospital ID. Remove PIN-based login permanently; revoke existing PINs and delete `pin`, `pinHash`, root `/doctors` mirrors, and old recovery secrets using Admin SDK migration tooling.
4. Keep patient name/phone and any legacy `doctorNotes` server-side and out of public projections. Use cryptographically random tracking capabilities and only return token number/status/counter/queue position.
5. Create append-only server audit events for issue/call/skip/requeue/complete/cancel, role changes, doctor provisioning/revocation, exports, and admin access changes.

### P1 — reliability before routine operations

1. Port the transition matrix and active doctor lock into a single server transaction; reconcile existing statuses and locks.
2. Enforce unique token allocation, per-phone limits (if retained), daily cutover timezone, and duplicate/idempotency keys inside the server transaction.
3. Use only real event timestamps for wait/service metrics; report sample count, missing-data rate, and timezone. Never extrapolate from queue depth as measured wait.
4. Make public number lookup require a hospital plus a non-guessable pass capability; do not scan every tenant.
5. Add Firebase Emulator tests for rules, concurrent issuance, competing call actions, cross-tenant reads/writes, and doctor/admin revocation.

### P2 — clinic operations and scale

1. Add a notification worker (Cloud Tasks/Pub/Sub or equivalent) with provider credentials in Secret Manager, consent/opt-out, delivery state, retries, and audit events.
2. Add retention automation, backups/restore drills, structured logs, alerting, App Check, and security headers.
3. Add operational UX for network loss, stale queue locks, shift close, accessibility, and clear timezone display.
4. Keep roadmap limited to multi-branch OPD queue operations; do not build an EHR/ERP in this product.

## 5. Recommended File Changes

### Implemented in this audit

- `js/queue-domain.js`: valid queue state machine, Firestore transactional transitions and active token lock, safe counter increment, measured wait helper, and UID ownership helper.
- `js/app.js`: removed the obsolete client SHA-256 PIN helper and its misleading security claim.
- `frontdesk.html`: shared transactional transitions, validated token counter, and removal of invalid Done/Skip actions from waiting rows.
- `book.html`: validated token counter remains within the transaction that creates the booking.
- `doctor.html`: canonical Firebase UID linkage before queue access; transactional call/skip/complete; removed clinical note UI and writes.
- `doctor-login.html`: removed anonymous/PIN credential scans and session fabrication; PIN inputs are disabled pending secure Auth provisioning.
- `admin.html`: removed unowned-single-hospital/email fallback, PIN creation/reset, and public recovery-key lookup/display/generation; doctor edits delete legacy PIN fields; require verified admin email in the UI.
- `analytics.html`: authenticated UI gate and UID-filtered hospital selection; measured wait average from actual timestamps.
- `display.html`, `token.html`, `track.html`: no patient names on public views; no invented time estimates; ambiguous token-number lookup rejected.
- `index.html`, `privacy.html`: corrected token routing and privacy/security claims to match the current implementation.
- `tests/queue-domain.test.cjs`: focused Node tests for monotonic numbers, state transitions, active lock, analytics, UID ownership, and disabled PIN flow.
- `README.md`: added the production safety gate, report link, and local test command.

### Required next files/infrastructure

- `firestore.rules` + `firebase.json`: default-deny policy and Emulator Suite configuration; rules must be designed alongside the API/data migration, not permissively added to the current client schema.
- `functions/` or equivalent service: Admin SDK authorization, token transactions, doctor Auth provisioning, sanitized public reads, audit log writes, notifications, and scheduled retention.
- `scripts/migrate-legacy-data.*`: Admin SDK-only removal of old `pin`, `pinHash`, recovery keys, root doctor mirrors, and clinical-note fields after verified backup and approval.
- `tests/firestore-rules.test.*`: Emulator tests for anonymous/public access, cross-tenant isolation, role enforcement, immutability, and allowed queue transitions.
- `README.md` / deployment runbook: Firebase project selection, rules/function deployment, secrets, indexes, backups, and rollback. No deployment should rely on the client `apiKey` being secret.

## 6. Security Recommendations

- The Firebase web `apiKey` in `js/firebase-config.js` is a public client identifier, not a server secret. Restrict it by allowed web origins and APIs, but rely on Rules and backend checks for access control. Confirm the referenced `tokenonspot` project is the intended target and review its deployed Rules/Auth users before any deployment.
- Split public and private data. Firestore cannot field-redact a readable document. Public TV/directory records should contain only hospital label, token number, room, and status; never name, phone, email, PIN, notes, recovery key, or admin UID.
- Use Auth UID/custom claims plus hospital membership verified server-side. Rules should deny all writes to security-sensitive collections from clients; public callable endpoints must rate-limit and validate App Check where applicable.
- Make public tracking a capability URL with at least 128 bits of cryptographically random entropy, store a hash of that capability server-side, and expose only a minimal response. Do not use sequential token document IDs as authorization.
- Queue transitions should check source state, actor role, doctor assignment, date, and active lock in one trusted transaction. Write the business event and audit log in that transaction or an idempotent outbox.
- Keep provider secrets in Secret Manager. Avoid browser-originated arbitrary `/sms_queue` writes; validate consent, normalize numbers, prevent abuse, and store delivery receipts without logging message bodies unnecessarily.
- Define clinic-local timezone, data minimization, retention and deletion periods, access/export policy, breach response, backups, and legal/privacy review for the launch region.

## 7. Product Scope Recommendations

Keep TokSpot a clinic/hospital OPD queue tool: booking/walk-in issue, token status, room calling, front desk, doctor desk, waiting display, admin setup, and operational analytics. Do not store diagnosis, prescriptions, consultation notes, medication, billing, or longitudinal history. Integrate with a separately governed EHR only through a later, explicitly scoped integration.

For small clinics, start with one verified admin, a small number of Firebase Auth doctor accounts, a single branch timezone, server-issued tokens, a privacy-safe TV view, and a managed notification provider. Add multi-branch, custom roles, and high-volume throughput only after rules/functions and incident operations are proven.

## 8. Suggested Roadmap

1. **Containment (now):** deploy no real patient data; disable legacy doctor PIN and recovery; back up Firestore; inventory existing exposed records; restrict Firebase Auth/domain/API configuration.
2. **Secure foundation:** define private/public schema, implement Rules default-deny, create Functions/API, provision Auth doctor identities, server-side audit log, and Emulator tests. Run a one-time legacy migration only after backup and restore test.
3. **Pilot readiness:** port issuance and queue transitions to idempotent server transactions; implement privacy-safe tracking/TV endpoints; measure actual timestamps; add basic notification worker and retention job; run a single-clinic pilot with synthetic data first.
4. **Controlled clinic pilot:** security test, concurrency test, restore drill, staff workflow training, incident/contact runbook, consent/privacy review, and sign-off from the clinic data owner.
5. **Scale:** multi-branch membership, operational dashboards, provider failover, monitoring/SLOs, and load testing. No ERP/EHR expansion in this phase.

## 9. Final Verdict

**Not production-ready for real hospital/patient data.** The repository is a promising OPD queue prototype with working client workflows, but lacks server-enforced tenant isolation, secure doctor identity provisioning, audit logging, retention, and trusted notification delivery. The code changes here reduce immediate leaks and accidental invalid transitions while intentionally disabling insecure doctor access. Complete P0 infrastructure and Emulator verification before reopening doctor operations or onboarding a real clinic.

## Team / AI Agent Implementation Notes

- Treat this document as an execution boundary: do not re-enable PIN auth, `signInAnonymously` staff access, or broad tenant reads to “restore” the old UX.
- Use Firebase Admin SDK only in trusted Functions/scripts for custom claims, account provisioning, migrations, audit, or deletion. Never put Admin credentials in browser code.
- Add the rules and backend together with data projections; avoid rules that allow the existing broad client queries just to make the static site work.
- During migration, preserve queue token number/date/status and event timestamps; remove only credential/clinical fields after backup and owner approval.
- Test competing calls, double submissions, network retry/idempotency, cross-hospital IDs, local midnight/timezone cutover, revoked Auth sessions, and public capability leakage before launch.
- Keep audit events immutable and exclude unnecessary patient data from logs. Store actor UID, tenant, action, target ID, server timestamp, and outcome.
