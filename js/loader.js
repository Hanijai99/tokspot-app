/* ============================================================
   TOKSPOT GLOBAL AUTO-LOADER & SKELETON ENGINE
   ============================================================ */

(function () {
  const MIN_LOADER_MS = 4000;
  const MAX_LOADER_MS = 4500;
  const startedAt = Date.now();
  let dismissed = false;

  // Inject styles for the video loader and progress indicator.
  const loaderStyle = document.createElement('style');
  loaderStyle.id = 'tokspot-loader-styles';
  loaderStyle.textContent = `
    #appLoader {
      position: fixed;
      inset: 0;
      background: #092328;
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
    .tok-loader-video {
      display: block;
      width: min(80vw, 560px);
      max-height: 70vh;
      object-fit: contain;
      border-radius: 16px;
    }
    .tok-loader-fallback {
      display: none;
      width: 72px;
      height: 72px;
      object-fit: contain;
      animation: tokPulse 1.6s ease-in-out infinite;
    }
    #appLoader.video-error .tok-loader-video { display: none; }
    #appLoader.video-error .tok-loader-fallback { display: block; }
    .tok-progress-track {
      width: 120px;
      height: 3px;
      background: #12544F;
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
      background: #8BBB92;
      border-radius: 99px;
      animation: tokShimmer 1.1s infinite ease-in-out;
    }
    @keyframes tokPulse {
      0%, 100% { transform: scale(0.95); }
      50% { transform: scale(1.06); }
    }
    @keyframes tokShimmer {
      0% { left: -50%; }
      100% { left: 100%; }
    }
    @media (prefers-reduced-motion: reduce) {
      .tok-progress-fill, .tok-loader-fallback { animation: none; }
      #appLoader { transition: none; }
    }
  `;
  document.head.appendChild(loaderStyle);

  function injectLoaderHTML() {
    if (document.getElementById('appLoader')) return;

    const loaderDiv = document.createElement('div');
    loaderDiv.id = 'appLoader';
    loaderDiv.setAttribute('role', 'status');
    loaderDiv.setAttribute('aria-label', 'Loading TokSpot');
    loaderDiv.innerHTML = `
      <video class="tok-loader-video" autoplay muted loop playsinline preload="auto" aria-hidden="true">
        <source src="/apploaderhospital.mp4?v=20261103" type="video/mp4" />
      </video>
      <img class="tok-loader-fallback" src="/logo.png?v=2" alt="TokSpot" />
      <div class="tok-progress-track" aria-hidden="true">
        <div class="tok-progress-fill"></div>
      </div>
    `;
    document.body.prepend(loaderDiv);

    const video = loaderDiv.querySelector('video');
    video.addEventListener('error', () => loaderDiv.classList.add('video-error'));
    video.addEventListener('loadeddata', () => loaderDiv.classList.remove('video-error'), { once: true });
    const playPromise = video.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(() => loaderDiv.classList.add('video-error'));
    }
  }

  if (document.body) {
    injectLoaderHTML();
  } else {
    document.addEventListener('DOMContentLoaded', injectLoaderHTML, { once: true });
  }

  window.hideAppLoader = function () {
    if (dismissed) return;
    const el = document.getElementById('appLoader');
    if (!el) return;
    dismissed = true;
    el.classList.add('loaded');
    setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 400);
  };

  // Keep the animation visible for at least 4 seconds after navigation, then
  // dismiss when the page has loaded. The 4.5-second cap prevents a stalled
  // page or network from trapping users behind the loader.
  window.addEventListener('load', () => {
    const elapsed = Date.now() - startedAt;
    setTimeout(window.hideAppLoader, Math.max(0, MIN_LOADER_MS - elapsed));
  }, { once: true });
  setTimeout(window.hideAppLoader, MAX_LOADER_MS);
})();
