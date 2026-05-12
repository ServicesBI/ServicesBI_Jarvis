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

  const recordingHandlers = {
    getState: null,
    startRecording: null,
    stopRecording: null,
    transcribeAndSend: null,
    sendVoiceMessage: null,
    setVoiceStatus: null,
    setAvatarState: null,
    addTerminalLine: null,
    playTone: null,
    playErrorSound: null
  };

  function configureRecordingHandlers(handlers = {}) {
    if (!handlers || typeof handlers !== 'object') return getRecordingHandlers();
    Object.keys(recordingHandlers).forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(handlers, key)) {
        recordingHandlers[key] = handlers[key];
      }
    });
    return getRecordingHandlers();
  }

  function getRecordingHandlers() {
    return Object.fromEntries(
      Object.entries(recordingHandlers).map(([key, value]) => [key, typeof value])
    );
  }

  function getRecordingState() {
    if (typeof recordingHandlers.getState !== 'function') return null;
    try {
      return recordingHandlers.getState();
    } catch (err) {
      return { error: err.message || String(err) };
    }
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
      ],
      handlers: getRecordingHandlers()
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
    configureRecordingHandlers,
    getRecordingHandlers,
    getRecordingState,
    canMoveRecording,
    canMoveWakeWord
  };
})();
