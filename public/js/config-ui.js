// Lightweight bindings for the CONFIG panel.
(function() {
  function bridge() {
    return window.JarvisConfigBridge || {};
  }

  function bindOnce(el, key, event, handler) {
    if (!el || el.dataset[key]) return;
    el.dataset[key] = '1';
    el.addEventListener(event, handler);
  }

  function init() {
    const apiInput = document.getElementById('config-api-key');
    const saveApiKeyBtn = document.getElementById('save-api-key');
    const ttsVoiceSelect = document.getElementById('config-tts-voice');
    const voiceCheckbox = document.getElementById('config-voice');
    const wakewordCheckbox = document.getElementById('config-wakeword');
    const conclaveCheckbox = document.getElementById('conclave-checkbox');
    const config = bridge();

    if (ttsVoiceSelect && typeof config.getTtsVoice === 'function') {
      ttsVoiceSelect.value = config.getTtsVoice();
    }
    if (voiceCheckbox && typeof config.getVoiceEnabled === 'function') {
      voiceCheckbox.checked = config.getVoiceEnabled();
    }
    if (wakewordCheckbox && typeof config.getWakeWordEnabled === 'function') {
      wakewordCheckbox.checked = config.getWakeWordEnabled();
    }
    if (conclaveCheckbox && typeof config.getConclaveEnabled === 'function') {
      conclaveCheckbox.checked = config.getConclaveEnabled();
      config.syncConclaveVisual?.();
    }

    bindOnce(saveApiKeyBtn, 'configUiBound', 'click', () => {
      config.saveApiKey?.(apiInput?.value || '');
    });

    bindOnce(ttsVoiceSelect, 'configUiBound', 'change', (event) => {
      config.setTtsVoice?.(event.target.value);
    });

    bindOnce(voiceCheckbox, 'configUiBound', 'change', (event) => {
      const enabled = config.setVoiceEnabled?.(event.target.checked);
      if (typeof enabled === 'boolean') event.target.checked = enabled;
    });

    bindOnce(wakewordCheckbox, 'configUiBound', 'change', (event) => {
      const enabled = config.setWakeWordEnabled?.(event.target.checked);
      if (typeof enabled === 'boolean') event.target.checked = enabled;
    });

    bindOnce(conclaveCheckbox, 'configUiBound', 'change', (event) => {
      const enabled = config.setConclaveEnabled?.(event.target.checked);
      if (typeof enabled === 'boolean') event.target.checked = enabled;
    });
  }

  window.JarvisConfigUI = { init };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
