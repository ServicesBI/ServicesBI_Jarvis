// ========== VOICE REALTIME HELPERS ==========
(function() {
  const realtimeHandlers = {
    getState: null,
    startRealtime: null,
    stopRealtime: null,
    routeVoiceCommand: null,
    handleRealtimeTask: null,
    announceToRealtime: null,
    addTerminalLine: null,
    setVoiceStatus: null,
    setAvatarState: null
  };

  function configureRealtimeHandlers(handlers = {}) {
    if (!handlers || typeof handlers !== 'object') return getRealtimeHandlers();
    Object.keys(realtimeHandlers).forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(handlers, key)) {
        realtimeHandlers[key] = handlers[key];
      }
    });
    return getRealtimeHandlers();
  }

  function getRealtimeHandlers() {
    return Object.fromEntries(
      Object.entries(realtimeHandlers).map(([key, value]) => [key, typeof value])
    );
  }

  function getRealtimeState() {
    if (typeof realtimeHandlers.getState !== 'function') return null;
    try {
      return realtimeHandlers.getState();
    } catch (err) {
      return { error: err.message || String(err) };
    }
  }

  function isRealtimeReadyState(state) {
    return state === 'open' || state === 'connecting';
  }

  function normalizeRealtimeStatus(status) {
    const normalized = String(status || '').toLowerCase();
    if (normalized === 'open' || normalized === 'connected' || normalized === 'active') return 'connected';
    if (normalized === 'connecting' || normalized === 'pending') return 'connecting';
    if (normalized === 'closing' || normalized === 'closed' || normalized === 'disconnected') return 'disconnected';
    return normalized || 'unknown';
  }

  function isRealtimeConnected(state) {
    return normalizeRealtimeStatus(state) === 'connected';
  }

  function isRealtimeDataChannelOpen(channel) {
    return channel?.readyState === 'open';
  }

  function buildRealtimeSessionRequest(language, voice) {
    return { language, voice };
  }

  function parseRealtimeSessionResponse(data) {
    const payload = data || {};
    return {
      ok: !!payload.client_secret?.value,
      clientSecret: payload.client_secret?.value || '',
      error: payload.error || ''
    };
  }

  function parseRealtimeEvent(raw) {
    if (typeof raw !== 'string') return raw || null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function getRealtimeCapabilities() {
    return {
      rtcPeerConnection: typeof window.RTCPeerConnection === 'function',
      mediaDevices: !!navigator.mediaDevices?.getUserMedia,
      audio: typeof window.Audio === 'function',
      handlers: getRealtimeHandlers()
    };
  }

  function getRealtimeBlockers() {
    return [
      'RTCPeerConnection lifecycle',
      'DataChannel lifecycle and readyState',
      'navigator.mediaDevices.getUserMedia',
      'fetch /api/realtime/session',
      'OpenAI Realtime SDP exchange',
      'realtimePC/realtimeStream/realtimeAudio/realtimeDC',
      'realtimeActive/realtimeConnecting/isRealtimeActive',
      'wake word handoff and resume',
      'sendMessage/routeVoiceCommand/handleRealtimeTask side effects',
      'TTS fallback in announceToRealtime'
    ];
  }

  function canMoveRealtime() {
    return {
      ok: false,
      reason: 'Realtime ainda controla WebRTC, DataChannel, microfone, endpoint de sessao e integracoes de voz/chat.',
      blockers: getRealtimeBlockers(),
      capabilities: getRealtimeCapabilities()
    };
  }

  window.JarvisVoiceRealtime = {
    configureRealtimeHandlers,
    getRealtimeHandlers,
    getRealtimeState,
    getRealtimeCapabilities,
    getRealtimeBlockers,
    canMoveRealtime,
    isRealtimeReadyState,
    normalizeRealtimeStatus,
    isRealtimeConnected,
    isRealtimeDataChannelOpen,
    buildRealtimeSessionRequest,
    parseRealtimeSessionResponse,
    parseRealtimeEvent
  };
})();
