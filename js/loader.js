/* ============================================================
   TOKSPOT GLOBAL AUTO-LOADER & SKELETON ENGINE
   ============================================================ */

(function () {
  // 1. Inject styles for the video loader and progress indicator.
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
      background: linear-gradient(90deg, #8BBB92, #8BBB92);
      border-radius: 99px;
      animation: tokShimmer 1.1s infinite ease-in-out;
    }
    @keyframes tokShimmer {
      0% { left: -50%; }
      100% { left: 100%; }
    }
    @media (prefers-reduced-motion: reduce) {
      .tok-progress-fill { animation: none; left: 0; width: 100%; }
      #appLoader { transition: none; }
    }
  `;
  document.head.appendChild(loaderStyle);

  // 2. Inject the loader into the body as soon as it is available.
  function injectLoaderHTML() {
    if (document.getElementById('appLoader')) return;

    const loaderDiv = document.createElement('div');
    loaderDiv.id = 'appLoader';
    loaderDiv.setAttribute('role', 'status');
    loaderDiv.setAttribute('aria-label', 'Loading TokSpot');
    loaderDiv.innerHTML = `
      <video
        class="tok-loader-video"
        autoplay
        muted
        loop
        playsinline
        preload="auto"
        aria-label="TokSpot loading animation"
      >
        <source src="apploaderhospital.mp4" type="video/mp4" />
      </video>
      <div class="tok-progress-track" aria-hidden="true">
        <div class="tok-progress-fill"></div>
      </div>
    `;
    document.body.prepend(loaderDiv);

    // Muted autoplay is supported by modern browsers; retry playback where needed.
    const video = loaderDiv.querySelector('video');
    const playPromise = video.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(() => {
        // The progress indicator remains visible if autoplay is blocked or video fails.
      });
    }
  }

  if (document.body) {
    injectLoaderHTML();
  } else {
    document.addEventListener('DOMContentLoaded', injectLoaderHTML, { once: true });
  }

  // 3. Global function to dismiss the loader.
  window.hideAppLoader = function () {
    const el = document.getElementById('appLoader');
    if (el && !el.classList.contains('loaded')) {
      el.classList.add('loaded');
      setTimeout(() => {
        if (el && el.parentNode) el.parentNode.removeChild(el);
      }, 400);
    }
  };

  // 4. Auto-dismiss after the page finishes loading.
  window.addEventListener('load', () => {
    setTimeout(window.hideAppLoader, 300);
  });

  // Safety fallback: never keep the screen locked for more than 3 seconds.
  setTimeout(window.hideAppLoader, 3000);
})();
