// ========== SCREEN CAPTURE (LIVE MODE) ==========
(function() {
  let capturedScreen = null;
  let screenStream = null;
  let liveScreenMode = false;
  let hiddenVideo = null;

  function getLang() {
    return localStorage.getItem('jarvis-lang') || 'BR';
  }

  function logTerminal(text, type = 'system-line') {
    if (typeof window.addTerminalLine === 'function') window.addTerminalLine(text, type);
  }

  function setAvatar(state) {
    if (typeof window.setAvatarState === 'function') window.setAvatarState(state);
  }

  function getScreenBtn() {
    return document.getElementById('screen-btn');
  }

  function hasCapture() {
    return !!(capturedScreen || liveScreenMode);
  }

  function stopScreenCapture() {
    capturedScreen = null;
    liveScreenMode = false;
    if (screenStream) {
      screenStream.getTracks().forEach(t => t.stop());
      screenStream = null;
    }
    if (hiddenVideo) {
      hiddenVideo.srcObject = null;
      hiddenVideo.remove();
      hiddenVideo = null;
    }
    document.getElementById('screen-preview-box')?.remove();
    getScreenBtn()?.classList.remove('active');
  }

  async function grabLatestFrame() {
    if (!hiddenVideo || hiddenVideo.readyState < 2) return capturedScreen;
    const canvas = document.createElement('canvas');
    canvas.width = hiddenVideo.videoWidth || 1920;
    canvas.height = hiddenVideo.videoHeight || 1080;
    canvas.getContext('2d').drawImage(hiddenVideo, 0, 0);
    capturedScreen = canvas.toDataURL('image/jpeg', 0.85);
    return capturedScreen;
  }

  async function captureScreen() {
    const currentLang = getLang();
    if (liveScreenMode || capturedScreen) {
      stopScreenCapture();
      logTerminal(
        currentLang === 'BR' ? '[system] Compartilhamento de tela desligado.' : '[system] Screen sharing stopped.',
        'system-line'
      );
      return;
    }

    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'monitor', width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 15 } },
        audio: false,
        preferCurrentTab: false,
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'exclude',
        monitorTypeSurfaces: 'include'
      });

      hiddenVideo = document.createElement('video');
      hiddenVideo.autoplay = true;
      hiddenVideo.muted = true;
      hiddenVideo.playsInline = true;
      hiddenVideo.style.position = 'fixed';
      hiddenVideo.style.left = '-9999px';
      hiddenVideo.srcObject = screenStream;
      document.body.appendChild(hiddenVideo);
      await new Promise((resolve) => {
        hiddenVideo.onloadedmetadata = () => { hiddenVideo.play().then(resolve).catch(resolve); };
      });

      screenStream.getVideoTracks()[0].addEventListener('ended', () => {
        stopScreenCapture();
        logTerminal(
          currentLang === 'BR' ? '[system] Compartilhamento encerrado pelo navegador.' : '[system] Sharing ended by browser.',
          'system-line'
        );
      });

      liveScreenMode = true;
      await grabLatestFrame();
      showScreenPreview(capturedScreen);
      getScreenBtn()?.classList.add('active');

      logTerminal(
        currentLang === 'BR'
          ? '[system] 🔴 LIVE — tela compartilhada. JARVIS vê em tempo real. Fale ou digite suas perguntas.'
          : '[system] 🔴 LIVE — screen shared. JARVIS sees in real-time. Speak or type your questions.',
        'system-line'
      );
    } catch (err) {
      if (err.name !== 'NotAllowedError') {
        logTerminal(`[error] Screen capture failed: ${err.message}`, 'error-line');
      }
      stopScreenCapture();
    }
  }

  function showScreenPreview(dataUrl) {
    document.getElementById('screen-preview-box')?.remove();

    const preview = document.createElement('div');
    preview.id = 'screen-preview-box';
    preview.className = 'screen-preview live';
    preview.innerHTML = `
      <img src="${dataUrl}" alt="Live screen">
      <span class="screen-label">LIVE</span>
      <button class="remove-screen" title="Stop sharing">✕</button>
    `;
    preview.querySelector('.remove-screen').onclick = stopScreenCapture;
    preview.style.cssText = 'position:fixed; bottom:200px; right:16px; width:360px; z-index:51;';
    document.body.appendChild(preview);
  }

  function updatePreviewImage(dataUrl) {
    const img = document.querySelector('#screen-preview-box img');
    if (img) img.src = dataUrl;
  }

  async function analyzeScreen(userMessage) {
    const currentLang = getLang();
    if (liveScreenMode) {
      await grabLatestFrame();
      updatePreviewImage(capturedScreen);
    }
    if (!capturedScreen) return null;

    const screen = capturedScreen;
    setAvatar('thinking');

    try {
      const res = await fetch('/api/analyze-screen-fast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: screen, message: userMessage, language: currentLang, saveHistory: true })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.response) return data.response;
      }

      const res2 = await fetch('/api/analyze-screen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: screen, message: userMessage, language: currentLang, saveHistory: true })
      });
      const data2 = await res2.json();
      return data2.response || null;
    } catch (err) {
      logTerminal(`[error] Screen analysis failed: ${err.message}`, 'error-line');
      return null;
    }
  }

  function initScreenCapture() {
    const screenBtn = getScreenBtn();
    if (!screenBtn || screenBtn.dataset.screenCaptureBound) return;
    screenBtn.dataset.screenCaptureBound = '1';
    screenBtn.addEventListener('click', captureScreen);
  }

  window.JarvisScreenCapture = {
    hasCapture,
    capture: captureScreen,
    stop: stopScreenCapture,
    analyze: analyzeScreen
  };
  window.removeScreenPreview = stopScreenCapture;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initScreenCapture, { once: true });
  } else {
    initScreenCapture();
  }
})();
