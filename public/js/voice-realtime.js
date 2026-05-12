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

  const realtimeLifecycleHandlers = {
    getState: null,
    startRealtime: null,
    stopRealtime: null,
    cleanupRealtime: null,
    setVoiceStatus: null,
    setAvatarState: null,
    resumeWakeWord: null
  };

  const dataChannelHandlers = {
    getState: null,
    onOpen: null,
    onMessage: null,
    onClose: null,
    onError: null,
    send: null,
    handleRealtimeTask: null,
    setVoiceStatus: null,
    setAvatarState: null,
    addTerminalLine: null
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

  function configureRealtimeLifecycleHandlers(handlers = {}) {
    if (!handlers || typeof handlers !== 'object') return getRealtimeLifecycleHandlers();
    Object.keys(realtimeLifecycleHandlers).forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(handlers, key)) {
        realtimeLifecycleHandlers[key] = handlers[key];
      }
    });
    return getRealtimeLifecycleHandlers();
  }

  function getRealtimeLifecycleHandlers() {
    return Object.fromEntries(
      Object.entries(realtimeLifecycleHandlers).map(([key, value]) => [key, typeof value])
    );
  }

  function getRealtimeLifecycleState() {
    if (typeof realtimeLifecycleHandlers.getState !== 'function') return null;
    try {
      return realtimeLifecycleHandlers.getState();
    } catch (err) {
      return { error: err.message || String(err) };
    }
  }

  function configureDataChannelHandlers(handlers = {}) {
    if (!handlers || typeof handlers !== 'object') return getDataChannelHandlers();
    Object.keys(dataChannelHandlers).forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(handlers, key)) {
        dataChannelHandlers[key] = handlers[key];
      }
    });
    return getDataChannelHandlers();
  }

  function getDataChannelHandlers() {
    return Object.fromEntries(
      Object.entries(dataChannelHandlers).map(([key, value]) => [key, typeof value])
    );
  }

  function getDataChannelState() {
    if (typeof dataChannelHandlers.getState !== 'function') return null;
    try {
      return dataChannelHandlers.getState();
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

  function normalizePeerConnectionState(state) {
    const normalized = String(state || '').toLowerCase();
    if (normalized === 'connected' || normalized === 'completed') return 'connected';
    if (normalized === 'connecting' || normalized === 'checking' || normalized === 'new') return 'connecting';
    if (normalized === 'disconnected' || normalized === 'failed' || normalized === 'closed') return 'disconnected';
    return normalized || 'unknown';
  }

  function normalizeDataChannelState(state) {
    const normalized = String(state || '').toLowerCase();
    if (normalized === 'open') return 'open';
    if (normalized === 'connecting') return 'connecting';
    if (normalized === 'closing' || normalized === 'closed') return 'closed';
    return normalized || 'unknown';
  }

  function shouldCleanupRealtimeState(state = {}) {
    return !!(
      state.realtimeActive ||
      state.isRealtimeActive ||
      state.realtimeConnecting ||
      state.hasPeerConnection ||
      state.hasStream ||
      state.hasAudio ||
      state.hasDataChannel
    );
  }

  function describeRealtimeCloseReason(event) {
    if (!event) return 'unknown';
    if (event.reason) return String(event.reason);
    if (event.message) return String(event.message);
    if (event.code) return `code:${event.code}`;
    if (event.type) return String(event.type);
    return 'unknown';
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

  function parseDataChannelMessage(data) {
    return parseRealtimeEvent(data);
  }

  function normalizeDataChannelEvent(data) {
    return parseDataChannelMessage(data);
  }

  function getRealtimeEventType(event) {
    return event?.type || '';
  }

  function getRealtimeFunctionCallName(event) {
    return event?.name || '';
  }

  function getRealtimeFunctionCallArgs(event) {
    return event?.arguments || '';
  }

  function classifyRealtimeEvent(event) {
    const type = getRealtimeEventType(event);
    if (!type) return 'invalid';
    if (type === 'input_audio_buffer.speech_started') return 'speech-started';
    if (type === 'input_audio_buffer.speech_stopped' || type === 'input_audio_buffer.committed') return 'speech-stopped';
    if (type.startsWith('response.audio.') && type !== 'response.audio.done') return 'audio-streaming';
    if (type === 'response.audio.done') return 'audio-done';
    if (type === 'conversation.item.input_audio_transcription.completed' && event?.transcript) return 'transcription-completed';
    if (type === 'response.audio_transcript.done' && event?.transcript) return 'audio-transcript-done';
    if (type === 'response.function_call_arguments.done' && getRealtimeFunctionCallName(event) === 'execute_task') return 'execute-task';
    return 'other';
  }

  function shouldHandleRealtimeEvent(event) {
    const classification = classifyRealtimeEvent(event);
    return classification !== 'invalid' && classification !== 'other';
  }

  function normalizeRealtimeTaskText(text) {
    return String(text || '');
  }

  function parseRealtimeTaskPayload(argsJson) {
    try {
      return {
        request: normalizeRealtimeTaskText(JSON.parse(argsJson).request)
      };
    } catch {
      return { request: '' };
    }
  }

  function buildRealtimeFunctionOutputEvent(callId, output) {
    return {
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify(output)
      }
    };
  }

  function buildRealtimeResponseCreateEvent() {
    return { type: 'response.create' };
  }

  function buildRealtimeErrorSummary(error, fallback = 'Realtime event failed') {
    return error?.message || error?.error || fallback;
  }

  function buildRealtimeAnnouncementEvent(message, language) {
    const INSTR = {
      BR: `Fale exatamente esta frase ao senhor, sem traduzir nem adicionar nada: "${message}"`,
      ES: `Di exactamente esta frase al seÃ±or, sin traducir ni aÃ±adir nada: "${message}"`,
      EN: `Say exactly this sentence to the user, do not translate or add anything: "${message}"`
    };
    const instruction = INSTR[language] || INSTR.EN;
    return {
      type: 'conversation.item.create',
      item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: instruction }] }
    };
  }

  function buildRealtimeChatRequestBody(message, language, conclaveEnabled) {
    return { message, fromVoice: true, language, conclaveEnabled };
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

  function getRealtimeLifecycleBlockers() {
    return [
      'startRealtime alterna estado e pode chamar stopRealtime',
      'realtimeConnecting/realtimeActive/isRealtimeActive sao flags funcionais mutaveis',
      'RTCPeerConnection e DataChannel sao criados e fechados no script.js',
      'getUserMedia abre microfone dentro de startRealtime',
      'pc.ontrack atualiza audio remoto e avatar',
      'DataChannel message listener chama avatar, status, traducao, fallback e handleRealtimeTask',
      'stopRealtime limpa tracks/audio/DC/PC e reativa wake word',
      'micBtn e botoes continuous/realtime sao atualizados no mesmo lifecycle',
      'announceToRealtime usa DataChannel e fallback TTS'
    ];
  }

  function getDataChannelHandlerBlockers() {
    return [
      'message handler atualiza setAvatarState/setVoiceStatus',
      'transcription.completed chama /api/translate e addTerminalLine',
      'fallback timer usa window._pendingTranscript/window._dispatchedThisTurn',
      'execute_task chama handleRealtimeTask',
      'audio.done altera isJarvisSpeaking e lastVoiceCommandAt',
      'handlers ainda dependem de flags funcionais do script.js'
    ];
  }

  function canMoveDataChannelHandlers() {
    return {
      ok: false,
      reason: 'Handlers do DataChannel ainda misturam parsing com estado visual, timers, traducao e dispatch para tarefas.',
      blockers: getDataChannelHandlerBlockers(),
      handlers: getDataChannelHandlers(),
      state: getDataChannelState()
    };
  }

  function canMoveRealtimeLifecycle() {
    return {
      ok: false,
      reason: 'Lifecycle Realtime ainda combina conexao WebRTC, microfone, DataChannel, UI, wake word e fallback TTS.',
      blockers: getRealtimeLifecycleBlockers(),
      handlers: getRealtimeLifecycleHandlers(),
      state: getRealtimeLifecycleState()
    };
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
    configureRealtimeLifecycleHandlers,
    getRealtimeLifecycleHandlers,
    getRealtimeLifecycleState,
    getRealtimeLifecycleBlockers,
    canMoveRealtimeLifecycle,
    configureDataChannelHandlers,
    getDataChannelHandlers,
    getDataChannelState,
    getDataChannelHandlerBlockers,
    canMoveDataChannelHandlers,
    getRealtimeCapabilities,
    getRealtimeBlockers,
    canMoveRealtime,
    isRealtimeReadyState,
    normalizeRealtimeStatus,
    isRealtimeConnected,
    isRealtimeDataChannelOpen,
    normalizePeerConnectionState,
    normalizeDataChannelState,
    shouldCleanupRealtimeState,
    describeRealtimeCloseReason,
    buildRealtimeSessionRequest,
    parseRealtimeSessionResponse,
    parseRealtimeEvent,
    parseDataChannelMessage,
    normalizeDataChannelEvent,
    getRealtimeEventType,
    getRealtimeFunctionCallName,
    getRealtimeFunctionCallArgs,
    classifyRealtimeEvent,
    shouldHandleRealtimeEvent,
    normalizeRealtimeTaskText,
    parseRealtimeTaskPayload,
    buildRealtimeFunctionOutputEvent,
    buildRealtimeResponseCreateEvent,
    buildRealtimeErrorSummary,
    buildRealtimeAnnouncementEvent,
    buildRealtimeChatRequestBody
  };
})();
