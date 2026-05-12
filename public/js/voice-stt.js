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

  function getAudioBlobSize(blob) {
    return blob?.size || 0;
  }

  function validateCapturedAudio({ duration = 0, blob = null, peakVolume = 0 } = {}) {
    if (duration < 800) {
      return {
        ok: false,
        reason: 'too-short',
        message: '[warn] Recording too short. Hold the mic button and speak, then click again to stop.'
      };
    }
    if (getAudioBlobSize(blob) < 1000) {
      return {
        ok: false,
        reason: 'empty-audio',
        message: '[warn] No audio captured. Check your microphone.'
      };
    }
    if (peakVolume < 5) {
      return {
        ok: false,
        reason: 'silence',
        message: '[warn] No voice detected — only silence captured. Speak louder or check mic.'
      };
    }
    return { ok: true };
  }

  function buildSttFormData(audioBlob, options = {}) {
    const formData = new FormData();
    formData.append(options.fieldName || 'audio', audioBlob, options.fileName || 'audio.webm');
    return formData;
  }

  function normalizeTranscriptText(text) {
    return String(text || '').trim();
  }

  function parseSttResponse(data) {
    const payload = data || {};
    const text = normalizeTranscriptText(payload.text);
    if (payload.filtered) {
      return {
        ok: false,
        filtered: true,
        text,
        message: `[warn] ${payload.reason || 'No clear speech detected.'}  Speak clearly and try again.`
      };
    }
    if (!text) {
      return {
        ok: false,
        filtered: false,
        text,
        message: '[warn] No speech detected. Try again.'
      };
    }
    return { ok: true, filtered: false, text };
  }

  function getSttErrorMessage(error, fallback = 'Transcription failed') {
    return error?.error || error?.message || fallback;
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
    getAudioBlobSize,
    validateCapturedAudio,
    buildSttFormData,
    normalizeTranscriptText,
    parseSttResponse,
    getSttErrorMessage,
    canMoveRecording,
    canMoveWakeWord
  };
})();
