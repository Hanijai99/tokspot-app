// =========================================================================
// UNIVERSAL MULTI-LANGUAGE VOICE ANNOUNCEMENT ENGINE FOR TOKMARK
// =========================================================================

// =========================================================================
// THEME (light/dark) TOGGLE — window.hk shared by every page.
// The CSS already ships full body.dark support; this restores the missing
// toggle JS and persists the choice so the button actually works.
// =========================================================================
window.hk = (function () {
  const KEY = 'tokspot_theme';
  function isDark() { return document.body && document.body.classList.contains('dark'); }
  function syncIcons() {
    const dark = isDark();
    document.querySelectorAll('.theme-toggle i, .icn-btn i.fa-moon, .icn-btn i.fa-sun').forEach((el) => {
      if (!el.classList.contains('fa-moon') && !el.classList.contains('fa-sun')) return;
      el.classList.toggle('fa-moon', !dark);
      el.classList.toggle('fa-sun', dark);
    });
  }
  function applyDark() {
    if (!document.body) return;
    let dark = false;
    try { dark = localStorage.getItem(KEY) === 'dark'; } catch (e) {}
    document.body.classList.toggle('dark', dark);
    syncIcons();
  }
  function toggleDark() {
    const dark = !isDark();
    document.body.classList.toggle('dark', dark);
    try { localStorage.setItem(KEY, dark ? 'dark' : 'light'); } catch (e) {}
    syncIcons();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyDark);
  } else {
    applyDark();
  }
  return { applyDark: applyDark, toggleDark: toggleDark };
})();

window.TOKMARK_LANGS = {
  // --- Indian Languages ---
  'ta': {
    code: 'ta-IN',
    name: 'Tamil',
    template: (num, name, counter) => `டோக்கன் எண் ${num}. ${name}. கவுண்டர் ${counter}-க்கு வரவும்.`
  },
  'en': {
    code: 'en-IN',
    name: 'English',
    template: (num, name, counter) => `Token number ${num}. ${name}. Please proceed to Counter ${counter}.`
  },
  'hi': {
    code: 'hi-IN',
    name: 'Hindi',
    template: (num, name, counter) => `टोकन संख्या ${num}. ${name}. कृपया काउंटर ${counter} पर जाएं.`
  },
  'te': {
    code: 'te-IN',
    name: 'Telugu',
    template: (num, name, counter) => `టోకెన్ సంఖ్య ${num}. ${name}. దయచేసి కౌంటర్ ${counter} వద్దకు వెళ్లండి.`
  },
  'kn': {
    code: 'kn-IN',
    name: 'Kannada',
    template: (num, name, counter) => `ಟೋಕನ್ ಸಂಖ್ಯೆ ${num}. ${name}. ದಯವಿಟ್ಟು ಕೌಂಟರ್ ${counter} ಗೆ ಹೋಗಿ.`
  },
  'ml': {
    code: 'ml-IN',
    name: 'Malayalam',
    template: (num, name, counter) => `ടോക്കൺ നമ്പർ ${num}. ${name}. ദയവായി കൗണ്ടർ ${counter}-ലേക്ക് പോകുക.`
  },
  'bn': {
    code: 'bn-IN',
    name: 'Bengali',
    template: (num, name, counter) => `টোকেন নম্বর ${num}. ${name}. দয়া করে কাউন্টার ${counter}-এ আসুন.`
  },
  'mr': {
    code: 'mr-IN',
    name: 'Marathi',
    template: (num, name, counter) => `टोकन क्रमांक ${num}. ${name}. कृपया काउंटर ${counter} वर जा.`
  },
  'gu': {
    code: 'gu-IN',
    name: 'Gujarati',
    template: (num, name, counter) => `ટોકન નંબર ${num}. ${name}. કૃપા કરીને કાઉન્ટર ${counter} પર જાઓ.`
  },

  // --- International Languages ---
  'ar': {
    code: 'ar-SA',
    name: 'Arabic',
    template: (num, name, counter) => `رقم الرمز ${num}. ${name}. يرجى التوجه إلى شباك ${counter}.`
  },
  'es': {
    code: 'es-ES',
    name: 'Spanish',
    template: (num, name, counter) => `Token número ${num}. ${name}. Por favor pase a la ventanilla ${counter}.`
  },
  'fr': {
    code: 'fr-FR',
    name: 'French',
    template: (num, name, counter) => `Jeton numéro ${num}. ${name}. Veuillez vous rendre au guichet ${counter}.`
  }
};

// Backwards compatibility alias
window.TOKSPOT_LANGS = window.TOKMARK_LANGS;

/**
 * Universal Multi-language Caller
 * @param {string|number} tokenNumber 
 * @param {string} patientName 
 * @param {string} counter 
 * @param {Array<string>} [selectedLangKeys] - e.g. ['ta', 'en']
 */
window.announceToken = function(tokenNumber, patientName, counter, selectedLangKeys) {
  if (!('speechSynthesis' in window)) return;

  // Stop any overlapping audio
  window.speechSynthesis.cancel();

  // Pick hospital configured languages or default to Tamil + English
  const savedLangs = JSON.parse(localStorage.getItem('tokmark_voice_langs') || localStorage.getItem('tokspot_voice_langs') || '["ta", "en"]');
  const langsToPlay = selectedLangKeys || savedLangs;

  const cleanCounter = counter ? String(counter).replace(/^Counter\s*/i, '') : 'A';
  const cleanName = patientName ? patientName.trim() : '';

  const allVoices = window.speechSynthesis.getVoices();
  const utterances = [];

  langsToPlay.forEach(key => {
    const langConfig = window.TOKMARK_LANGS[key];
    if (!langConfig) return;

    const speechText = langConfig.template(tokenNumber, cleanName, cleanCounter);
    const utter = new SpeechSynthesisUtterance(speechText);
    utter.lang = langConfig.code;
    utter.rate = 0.88;
    utter.pitch = 1.0;

    const voiceMatch = allVoices.find(v => v.lang === langConfig.code || v.lang.startsWith(key));
    if (voiceMatch) utter.voice = voiceMatch;

    utterances.push(utter);
  });

  if (!utterances.length) return;

  // Chain announcements with a 450ms pause between languages
  for (let i = 0; i < utterances.length - 1; i++) {
    utterances[i].onend = () => {
      setTimeout(() => {
        window.speechSynthesis.speak(utterances[i + 1]);
      }, 450);
    };
    utterances[i].onerror = () => {
      window.speechSynthesis.speak(utterances[i + 1]);
    };
  }

  window.speechSynthesis.speak(utterances[0]);
};

if ('speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = () => {
    window.speechSynthesis.getVoices();
  };
}
