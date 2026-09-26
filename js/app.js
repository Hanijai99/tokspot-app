// =========================================================================
// UNIVERSAL CRYPTO UTILITIES (TOKMARK SECURITY)
// =========================================================================

window.hashPin = async function(pin) {
  if (!pin) return '';
  const text = String(pin).trim();
  const msgUint8 = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
};

/**
 * Compare an input PIN with a stored hash. Plain-text values are accepted only
 * for legacy migration; new writes must store only pinHash.
 */
window.matchesStoredPin = async function(storedPinValue, inputPin) {
  if (!storedPinValue || !inputPin) return false;
  const stored = String(storedPinValue).trim();
  const input = String(inputPin).trim();
  if (stored.length === 64) return stored === await window.hashPin(input);
  return stored.length === 4 && stored === input;
};

/** Public-safe patient display name; do not expose full names on TV boards. */
window.maskPatientName = function(name) {
  const value = String(name || '').trim();
  if (!value) return 'Patient';
  const parts = value.split(/\s+/).filter(Boolean);
  return parts.length > 1
    ? `${parts[0]} ${parts[parts.length - 1].charAt(0)}.`
    : `${parts[0].slice(0, 12)}${parts[0].length > 12 ? '…' : ''}`;
};

/**
 * Allowed queue state transitions. UI code should use this before updateDoc;
 * backend Firestore rules must enforce the same policy.
 */
window.TOKSPOT_QUEUE_TRANSITIONS = Object.freeze({
  waiting: ['called', 'canceled'],
  called: ['completed', 'skipped'],
  'in-consultation': ['completed', 'skipped'],
  skipped: ['waiting', 'canceled'],
  completed: [],
  canceled: []
});

window.isValidQueueTransition = function(from, to) {
  return Boolean(window.TOKSPOT_QUEUE_TRANSITIONS[from]?.includes(to));
};

// =========================================================================
// UNIVERSAL MULTI-LANGUAGE VOICE ANNOUNCEMENT ENGINE FOR TOKMARK
// =========================================================================

window.TOKMARK_LANGS = {
  ta: { code: 'ta-IN', name: 'Tamil', template: (num, name, counter) => `டோக்கன் எண் ${num}. ${name}. கவுண்டர் ${counter}-க்கு வரவும்.` },
  en: { code: 'en-IN', name: 'English', template: (num, name, counter) => `Token number ${num}. ${name}. Please proceed to Counter ${counter}.` },
  hi: { code: 'hi-IN', name: 'Hindi', template: (num, name, counter) => `टोकन संख्या ${num}. ${name}. कृपया काउंटर ${counter} पर जाएं.` },
  te: { code: 'te-IN', name: 'Telugu', template: (num, name, counter) => `టోకెన్ సంఖ్య ${num}. ${name}. దయచేసి కౌంటర్ ${counter} వద్దకు వెళ్లండి.` },
  kn: { code: 'kn-IN', name: 'Kannada', template: (num, name, counter) => `ಟೋಕನ್ ಸಂಖ್ಯೆ ${num}. ${name}. ದಯವಿಟ್ಟು ಕೌಂಟರ್ ${counter} ಗೆ ಹೋಗಿ.` },
  ml: { code: 'ml-IN', name: 'Malayalam', template: (num, name, counter) => `ടോക്കൺ നമ്പർ ${num}. ${name}. ദയവായി കൗണ്ടർ ${counter}-ലേക്ക് പോകുക.` },
  bn: { code: 'bn-IN', name: 'Bengali', template: (num, name, counter) => `টোকেন নম্বর ${num}. ${name}. দয়া করে কাউন্টার ${counter}-এ আসুন.` },
  mr: { code: 'mr-IN', name: 'Marathi', template: (num, name, counter) => `टोकन क्रमांक ${num}. ${name}. कृपया काउंटर ${counter} वर जा.` },
  gu: { code: 'gu-IN', name: 'Gujarati', template: (num, name, counter) => `ટોકન નંબર ${num}. ${name}. કૃપા કરીને કાઉન્ટર ${counter} પર જાઓ.` },
  ar: { code: 'ar-SA', name: 'Arabic', template: (num, name, counter) => `رقم الرمز ${num}. ${name}. يرجى التوجه إلى شباك ${counter}.` },
  es: { code: 'es-ES', name: 'Spanish', template: (num, name, counter) => `Token número ${num}. ${name}. Por favor pase a la ventanilla ${counter}.` },
  fr: { code: 'fr-FR', name: 'French', template: (num, name, counter) => `Jeton numéro ${num}. ${name}. Veuillez vous rendre au guichet ${counter}.` }
};
window.TOKSPOT_LANGS = window.TOKMARK_LANGS;

window.announceToken = function(tokenNumber, patientName, counter, selectedLangKeys) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  let savedLangs;
  try { savedLangs = JSON.parse(localStorage.getItem('tokmark_voice_langs') || localStorage.getItem('tokspot_voice_langs') || '["ta","en"]'); } catch (_) { savedLangs = ['ta', 'en']; }
  const langsToPlay = selectedLangKeys || savedLangs;
  const cleanCounter = counter ? String(counter).replace(/^Counter\s*/i, '') : 'A';
  const cleanName = window.maskPatientName(patientName);
  const voices = window.speechSynthesis.getVoices();
  const utterances = [];
  langsToPlay.forEach(key => {
    const lang = window.TOKMARK_LANGS[key];
    if (!lang) return;
    const utterance = new SpeechSynthesisUtterance(lang.template(tokenNumber, cleanName, cleanCounter));
    utterance.lang = lang.code;
    utterance.rate = 0.88;
    utterance.pitch = 1;
    const voice = voices.find(v => v.lang === lang.code || v.lang.startsWith(key));
    if (voice) utterance.voice = voice;
    utterances.push(utterance);
  });
  if (!utterances.length) return;
  for (let i = 0; i < utterances.length - 1; i++) {
    utterances[i].onend = () => setTimeout(() => window.speechSynthesis.speak(utterances[i + 1]), 450);
    utterances[i].onerror = () => window.speechSynthesis.speak(utterances[i + 1]);
  }
  window.speechSynthesis.speak(utterances[0]);
};

if ('speechSynthesis' in window) window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
