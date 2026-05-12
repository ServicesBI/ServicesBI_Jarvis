// ========== VOICE STT / WAKE WORD HELPERS ==========
(function() {
  const WAKE_WORD_DISABLED_KEY = 'jarvis-wakeword-disabled';
  const WAKE_WORD_MATCHES = ['jarvis', 'járvis', 'jarves'];

  function getSpeechRecognitionCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function canUseWebSpeech() {
    return !!getSpeechRecognitionCtor();
  }

  function normalizeVoiceCommandText(text) {
    return String(text || '').toLowerCase().trim();
  }

  function isWakeWordMatch(text) {
    const normalized = normalizeVoiceCommandText(text);
    return WAKE_WORD_MATCHES.some(match => normalized.includes(match));
  }

  function readWakeWordDisabledFromStorage() {
    try {
      return localStorage.getItem(WAKE_WORD_DISABLED_KEY) === 'true';
    } catch {
      return false;
    }
  }

  function writeWakeWordDisabledToStorage(disabled) {
    try {
      localStorage.setItem(WAKE_WORD_DISABLED_KEY, disabled ? 'true' : 'false');
    } catch {}
    return !!disabled;
  }

  function canUseMediaRecorder() {
    return typeof window.MediaRecorder === 'function';
  }

  function getSupportedAudioMimeType() {
    if (!canUseMediaRecorder() || typeof MediaRecorder.isTypeSupported !== 'function') return '';
    return MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
  }

  function getCapabilities() {
    return {
      webSpeech: canUseWebSpeech(),
      mediaRecorder: canUseMediaRecorder(),
      supportedAudioMimeType: getSupportedAudioMimeType(),
      wakeWordDisabled: readWakeWordDisabledFromStorage()
    };
  }

  function canMoveRecording() {
    return {
      ok: false,
      reason: 'startRecording/stopRecording ainda controlam microfone, Web Speech, MediaRecorder, VAD, timers, UI e envio para sendMessage(text, true).',
      blockers: [
        'navigator.mediaDevices.getUserMedia',
        'SpeechRecognition instance lifecycle',
        'MediaRecorder/audioChunks/audioAnalyser/peakVolume/vadTimer',
        'isRecording/continuousMode/continuousTimer',
        'sendMessage(text, true)',
        'setAvatarState/playTone/addTerminalLine'
      ]
    };
  }

  function canMoveWakeWord() {
    return {
      ok: false,
      reason: 'startWakeWord/stopWakeWord ainda controlam uma instancia ativa de SpeechRecognition e acionam Realtime/cowork.',
      blockers: [
        'wakeWordRecognition lifecycle',
        'wakeWordEnabled',
        'startRealtime',
        'fetch /api/cowork/start',
        'addTerminalLine',
        'auto-restart no onend'
      ]
    };
  }

  window.JarvisVoiceSTT = {
    getSpeechRecognitionCtor,
    canUseWebSpeech,
    normalizeVoiceCommandText,
    isWakeWordMatch,
    readWakeWordDisabledFromStorage,
    writeWakeWordDisabledToStorage,
    canUseMediaRecorder,
    getSupportedAudioMimeType,
    getCapabilities,
    canMoveRecording,
    canMoveWakeWord
  };
})();
