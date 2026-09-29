/**
 * TokSpot i18n — lightweight UI language layer (no framework).
 * en (English) and ta (தமிழ்) ship complete; other codes fall back to
 * English until their dictionary is filled in.
 *
 * Usage:
 *   <script src="js/i18n.js"></script>   (after firebase-config.js)
 *   I18N.init();                         (after DOM is ready — add data-i18n)
 *   <span data-i18n="nav.track">Track</span>
 *   <input data-i18n-ph="search.hint" />
 *   <div data-i18n-title="titles.help"></div>
 *   I18N.t('key')                        (programmatic)
 */
(function (root) {
  const STORE_KEY = 'tokspot_lang';
  const SUPPORTED = ['en', 'ta'];

  const dictionary = {
    en: {
      'nav.track': 'Track',
      'nav.book': 'Book Token',
      'nav.tv': 'TV Display',
      'nav.admin': 'Admin',
      'nav.desk': 'Front Desk',
      'nav.doctor': 'Doctor Desk',
      'brand.tag': 'Smart OPD queue for your hospital',
      'index.hero.title': 'No more crowds at the counter.',
      'index.hero.sub': 'Book a token from your phone and watch your turn live — arrive only when you\'re next.',
      'index.cta.book': 'Get a Token Now',
      'index.cta.track': 'Track My Token',
      'index.cta.tv': 'Waiting Room TV',
      'index.feature.1': 'Live token status on your phone',
      'index.feature.2': 'SMS/WhatsApp alerts when it\'s your turn',
      'index.feature.3': 'Privacy-first: no names on public screens',
      'index.feature.4': 'Works in every department',
      'index.how.title': 'How it works',
      'index.how.1': 'Enter the hospital code shown at reception',
      'index.how.2': 'Pick your doctor and book a slot',
      'index.how.3': 'Watch the waiting count live',
      'index.how.4': 'Walk in when your token is called',
      'code.enter.hint': 'Find your hospital by name or code',
      'code.direct': 'Direct Lookup Code',
      'book.step.doctor': 'Select Consultation Doctor',
      'book.step.name': 'Patient Full Name',
      'book.step.phone': 'Mobile Number',
      'book.step.phone.sub': '(for live queue alerts)',
      'book.cta.token': 'Confirm & Get Live Token',
      'book.appt.title': 'Book Advanced Appointment',
      'book.appt.sub': '(optional — skip for a walk-in token)',
      'book.appt.pick': 'Pick a time slot',
      'book.appt.today': 'Today',
      'book.appt.tomorrow': 'Tomorrow',
      'token.nowServing': 'Now Serving',
      'token.ahead': 'People Ahead',
      'token.estWait': 'Estimated Wait',
      'token.arrive': 'Please arrive now.',
      'token.yourTurn': 'It is your turn now!',
      'token.enterRoom': 'Please enter the doctor room immediately.',
      'token.waiting': 'Please wait.',
      'token.canceled': 'This token was canceled.',
      'token.completed': 'Consultation completed. Thank you!',
      'token.skipped': 'You were skipped / on hold. Please check with the front desk.',
      'token.next': 'You are NEXT! Please wait right outside the doctor door.',
      'token.search': 'Locate Token',
      'token.codeHint': 'e.g. HOSP-1234',
      'track.title': 'Track my token',
      'track.hint': 'Enter your token number (e.g. 012)',
      'display.launch': 'Waiting Hall TV Screen',
      'display.launchSub': 'Enter Hospital Code to display real-time waiting tokens and voice calls.',
      'display.calling': 'Now Calling',
      'display.next': 'Next in Line (Waiting)',
      'display.waiting': 'WAITING',
      'display.proceedRoom': 'Please proceed to the displayed room',
      'display.estWait': 'min wait for next slot',
      'display.open': 'Open',
      'display.break': 'On Break',
      'display.closed': 'Closed',
      'desk.overview': 'Today\'s Overview',
      'desk.waiting': 'Waiting',
      'desk.called': 'Called',
      'desk.skipped': 'Skipped',
      'desk.served': 'Served',
      'desk.queue': 'Waiting Queue',
      'desk.appointments': 'Today\'s Appointments',
      'desk.issue': 'Issue Token',
      'desk.checkin': 'Check-in → Token',
      'doctor.waiting': 'Waiting In Queue',
      'doctor.current': 'Currently In Room',
      'doctor.breakOn': 'Start Break',
      'doctor.breakOff': 'Resume',
      'doctor.onBreak': 'On Break',
      'doctor.active': 'Active Desk',
      'admin.verify.title': 'Verify your email to continue',
      'admin.verify.resend': 'Resend Verification Email',
      'admin.verify.continue': 'I\'ve Verified — Continue',
      'admin.verify.other': 'Use a different account',
    },
    ta: {
      'nav.track': 'ட்ராக்',
      'nav.book': 'டோக்கன் பதிவு',
      'nav.tv': 'டிவி டிஸ்ப்ளே',
      'nav.admin': 'நிர்வாகம்',
      'nav.desk': 'முன் எதிர் மேசை',
      'nav.doctor': 'டாக்டர் மேசை',
      'brand.tag': 'உங்கள் மருத்துவமனைக்கான ஸ்மார்ட் OPD வரிசை',
      'index.hero.title': 'கவுண்டரில் கூட்டம் இனி இல்லை.',
      'index.hero.sub': 'உங்கள் போனில் இருந்தே டோக்கன் எடுங்கள் — உங்கள் முறை வருவதை லைவ்வாக பாருங்கள், முறை வரும் போது மட்டும் வாருங்கள்.',
      'index.cta.book': 'இப்போதே டோக்கன் எடு',
      'index.cta.track': 'என் டோக்கனை ட்ராக் செய்',
      'index.cta.tv': 'காத்திருப்பு அறை டிவி',
      'index.feature.1': 'போனில் லைவ் டோக்கன் நிலை',
      'index.feature.2': 'உங்கள் முறை வரும்போது SMS/WhatsApp எச்சரிக்கை',
      'index.feature.3': 'தனியுரிமை முதன்மை: பொது திரைகளில் பெயர் இல்லை',
      'index.feature.4': 'எல்லா துறைகளிலும் வேலை செய்யும்',
      'index.how.title': 'இது எப்படி வேலை செய்கிறது',
      'index.how.1': 'பெறுநர் மேசையில் உள்ள மருத்துவமனை குறியீட்டை உள்ளிடவும்',
      'index.how.2': 'டாக்டரை தேர்வு செய்து நேர ஒதுக்கீடு செய்யவும்',
      'index.how.3': 'காத்திருப்போர் எண்ணிக்கையை லைவ்வாக பார்க்கவும்',
      'index.how.4': 'உங்கள் டோக்கன் அழைக்கப்படும்போது உள்ளே வாருங்கள்',
      'code.enter.hint': 'பெயர் அல்லது குறியீடு மூலம் மருத்துவமனையைக் கண்டறியவும்',
      'code.direct': 'நேரடி குறியீடு தேடல்',
      'book.step.doctor': 'ஆலோசனை டாக்டரை தேர்வு செய்யவும்',
      'book.step.name': 'நோயாளியின் முழு பெயர்',
      'book.step.phone': 'மொபைல் எண்',
      'book.step.phone.sub': '(லைவ் வரிசை எச்சரிக்கைகளுக்கு)',
      'book.cta.token': 'உறுதி செய்து லைவ் டோக்கன் பெறு',
      'book.appt.title': 'முன்பதிவு செய்யவும்',
      'book.appt.sub': '(விருப்பம் — வாக்-இன் டோக்கனுக்கு தவிர்க்கலாம்)',
      'book.appt.pick': 'நேரத்தை தேர்வு செய்யவும்',
      'book.appt.today': 'இன்று',
      'book.appt.tomorrow': 'நாளை',
      'token.nowServing': 'இப்போது சேவை',
      'token.ahead': 'முன்னால் உள்ளவர்கள்',
      'token.estWait': 'மதிப்பிடப்பட்ட காத்திருப்பு',
      'token.arrive': 'இப்போதே வாருங்கள்.',
      'token.yourTurn': 'இப்போது உங்கள் முறை!',
      'token.enterRoom': 'உடனே டாக்டர் அறைக்குள் செல்லவும்.',
      'token.waiting': 'தயவுசெய்து காத்திருங்கள்.',
      'token.canceled': 'இந்த டோக்கன் ரத்து செய்யப்பட்டது.',
      'token.completed': 'ஆலோசனை முடிந்தது. நன்றி!',
      'token.skipped': 'நீங்கள் ஒத்திவைக்கப்பட்டீர்கள். முன் எதிர் மேசையை அணுகவும்.',
      'token.next': 'நீங்கள் அடுத்தவர்! டாக்டர் கதவுக்கு வெளியே காத்திருங்கள்.',
      'token.search': 'டோக்கனை கண்டுபிடி',
      'token.codeHint': 'எ.கா. HOSP-1234',
      'track.title': 'என் டோக்கனை ட்ராக் செய்',
      'track.hint': 'உங்கள் டோக்கன் எண்ணை உள்ளிடவும் (எ.கா. 012)',
      'display.launch': 'காத்திருப்பு அறை TV திரை',
      'display.launchSub': 'லைவ் காத்திருப்பு டோக்கன்கள் மற்றும் ஒலி அறிவிப்புகளுக்கு மருத்துவமனை குறியீட்டை உள்ளிடவும்.',
      'display.calling': 'இப்போது அழைப்பு',
      'display.next': 'அடுத்த வரிசை (காத்திருப்பு)',
      'display.waiting': 'காத்திருக்கிறார்கள்',
      'display.proceedRoom': 'காட்டப்படும் அறைக்கு செல்லுங்கள்',
      'display.estWait': 'நிமிட காத்திருப்பு — அடுத்த இடம்',
      'display.open': 'திறந்தது',
      'display.break': 'இடைவேளை',
      'display.closed': 'மூடப்பட்டது',
      'desk.overview': 'இன்றைய கண்ணோட்டம்',
      'desk.waiting': 'காத்திருப்பு',
      'desk.called': 'அழைக்கப்பட்டது',
      'desk.skipped': 'ஒத்திவைக்கப்பட்டது',
      'desk.served': 'முடிந்தது',
      'desk.queue': 'காத்திருப்பு வரிசை',
      'desk.appointments': 'இன்றைய முன்பதிவுகள்',
      'desk.issue': 'டோக்கன் வழங்கு',
      'desk.checkin': 'செக்-இன் → டோக்கன்',
      'doctor.waiting': 'காத்திருப்பு வரிசை',
      'doctor.current': 'தற்போது அறையில்',
      'doctor.breakOn': 'இடைவேளை எடு',
      'doctor.breakOff': 'திரும்பு',
      'doctor.onBreak': 'இடைவேளை',
      'doctor.active': 'செயலில் உள்ள மேசை',
      'admin.verify.title': 'தொடர உங்கள் மின்னஞ்சலை உறுதிப்படுத்தவும்',
      'admin.verify.resend': 'மின்னஞ்சல் மீண்டும் அனுப்பு',
      'admin.verify.continue': 'உறுதிப்படுத்தியது — தொடரவும்',
      'admin.verify.other': 'வேறு கணக்கைப் பயன்படுத்து',
    },
  };

  function translate(lang, key) {
    const dict = dictionary[lang] || dictionary.en;
    return dict[key] !== undefined ? dict[key] : (dictionary.en[key] !== undefined ? dictionary.en[key] : key);
  }

  function currentLang() {
    try {
      const saved = localStorage.getItem(STORE_KEY);
      if (saved && SUPPORTED.indexOf(saved) !== -1) return saved;
    } catch (e) {}
    return 'en';
  }

  function apply(root) {
    const scope = root || document;
    const lang = currentLang();
    scope.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = translate(lang, el.getAttribute('data-i18n')); });
    scope.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.setAttribute('placeholder', translate(lang, el.getAttribute('data-i18n-ph'))); });
    scope.querySelectorAll('[data-i18n-title]').forEach((el) => { el.setAttribute('title', translate(lang, el.getAttribute('data-i18n-title'))); });
    scope.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = translate(lang, el.getAttribute('data-i18n-html')); });
    const html = document.documentElement;
    if (html) { html.setAttribute('lang', currentLang()); }
    const hi = document.getElementById('i18nSwitcher');
    if (hi) { hi.value = currentLang(); }
  }

  function setLang(lang) {
    const target = SUPPORTED.indexOf(lang) !== -1 ? lang : 'en';
    try { localStorage.setItem(STORE_KEY, target); } catch (e) {}
    apply(document);
    document.dispatchEvent(new CustomEvent('i18n:change', { detail: { lang: target } }));
  }

  // Injects a language switcher into the page topbar (or a floating chip).
  function injectSwitcher() {
    const bar = document.querySelector('.topbar');
    const select = document.createElement('select');
    select.id = 'i18nSwitcher';
    select.setAttribute('aria-label', 'Language');
    select.style.cssText = 'background:#0f172a;color:#cbd5e1;border:1px solid #334155;border-radius:8px;font-size:.78rem;font-weight:700;padding:4px 6px;cursor:pointer;';
    select.innerHTML = '<option value="en">EN</option><option value="ta">தமிழ்</option>';
    select.value = currentLang();
    select.addEventListener('change', () => setLang(select.value));
    if (bar) {
      // Place at the far right, after the spacer.
      bar.appendChild(select);
    } else {
      select.style.position = 'fixed';
      select.style.top = '12px';
      select.style.right = '12px';
      select.style.zIndex = '9999';
      document.body.appendChild(select);
    }
  }

  function init() {
    injectSwitcher();
    apply(document);
  }

  const I18N = {
    t: (key) => translate(currentLang(), key),
    lang: currentLang,
    setLang,
    apply,
    init,
    supported: SUPPORTED,
    dicts: dictionary,
  };

  root.I18N = I18N;
  if (typeof module !== 'undefined' && module.exports) module.exports = I18N;
})(typeof globalThis !== 'undefined' ? globalThis : this);