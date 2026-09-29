const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const queue = require('../js/queue-domain.js');

function createMemoryFirestore(initialDocuments) {
  const documents = new Map(Object.entries(initialDocuments));
  const fsApi = {
    doc(_db, ...segments) { return segments.join('/'); },
    serverTimestamp() { return 123456789; },
    async runTransaction(_db, callback) {
      const writes = [];
      const transaction = {
        async get(ref) {
          const value = documents.get(ref);
          return {
            exists: () => value !== undefined,
            data: () => value
          };
        },
        update(ref, data) { writes.push({ type: 'update', ref, data }); },
        set(ref, data) { writes.push({ type: 'set', ref, data }); }
      };
      const result = await callback(transaction);
      for (const write of writes) {
        const existing = documents.get(write.ref) || {};
        documents.set(write.ref, { ...existing, ...write.data });
      }
      return result;
    }
  };
  return { fsApi, documents };
}

test('token counter produces monotonic unique sequence numbers', () => {
  const numbers = [0, 1, 2, 98].map(queue.nextTokenNumber);
  assert.deepEqual(numbers, [1, 2, 3, 99]);
  assert.equal(new Set(numbers).size, numbers.length);
  assert.throws(() => queue.nextTokenNumber(-1), /Invalid token counter/);
  assert.throws(() => queue.nextTokenNumber(1.5), /Invalid token counter/);
});

test('booking and front desk allocate numbers in their token-creation transactions', () => {
  // The issuance transaction lives in the shared API adapter (js/api.js);
  // pages delegate to it so the token counter logic is exercised in one place.
  const api = fs.readFileSync(path.join(__dirname, '..', 'js', 'api.js'), 'utf8');
  assert.match(api, /runTransaction/);
  assert.match(api, /TokspotQueue\.nextTokenNumber/);
  for (const page of ['book.html', 'frontdesk.html']) {
    const source = fs.readFileSync(path.join(__dirname, '..', page), 'utf8');
    assert.match(source, /TokSpotAPI\.issueToken/);
  }
});

test('queue state machine rejects invalid and terminal transitions', () => {
  assert.equal(queue.canTransition('waiting', 'called'), true);
  assert.equal(queue.canTransition('called', 'completed'), true);
  assert.equal(queue.canTransition('waiting', 'completed'), false);
  assert.equal(queue.canTransition('completed', 'waiting'), false);
});

test('transaction permits only one active token per doctor and day', async () => {
  const today = '2026-09-26';
  const { fsApi, documents } = createMemoryFirestore({
    'hospitals/demo/tokens/first': { status: 'waiting', doctorId: 'doctor-1', date: today },
    'hospitals/demo/tokens/second': { status: 'waiting', doctorId: 'doctor-1', date: today }
  });

  await queue.transitionToken(fsApi, {}, 'demo', 'first', 'called');
  await assert.rejects(
    queue.transitionToken(fsApi, {}, 'demo', 'second', 'called'),
    /already has an active patient/
  );
  await queue.transitionToken(fsApi, {}, 'demo', 'first', 'completed');
  await queue.transitionToken(fsApi, {}, 'demo', 'second', 'called');

  assert.equal(documents.get('hospitals/demo/tokens/first').status, 'completed');
  assert.equal(documents.get('hospitals/demo/tokens/second').status, 'called');
});

test('analytics averages only valid measured create-to-call intervals', () => {
  const actual = queue.averageWaitMinutes([
    { createdAt: new Date(0), calledAt: new Date(10 * 60000) },
    { createdAt: { toMillis: () => 0 }, calledAt: { toMillis: () => 20 * 60000 } },
    { createdAt: new Date(0) },
    { createdAt: new Date(30 * 60000), calledAt: new Date(20 * 60000) }
  ]);
  assert.equal(actual, 15);
  assert.equal(queue.averageWaitMinutes([{ createdAt: new Date(0) }]), null);
});

test('admin ownership requires the exact Firebase UID, not matching email', () => {
  const hospital = { adminUid: 'uid-owner', adminEmail: 'owner@example.test' };
  assert.equal(queue.isHospitalAdmin({ uid: 'uid-owner', email: 'other@example.test' }, hospital), true);
  assert.equal(queue.isHospitalAdmin({ uid: 'uid-other', email: 'owner@example.test' }, hospital), false);
  assert.equal(queue.isHospitalAdmin(null, hospital), false);
});

test('doctor PIN login remains closed until secure Auth provisioning exists', () => {
  const loginPage = fs.readFileSync(path.join(__dirname, '..', 'doctor-login.html'), 'utf8');
  const adminPage = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  assert.match(loginPage, /async function doctorPinLogin\(\) \{\s*showToast\(/);
  assert.match(loginPage, /async function doctorEmailLogin\(\) \{/);
  assert.match(loginPage, /getMyDoctorProfile/);
  assert.match(loginPage, /resolveHospitalByCode/);
  assert.doesNotMatch(loginPage, /checkPinMatch|signInAnonymously/);
  assert.doesNotMatch(adminPage, /data\.pin\s*=\s*rawPin|data\.pinHash\s*=\s*hashedPin|pin:\s*rawPin/);
});

test('legacy serving status is normalized to called for transitions and locks', async () => {
  // State machine
  assert.equal(queue.canTransition('serving', 'completed'), true);
  assert.equal(queue.canTransition('serving', 'called'), false);
  assert.equal(queue.normalizeStatus('serving'), 'called');

  // Lock semantics: a legacy serving token owns the active slot
  const today = '2026-09-26';
  const { fsApi, documents } = createMemoryFirestore({
    'hospitals/demo/tokens/legacy': { status: 'serving', doctorId: 'doctor-1', date: today },
    'hospitals/demo/tokens/other': { status: 'waiting', doctorId: 'doctor-1', date: today }
  });

  await queue.transitionToken(fsApi, {}, 'demo', 'legacy', 'completed');
  // second token can now be called after the legacy one closed its slot
  await queue.transitionToken(fsApi, {}, 'demo', 'other', 'called');

  assert.equal(documents.get('hospitals/demo/tokens/legacy').status, 'completed');
  assert.equal(documents.get('hospitals/demo/tokens/other').status, 'called');
  assert.equal(
    documents.get('hospitals/demo/queueState/2026-09-26_doctor-1').activeTokenId,
    'other'
  );
});

test('token doc ids are unguessable (no date+doctor+counter derivation)', () => {
  const api = fs.readFileSync(path.join(__dirname, '..', 'js', 'api.js'), 'utf8');
  // the single issuance path must use a random id, never the sequential form
  assert.match(api, /crypto\.randomUUID/);
  for (const page of ['book.html', 'frontdesk.html']) {
    const source = fs.readFileSync(path.join(__dirname, '..', page), 'utf8');
    assert.match(source, /TokSpotAPI\.issueToken/);
    assert.doesNotMatch(source, /const tokenId = `\$\{today\}-\$\{selectedDoctorId|const tokenId = `\$\{today\}-\$\{currentDoctor/);
  }
});

test('public TV display never voices or shows patient names', () => {
  const display = fs.readFileSync(path.join(__dirname, '..', 'display.html'), 'utf8');
  // the board must pass an empty string for patientName in call audio
  assert.match(display, /handlePatientCallAudio\(active\.number, '', counterLabel\)/);
  // waiting chips render only number + status, never the token's patient name
  assert.doesNotMatch(display, /t\.patientName/);
  assert.doesNotMatch(display, /escHtml\(t\.patientName\)/);
});
