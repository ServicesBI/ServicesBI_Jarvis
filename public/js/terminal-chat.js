(function() {
  function getTerminalOutput() {
    return document.getElementById('terminal-output');
  }

  function getTerminalShell() {
    return document.getElementById('terminal');
  }

  function getChatInput() {
    return document.getElementById('chat-input');
  }

  function getSendButton() {
    return document.getElementById('send-btn');
  }

  function addTerminalLine(text, type = '') {
    const terminal = getTerminalOutput();
    if (!terminal) return;

    const line = document.createElement('div');
    line.className = `terminal-line ${type}`;
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = `[${window.getTimestamp()}]`;
    const msg = document.createElement('span');
    msg.className = 'msg';

    if (type === '' || type === 'jarvis-line') {
      msg.innerHTML = window.renderMarkdown(text);
      window.addCopyButtons(msg);
    } else {
      msg.textContent = text;
    }

    line.appendChild(ts);
    line.appendChild(document.createTextNode(' '));
    line.appendChild(msg);
    terminal.appendChild(line);
    terminal.scrollTop = terminal.scrollHeight;
  }

  function addDownloadCard(fileName, filePath) {
    const terminal = getTerminalOutput();
    if (!terminal) return;

    const card = document.createElement('div');
    card.className = 'download-card';
    card.innerHTML = `
      <span class="file-icon">&#128196;</span>
      <span class="file-name">${fileName}</span>
      <a class="dl-btn" href="/api/files/download?path=${encodeURIComponent(filePath)}" download>Download</a>
    `;
    terminal.appendChild(card);
    terminal.scrollTop = terminal.scrollHeight;
  }

  function getLocalDateTimeAnswer(text) {
    const normalized = String(text || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    const asksDay = /\b(que dia|dia e hoje|data de hoje|qual a data)\b/.test(normalized);
    const asksTime = /\b(que horas|quantas horas|hora e|horario|agora sao)\b/.test(normalized);
    if (!asksDay && !asksTime) return '';

    const now = new Date();
    const dayNames = ['domingo', 'segunda-feira', 'ter\u00E7a-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 's\u00E1bado'];
    const d = String(now.getDate()).padStart(2, '0');
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const y = now.getFullYear();
    const h = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const dayName = dayNames[now.getDay()];

    if (asksDay && asksTime) return `Hoje \u00E9 ${dayName}, ${d}/${m}/${y}, e agora s\u00E3o ${h}:${min}.`;
    if (asksDay) return `Hoje \u00E9 ${dayName}, ${d}/${m}/${y}.`;
    return `Agora s\u00E3o ${h}:${min}.`;
  }

  function isBuildTaskRequest(text) {
    return /\b(create|generate|build|make|write|produce|design|implement|develop|fix|update|report|crie|gere|construa|fa\u00E7a|escreva|implemente|corrija|analise|relat\u00F3rio)\b/i.test(text);
  }

  function classifyModelRequest(text) {
    const opusMatch = /\b(architect|redesign|refactor|infrastructure|migration|deploy|scale|database|system design|e-?book|full|complete|advanced|complex|detailed|comprehensive|deep|entire|production|enterprise)\b/i.test(text);
    const sonnetMatch = /\b(create|generate|build|make|write|produce|design|implement|develop|fix|update|modify|analyze|report|presentation|website|app|pdf|document|code|script|html|css|crie|gere|construa|fa\u00E7a|escreva)\b/i.test(text);
    return {
      opusMatch,
      sonnetMatch,
      model: opusMatch ? 'opus' : sonnetMatch ? 'sonnet' : 'haiku'
    };
  }

  function buildChatRequestBody({ text, fromVoice, language, conclaveEnabled, attachment }) {
    const body = { message: text, fromVoice, language, conclaveEnabled };
    if (attachment) body.attachmentId = attachment.id;
    return body;
  }

  function prepareSpeechBrief(text, options = {}) {
    const sentenceLimit = options.sentenceLimit || 2;
    const maxLength = options.maxLength || 300;
    const minSentenceLength = options.minSentenceLength || 0;
    return String(text || '')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/[#*_`~>|]/g, '')
      .replace(/\n+/g, ' ')
      .trim()
      .split(/(?<=[.!?])\s+/)
      .filter(sentence => sentence.trim().length > minSentenceLength)
      .slice(0, sentenceLimit)
      .join(' ')
      .slice(0, maxLength);
  }

  function resolveSendMessage(sendMessage) {
    return typeof sendMessage === 'function' ? sendMessage : window.sendMessage;
  }

  function bindSendHandlers(sendMessage) {
    const terminal = getTerminalShell();
    const chatInput = getChatInput();
    const sendBtn = getSendButton();
    const send = resolveSendMessage(sendMessage);

    if (sendBtn && !sendBtn.dataset.terminalChatSendBound) {
      sendBtn.dataset.terminalChatSendBound = '1';
      sendBtn.addEventListener('click', () => {
        const activeSend = resolveSendMessage(send);
        if (typeof activeSend === 'function') activeSend(chatInput ? chatInput.value : '');
      });
    }

    if (chatInput && !chatInput.dataset.terminalChatEnterBound) {
      chatInput.dataset.terminalChatEnterBound = '1';
      chatInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          const activeSend = resolveSendMessage(send);
          if (typeof activeSend === 'function') activeSend(chatInput.value);
        }
      });
    }

    if (terminal && chatInput && !terminal.dataset.terminalChatFocusBound) {
      terminal.dataset.terminalChatFocusBound = '1';
      terminal.addEventListener('click', () => chatInput.focus());
    }
  }

  function getChatElements() {
    return {
      terminal: getTerminalShell(),
      terminalOutput: getTerminalOutput(),
      chatInput: getChatInput(),
      sendBtn: getSendButton(),
      fileAttach: document.getElementById('file-attach'),
      screenBtn: document.getElementById('screen-btn'),
      micBtn: document.getElementById('mic-btn')
    };
  }

  function getDependencies() {
    return {
      globals: {
        sendMessage: typeof window.sendMessage,
        processStreamLine: typeof window.processStreamLine,
        addTerminalLine: typeof window.addTerminalLine,
        addDownloadCard: typeof window.addDownloadCard,
        getLocalDateTimeAnswer: typeof window.getLocalDateTimeAnswer,
        isBuildTaskRequest: typeof window.JarvisTerminalChat?.isBuildTaskRequest,
        classifyModelRequest: typeof window.JarvisTerminalChat?.classifyModelRequest,
        buildChatRequestBody: typeof window.JarvisTerminalChat?.buildChatRequestBody,
        prepareSpeechBrief: typeof window.JarvisTerminalChat?.prepareSpeechBrief,
        JarvisAttachments: typeof window.JarvisAttachments,
        JarvisScreenCapture: typeof window.JarvisScreenCapture,
        renderMarkdown: typeof window.renderMarkdown,
        addCopyButtons: typeof window.addCopyButtons,
        getTimestamp: typeof window.getTimestamp,
        setVoiceStatus: typeof window.setVoiceStatus
      },
      dom: Object.fromEntries(
        Object.entries(getChatElements()).map(([key, value]) => [key, !!value])
      )
    };
  }

  function canMoveSendMessage() {
    return {
      ok: false,
      reason: 'sendMessage ainda depende de voz/realtime/STT/TTS, avatar/modelos/agentes/sons, anexos, TELA, processStreamLine e streaming de /api/chat.',
      blockers: [
        'voiceEnabled/userGestureReceived/isRealtimeActive/realtimeActive/isJarvisSpeaking/isVoiceRequestInFlight/lastVoiceCommandAt',
        'speakResponse/scheduleNextListen/routeVoiceCommand',
        'setAvatarState/setActiveModel/highlightAgents/playSendSound/playReceiveSound/playErrorSound',
        'window.JarvisAttachments',
        'window.JarvisScreenCapture',
        'processStreamLine',
        'fetch /api/chat com streaming e buffer final sem newline'
      ]
    };
  }

  window.addTerminalLine = addTerminalLine;
  window.addDownloadCard = addDownloadCard;
  window.getLocalDateTimeAnswer = getLocalDateTimeAnswer;
  window.JarvisTerminalChat = {
    addTerminalLine,
    addDownloadCard,
    getLocalDateTimeAnswer,
    isBuildTaskRequest,
    classifyModelRequest,
    buildChatRequestBody,
    prepareSpeechBrief,
    bindSendHandlers,
    getChatElements,
    getDependencies,
    canMoveSendMessage
  };
})();
