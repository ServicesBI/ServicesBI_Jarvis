// ========== VOICE UI STATUS ==========
(function() {
  const VOICE_STATUS_STATES = ['mute', 'ready', 'listening', 'thinking', 'speaking'];
  const VOICE_STATUS_LABELS = {
    mute: 'MUTE',
    ready: 'MUTE',
    listening: 'LISTENING',
    thinking: 'THINKING',
    speaking: 'SPEAKING'
  };
  const VOICE_STATUS_CARD_LABELS = {
    mute: 'MUTE',
    ready: 'MUTE',
    listening: 'LISTEN',
    thinking: 'THINK',
    speaking: 'SPEAK'
  };

  let getRestStatus = () => 'mute';

  function configure(options = {}) {
    if (typeof options.getRestStatus === 'function') {
      getRestStatus = options.getRestStatus;
    }
    return getState();
  }

  function getVoiceRestStatus() {
    return getRestStatus();
  }

  function getElements() {
    const sideVoice = document.getElementById('side-voice-status');
    return {
      micBtn: document.getElementById('mic-btn'),
      micDot: document.getElementById('jarvis-mic-dot'),
      centerVoice: document.getElementById('jarvis-core-voice-status'),
      bottomVoice: document.getElementById('jarvis-bottom-voice-status'),
      voiceCard: document.querySelector('.voice-card'),
      sideVoice,
      sideCard: sideVoice?.closest('.side-mini-card')
    };
  }

  function normalizeStatus(state) {
    const status = state === 'idle' || state === 'auto' ? getVoiceRestStatus() : state;
    return status === 'ready'
      ? 'mute'
      : (VOICE_STATUS_STATES.includes(status) ? status : getVoiceRestStatus());
  }

  function setVoiceStatus(state = 'ready') {
    const normalized = normalizeStatus(state);
    const cardLabel = VOICE_STATUS_CARD_LABELS[normalized];
    const centerLabel = VOICE_STATUS_LABELS[normalized];
    const classes = VOICE_STATUS_STATES.map(s => `voice-status-${s}`);
    const { micBtn, micDot, centerVoice, bottomVoice, voiceCard, sideVoice, sideCard } = getElements();

    [micBtn, micDot, centerVoice, bottomVoice, voiceCard, sideCard].forEach(el => {
      if (!el) return;
      el.classList.remove(...classes, 'speaking');
      el.classList.add(`voice-status-${normalized}`);
    });
    if (voiceCard && normalized === 'speaking') voiceCard.classList.add('speaking');
    if (sideCard) {
      normalized === 'listening' ? sideCard.classList.add('voz-mic-active') : sideCard.classList.remove('voz-mic-active');
    }
    if (sideVoice) sideVoice.textContent = cardLabel;
    if (centerVoice) centerVoice.textContent = centerLabel;
    if (bottomVoice) bottomVoice.textContent = centerLabel;
    if (micBtn) {
      micBtn.setAttribute('aria-label', `Voz: ${centerLabel}`);
      micBtn.title = centerLabel;
    }
  }

  function setJarvisSpeaking(speaking) {
    setVoiceStatus(speaking ? 'speaking' : 'auto');
  }

  function getState() {
    return {
      restStatus: getVoiceRestStatus(),
      states: VOICE_STATUS_STATES.slice(),
      labels: { ...VOICE_STATUS_LABELS },
      cardLabels: { ...VOICE_STATUS_CARD_LABELS },
      elements: Object.fromEntries(
        Object.entries(getElements()).map(([key, value]) => [key, !!value])
      )
    };
  }

  window.setVoiceStatus = setVoiceStatus;
  window.setJarvisSpeaking = setJarvisSpeaking;
  window.JarvisVoiceUI = {
    configure,
    getVoiceRestStatus,
    setVoiceStatus,
    setJarvisSpeaking,
    getElements,
    getState
  };
})();
