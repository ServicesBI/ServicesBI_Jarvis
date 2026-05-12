// ========== VOICE TTS HELPERS ==========
(function() {
  const REALTIME_VOICES = new Set(['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar']);
  const REALTIME_VOICE_MAP = { onyx: 'ash', nova: 'shimmer', fable: 'sage' };

  function cleanTextForSpeech(text) {
    return String(text || '')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/\[.*?\]/g, '')
      .replace(/[#*_`~>|]/g, '')
      .replace(/\n+/g, ' ')
      .trim();
  }

  function getSpeechSentences(text, options = {}) {
    const minLength = options.minLength ?? 5;
    const maxSentences = options.maxSentences || 3;
    return cleanTextForSpeech(text)
      .split(/(?<=[.!?])\s+/)
      .filter(sentence => sentence.trim().length > minLength)
      .slice(0, maxSentences);
  }

  function prepareTtsText(text, options = {}) {
    const maxLength = options.maxLength || 500;
    return getSpeechSentences(text, options).join(' ').slice(0, maxLength);
  }

  function getRealtimeVoice(ttsVoice) {
    const voice = String(ttsVoice || '');
    if (REALTIME_VOICES.has(voice)) return voice;
    return REALTIME_VOICE_MAP[voice] || 'ash';
  }

  function getAvailableRealtimeVoices() {
    return Array.from(REALTIME_VOICES);
  }

  function canMovePlayback() {
    return {
      ok: false,
      reason: 'speakResponse/_ttsPlay ainda controlam playback real, cancelamento, fila, abort controller, audio atual e estado funcional de fala.',
      blockers: [
        'currentTtsAudio/_currentAudio',
        '_ttsQueue/_ttsPlaybackId/_currentTtsAbortController',
        'window.speechSynthesis cancelamento',
        'fetch /api/tts e Audio playback',
        'isJarvisSpeaking/lastVoiceCommandAt',
        'setAvatarState e estados visuais durante fala',
        'ttsVoice/currentLang como estado funcional de configuracao',
        'ACK/TTS vindo de processStreamLine e sendMessage'
      ],
      recommendation: 'Manter speakResponse/_ttsPlay em public/script.js ate isolar uma bridge de playback dedicada.'
    };
  }

  window.JarvisVoiceTTS = {
    cleanTextForSpeech,
    getSpeechSentences,
    prepareTtsText,
    getRealtimeVoice,
    getAvailableRealtimeVoices,
    canMovePlayback
  };
})();
