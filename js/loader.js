/* ============================================================
   TOKMARK GLOBAL AUTO-LOADER & SKELETON ENGINE
   ============================================================ */

(function () {
  // 1. Inject Styles for Loader and Skeleton into Document Head
  const loaderStyle = document.createElement('style');
  loaderStyle.id = 'tokmark-loader-styles';
  loaderStyle.innerHTML = `
    #appLoader {
      position: fixed;
      inset: 0;
      background: #060b16;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      z-index: 999999;
      transition: opacity 0.35s cubic-bezier(0.4, 0, 0.2, 1), visibility 0.35s ease;
    }
    #appLoader.loaded {
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
    }
    .tok-loader-wrap {
      width: 72px;
      height: 72px;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
    }
    .tok-loader-logo {
      width: 100%;
      height: 100%;
      object-fit: contain;
      animation: tokPulse 1.6s ease-in-out infinite;
    }
    .tok-progress-track {
      width: 120px;
      height: 3px;
      background: #111a2e;
      border-radius: 99px;
      margin-top: 20px;
      overflow: hidden;
      position: relative;
    }
    .tok-progress-fill {
      position: absolute;
      top: 0;
      left: -50%;
      height: 100%;
      width: 50%;
      background: linear-gradient(90deg, #00d2ff, #22c55e);
      border-radius: 99px;
      animation: tokShimmer 1.1s infinite ease-in-out;
    }
    @keyframes tokPulse {
      0%, 100% { transform: scale(0.95); filter: drop-shadow(0 0 10px rgba(34, 197, 94, 0.25)); }
      50% { transform: scale(1.06); filter: drop-shadow(0 0 22px rgba(0, 210, 255, 0.6)); }
    }
    @keyframes tokShimmer {
      0% { left: -50%; }
      100% { left: 100%; }
    }
  `;
  document.head.appendChild(loaderStyle);

  // 2. Inject HTML element at top of Body as soon as DOM is ready
  function injectLoaderHTML() {
    if (document.getElementById('appLoader')) return;
    const loaderDiv = document.createElement('div');
    loaderDiv.id = 'appLoader';
    loaderDiv.innerHTML = `
      <div class="tok-loader-wrap">
        <img src="logo.png?v=2" alt="TokMark" class="tok-loader-logo" />
      </div>
      <div class="tok-progress-track">
        <div class="tok-progress-fill"></div>
      </div>
    `;
    document.body.prepend(loaderDiv);
  }

  if (document.body) {
    injectLoaderHTML();
  } else {
    document.addEventListener('DOMContentLoaded', injectLoaderHTML);
  }

  // 3. Global function to dismiss loader
  window.hideAppLoader = function () {
    const el = document.getElementById('appLoader');
    if (el && !el.classList.contains('loaded')) {
      el.classList.add('loaded');
      setTimeout(() => {
        if (el && el.parentNode) el.parentNode.removeChild(el);
      }, 400);
    }
  };

  // 4. Auto dismiss when window completes loading
  window.addEventListener('load', () => {
    setTimeout(window.hideAppLoader, 300);
  });

  // Safety fallback (Max 3 seconds screen lock prevention)
  setTimeout(window.hideAppLoader, 3000);
})();
