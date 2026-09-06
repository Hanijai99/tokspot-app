/**
 * Shared app utilities for Hospital Token App.
 * Mirrors Thallu Billu's utils.js pattern.
 */
(function () {
  window.hk = window.hk || {};

  // Escape HTML to avoid injection
  window.escHtml = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  // ---- Toast ----
  window.showToast = function (msg, isErr, ms) {
    let w = document.getElementById('hkToastWrap');
    if (!w) { w = document.createElement('div'); w.id = 'hkToastWrap'; w.className = 'toast-wrap'; document.body.appendChild(w); }
    const t = document.createElement('div');
    t.className = 'toast' + (isErr ? ' err' : '');
    t.textContent = msg;
    w.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, ms || 2500);
  };

  // ---- Dark mode ----
  window.hk.applyDark = function () {
    const dark = localStorage.getItem('hk_dark') === '1';
    document.body.classList.toggle('dark', dark);
    return dark;
  };
  window.hk.toggleDark = function () {
    const on = localStorage.getItem('hk_dark') === '1';
    localStorage.setItem('hk_dark', on ? '0' : '1');
    window.hk.applyDark();
  };

  // ---- Token status badge ----
  window.statusBadge = function (s) {
    return `<span class="badge ${s}">${s}</span>`;
  };

  // ---- Playing beep sound (Web Audio, no file needed) ----
  window.playBeep = function (times) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const n = times || 2;
      for (let i = 0; i < n; i++) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = 880;
        osc.connect(gain); gain.connect(ctx.destination);
        const t0 = ctx.currentTime + i * 0.35;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.4, t0 + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
        osc.start(t0); osc.stop(t0 + 0.22);
      }
    } catch (e) { /* audio may be blocked */ }
  };

  // ---- Formatting ----
  window.pad3 = function (n) { return String(n).padStart(3, '0'); };

  // ---- Today's date string (YYYY-MM-DD, local) ----
  window.todayStr = function () {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  };

  // ---- Simple position indicator for a patient (client-side estimate) ----
  // queue = array of waiting tokens sorted ascending by number
  window.queuePosition = function (queue, tokenNumber) {
    if (!queue || queue.length === 0) return 1;
    const idx = queue.findIndex(t => String(t.number) === String(tokenNumber));
    return idx === -1 ? null : idx + 1;
  };

  // ---- Estimated wait: position * avgMinutesPerToken (default 5) ----
  window.estimateWait = function (position, avgMin) {
    const m = (position ? position : 1) * (avgMin || 5);
    return m;
  };

  // ---- Text-to-Speech announcement (audio board) ----
  window.speak = function (text, lang) {
    try {
      if (!('speechSynthesis' in window)) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text));
      u.lang = lang || 'en-IN';
      u.rate = 0.95;
      u.pitch = 1;
      window.speechSynthesis.speak(u);
    } catch (e) { /* TTS unsupported */ }
  };

  // Announce a token number + name, e.g. "Token 014, please come to counter A"
  window.announceToken = function (number, name, counter, lang) {
    let msg = 'Token ' + number;
    if (name) msg += ', ' + name;
    if (counter) msg += ', please come to counter ' + counter;
    window.speak(msg, lang);
  };

  // ---- Read URL query param ----
  window.getParam = function (name) {
    try { return new URLSearchParams(window.location.search).get(name) || ''; }
    catch (e) { return ''; }
  };

  // ---- QR <-> URL ----
  window.qrUrl = function (hospitalId, doctorId, dept) {
    const base = window.location.origin + window.location.pathname.replace(/[^/]*$/, 'book.html');
    const p = new URLSearchParams();
    if (hospitalId) p.set('h', hospitalId);
    if (doctorId) p.set('d', doctorId);
    if (dept) p.set('dept', dept);
    return base + '?' + p.toString();
  };
})();