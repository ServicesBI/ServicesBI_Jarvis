// ========== JARVIS COCKPIT - CLIENT LOGIC ==========

// DOM Elements
const terminal = document.getElementById('terminal-output');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const micBtn = document.getElementById('mic-btn');
const avatarContainer = document.querySelector('.avatar-container');
const avatarStatus = document.getElementById('avatar-status');
const fileAttach = document.getElementById('file-attach');

// State
let isRecording = false;
let mediaRecorder = null;
let audioChunks = [];
let currentAttachment = null;
let voiceEnabled = true;
let ttsVoice = localStorage.getItem('ttsVoice') || 'ash';
let isRealtimeActive = false;
let isJarvisSpeaking = false;
let isVoiceRequestInFlight = false;
let currentTtsAudio = null;
let lastVoiceCommandAt = 0;
const VOICE_COMMAND_COOLDOWN_MS = 1000;

// Realtime API supports a different voice set than TTS.
// Map TTS voice to nearest valid Realtime voice.
const REALTIME_VOICES = new Set(['alloy','ash','ballad','coral','echo','sage','shimmer','verse','marin','cedar']);
const REALTIME_VOICE_MAP = { onyx: 'ash', nova: 'shimmer', fable: 'sage' };
function getRealtimeVoice() {
  if (REALTIME_VOICES.has(ttsVoice)) return ttsVoice;
  return REALTIME_VOICE_MAP[ttsVoice] || 'ash';
}

let wakeWordEnabled = false;
let wakeWordRecognition = null;
let ttsQueue = [];
let ttsPlaying = false;
let userGestureReceived = false;
let webSpeechRec = null;
const canWebSpeech = 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;
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

function getVoiceRestStatus() {
  if (!voiceEnabled) return 'mute';
  if (isRecording || isRealtimeActive || realtimeActive) return 'listening';
  return 'mute';
}

function setVoiceStatus(state = 'ready') {
  const status = state === 'idle' || state === 'auto' ? getVoiceRestStatus() : state;
  const normalized = status === 'ready' ? 'mute' : (VOICE_STATUS_STATES.includes(status) ? status : getVoiceRestStatus());
  const cardLabel = VOICE_STATUS_CARD_LABELS[normalized];
  const centerLabel = VOICE_STATUS_LABELS[normalized];
  const classes = VOICE_STATUS_STATES.map(s => `voice-status-${s}`);
  const sideVoice = document.getElementById('side-voice-status');
  const centerVoice = document.getElementById('jarvis-core-voice-status');
  const bottomVoice = document.getElementById('jarvis-bottom-voice-status');
  const micDot = document.getElementById('jarvis-mic-dot');
  const voiceCard = document.querySelector('.voice-card');
  const sideCard = sideVoice?.closest('.side-mini-card');

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

window.setVoiceStatus = setVoiceStatus;
window.setJarvisSpeaking = function(speaking) {
  setVoiceStatus(speaking ? 'speaking' : 'auto');
};

// ========== SCREEN CAPTURE (LIVE MODE) ==========
let capturedScreen = null;
let screenStream = null;
let liveScreenMode = false;
let hiddenVideo = null;

const screenBtn = document.getElementById('screen-btn');

function stopScreenCapture() {
  capturedScreen = null;
  liveScreenMode = false;
  if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
  if (hiddenVideo) { hiddenVideo.srcObject = null; hiddenVideo.remove(); hiddenVideo = null; }
  document.getElementById('screen-preview-box')?.remove();
  screenBtn.classList.remove('active');
}

// Legacy alias (existing X button callback expects this name)
const removeScreenPreview = stopScreenCapture;

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
  if (liveScreenMode || capturedScreen) {
    stopScreenCapture();
    addTerminalLine(
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
    hiddenVideo.style.top = '-9999px';
    hiddenVideo.style.width = '1px';
    hiddenVideo.style.height = '1px';
    document.body.appendChild(hiddenVideo);
    hiddenVideo.srcObject = screenStream;
    await new Promise(r => { hiddenVideo.onloadedmetadata = r; });

    liveScreenMode = true;
    screenBtn.classList.add('active');

    // Grab initial frame for preview
    await grabLatestFrame();

    // Show thumbnail preview
    const previewBox = document.createElement('div');
    previewBox.id = 'screen-preview-box';
    previewBox.style.cssText = 'position:fixed;bottom:80px;right:16px;z-index:9999;background:#000;border:1px solid var(--cyan);border-radius:8px;overflow:hidden;width:200px;';
    const img = document.createElement('img');
    img.src = capturedScreen;
    img.style.cssText = 'width:100%;display:block;';
    const closeX = document.createElement('button');
    closeX.textContent = '✕';
    closeX.style.cssText = 'position:absolute;top:4px;right:4px;background:rgba(0,0,0,0.7);color:#fff;border:none;border-radius:50%;width:20px;height:20px;cursor:pointer;font-size:12px;line-height:20px;text-align:center;';
    closeX.onclick = removeScreenPreview;
    previewBox.appendChild(img);
    previewBox.appendChild(closeX);
    document.body.appendChild(previewBox);

    addTerminalLine(
      currentLang === 'BR' ? '[system] Tela capturada. Faça sua pergunta.' : '[system] Screen captured. Ask your question.',
      'system-line'
    );

    // Stop if user ends the share natively
    screenStream.getVideoTracks()[0].onended = stopScreenCapture;
  } catch (err) {
    addTerminalLine(`[error] Screen capture failed: ${err.message}`, 'error-line');
  }
}

function updatePreviewImage(dataUrl) {
  const img = document.querySelector('#screen-preview-box img');
  if (img) img.src = dataUrl;
}

async function analyzeScreen(userMessage) {
  if (liveScreenMode) {
    await grabLatestFrame();
    updatePreviewImage(capturedScreen);
  }
  if (!capturedScreen) return null;

  const screen = capturedScreen;
  setAvatarState('thinking');

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
    addTerminalLine(`[error] Screen analysis failed: ${err.message}`, 'error-line');
    return null;
  }
}

screenBtn?.addEventListener('click', captureScreen);

// ========== STATE: CONCLAVE & LANGUAGE ==========
let conclaveEnabled = localStorage.getItem('jarvis-conclave') !== 'false';
let currentLang = localStorage.getItem('jarvis-lang') || 'BR';

// ========== AUDIO CONTEXT (SOUND FEEDBACK) ==========
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function playTone(freq, duration = 80, vol = 0.1) {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.value = vol;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration / 1000);
    osc.stop(ctx.currentTime + duration / 1000);
  } catch {}
}

function playSendSound() { playTone(880, 60); setTimeout(() => playTone(1100, 60), 70); }
function playReceiveSound() { playTone(660, 80); }
function playErrorSound() { playTone(440, 100); setTimeout(() => playTone(330, 150), 120); }

// ========== TERMINAL RENDERING ==========
function getTimestamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function addTerminalLine(text, type = '') {
  const line = document.createElement('div');
  line.className = `terminal-line ${type}`;
  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = `[${getTimestamp()}]`;
  const msg = document.createElement('span');
  msg.className = 'msg';

  if (type === '' || type === 'jarvis-line') {
    msg.innerHTML = renderMarkdown(text);
    addCopyButtons(msg);
  } else {
    msg.textContent = text;
  }

  line.appendChild(ts);
  line.appendChild(document.createTextNode(' '));
  line.appendChild(msg);
  terminal.appendChild(line);
  terminal.scrollTop = terminal.scrollHeight;
}

let pendingAckTTS = null;

// ========== MODEL CARD HIGHLIGHTING ==========
function setActiveModel(model) {
  document.querySelectorAll('.model-card').forEach(c => c.classList.remove('active-model'));
  const id = model === 'opus' ? 'model-opus' : model === 'sonnet' ? 'model-sonnet' : 'model-haiku';
  document.getElementById(id)?.classList.add('active-model');
}

// ========== AGENT CHIP HIGHLIGHTING ==========
function highlightAgents(text) {
  document.querySelectorAll('.agent-chip').forEach(c => c.classList.remove('active-agent'));
  const agentMap = {
    'dev': 'dev', 'architect': 'architect', 'qa': 'qa', 'pm': 'pm',
    'po': 'po', 'devops': 'devops', 'analyst': 'analyst', 'ux': 'ux',
    'sm': 'sm', 'data-eng': 'data-eng', 'data-engineer': 'data-eng',
    'aios-master': 'aios-master', 'orion': 'aios-master',
    'conclave': 'conclave', 'crítico': 'conclave', 'advogado': 'conclave', 'sintetizador': 'conclave',
  };
  const lower = text.toLowerCase();
  for (const [keyword, dataAgent] of Object.entries(agentMap)) {
    if (lower.includes(`@${keyword}`) || lower.includes(keyword)) {
      document.querySelector(`.agent-chip[data-agent="${dataAgent}"]`)?.classList.add('active-agent');
    }
  }
}

function setModelFromAgent(agentEl) {
  if (!agentEl) return;
  document.querySelectorAll('.model-card').forEach(c => c.classList.remove('active-model'));
  if (agentEl.classList.contains('model-opus'))   document.getElementById('model-opus')?.classList.add('active-model');
  if (agentEl.classList.contains('model-sonnet')) document.getElementById('model-sonnet')?.classList.add('active-model');
  if (agentEl.classList.contains('model-haiku'))  document.getElementById('model-haiku')?.classList.add('active-model');
}

function processStreamLine(line) {
  if (!line.trim()) return;

  if (line.startsWith('[translated]')) {
    const translated = line.slice(12).trim();
    const userLines = terminal.querySelectorAll('.user-line');
    if (userLines.length > 0) {
      const last = userLines[userLines.length - 1];
      last.querySelector('.msg').textContent = `> ${translated}`;
    }
    return true;
  } else if (line.startsWith('[ack]')) {
    const ackText = line.slice(5).trim();
    addTerminalLine(ackText, 'info-line');
    if (voiceEnabled && userGestureReceived && !(realtimeActive || isRealtimeActive)) {
      pendingAckTTS = speakResponse(ackText);
    }
    return true;
  } else if (line.startsWith('[system]')) {
    addTerminalLine(line, 'system-line');
  } else if (line.startsWith('[file]')) {
    addTerminalLine(line, 'file-line');
    const match = line.match(/\[file\]\s*(.+?)\s*\|\s*(.+)/);
    if (match) addDownloadCard(match[1].trim(), match[2].trim());
  } else if (line.startsWith('[error]')) {
    addTerminalLine(line, 'error-line');
  } else if (line.startsWith('[warn]')) {
    addTerminalLine(line, 'warn-line');
  } else if (line.startsWith('[info]')) {
    addTerminalLine(line, 'info-line');
  } else {
    return false;
  }
  return true;
}

function addDownloadCard(fileName, filePath) {
  const card = document.createElement('div');
  card.className = 'download-card';
  card.innerHTML = `
    <span class="file-icon">📄</span>
    <span class="file-name">${fileName}</span>
    <a class="dl-btn" href="/api/files/download?path=${encodeURIComponent(filePath)}" download>Download</a>
  `;
  terminal.appendChild(card);
  terminal.scrollTop = terminal.scrollHeight;
}

// ========== MARKDOWN RENDERING ==========
function renderMarkdown(text) {
  try {
    if (typeof marked !== 'undefined') {
      marked.setOptions({
        highlight: function(code, lang) {
          if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
            return hljs.highlight(code, { language: lang }).value;
          }
          return code;
        },
        breaks: true,
        gfm: true
      });
      return marked.parse(text);
    }
    return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  } catch {
    return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

function addCopyButtons(container) {
  container.querySelectorAll('pre').forEach(pre => {
    pre.style.position = 'relative';
    const btn = document.createElement('button');
    btn.className = 'code-copy-btn';
    btn.textContent = 'Copy';
    btn.onclick = () => {
      const code = pre.querySelector('code')?.textContent || pre.textContent;
      navigator.clipboard.writeText(code);
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 1500);
    };
    pre.appendChild(btn);
  });
}

// ========== CHAT - SEND MESSAGE ==========
async function sendMessage(text, fromVoice = false) {
  if (!text.trim() && !capturedScreen) return;

  if (fromVoice) {
    if (isRealtimeActive || realtimeActive) {
      console.log('[VOICE] Fluxo legado bloqueado porque Realtime está ativo');
      return;
    }
    if (isJarvisSpeaking || Date.now() - lastVoiceCommandAt < VOICE_COMMAND_COOLDOWN_MS) {
      console.log('[VOICE] Ignorado: Jarvis estava falando');
      return;
    }
    if (isVoiceRequestInFlight) {
      console.log('[VOICE] Ignorado: requisição de voz já em andamento');
      return;
    }
    isVoiceRequestInFlight = true;
    lastVoiceCommandAt = Date.now();
  }

  userGestureReceived = true;
  pendingAckTTS = null;
  const displayText = text.trim() || (currentLang === 'BR' ? '[análise de tela]' : '[screen analysis]');
  addTerminalLine(`> ${displayText}`, 'user-line');
  chatInput.value = '';
  playSendSound();
  setAvatarState('thinking');

  const isBuildTask = /\b(create|generate|build|make|write|produce|design|implement|develop|fix|update|report|crie|gere|construa|faça|escreva|implemente|corrija|analise|relatório)\b/i.test(text);
  if ((capturedScreen || liveScreenMode) && !isBuildTask) {
    const screenResponse = await analyzeScreen(text.trim());
    if (screenResponse) {
      addTerminalLine(screenResponse, 'jarvis-line');
      playReceiveSound();
      highlightAgents(screenResponse);
      if (voiceEnabled && userGestureReceived) {
        const brief = screenResponse.replace(/```[\s\S]*?```/g, '').replace(/[#*_`~>|]/g, '')
          .replace(/\n+/g, ' ').trim().split(/(?<=[.!?])\s+/).slice(0, 2).join(' ').slice(0, 300);
        if (brief) await speakResponse(brief);
      }
      setAvatarState('idle');
      scheduleNextListen(1200);
      if (fromVoice) isVoiceRequestInFlight = false;
      return;
    }
    setAvatarState('idle');
    scheduleNextListen(1500);
    if (fromVoice) isVoiceRequestInFlight = false;
    return;
  }

  if (!text.trim()) {
    if (fromVoice) isVoiceRequestInFlight = false;
    return;
  }

  if (fromVoice) {
    const routed = await routeVoiceCommand(text, { speak: true, announceRealtime: false });
    if (routed?.handled) {
      isVoiceRequestInFlight = false;
      return;
    }
  }

  const opusMatch = /\b(architect|redesign|refactor|infrastructure|migration|deploy|scale|database|system design|e-?book|full|complete|advanced|complex|detailed|comprehensive|deep|entire|production|enterprise)\b/i.test(text);
  const sonnetMatch = /\b(create|generate|build|make|write|produce|design|implement|develop|fix|update|modify|analyze|report|presentation|website|app|pdf|document|code|script|html|css|crie|gere|construa|faça|escreva)\b/i.test(text);
  setActiveModel(opusMatch ? 'opus' : sonnetMatch ? 'sonnet' : 'haiku');

  try {
    const body = { message: text, fromVoice, language: currentLang, conclaveEnabled };
    if (currentAttachment) {
      body.attachmentId = currentAttachment.id;
      currentAttachment = null;
      removeAttachmentPreview();
    }

    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = '';
    let buffer = '';
    let claudeSilent = false;
    let gptResponse = '';
    let streamTtsBuffer = '';
    let streamTtsFired = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      fullResponse += chunk;

      const ackPortion = chunk.split('[build-start]')[0];
      const hadBuildStart = chunk.includes('[build-start]');

      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith('[build-start]')) { claudeSilent = true; continue; }
        processStreamLine(line);
        if (!claudeSilent) gptResponse += line + '\n';
      }

      if (!streamTtsFired && voiceEnabled && userGestureReceived && ackPortion.trim()) {
        const cleanAck = ackPortion.split('\n')
          .filter(l => !l.match(/^\[(system|file|error|warn|info|ack|build-start|translated)\]/))
          .join(' ').trim();
        if (cleanAck) {
          streamTtsBuffer += cleanAck + ' ';
          const sentMatch = streamTtsBuffer.match(/^(.{6,}?[.!?,:])\s/);
          const bufTrim = streamTtsBuffer.trim();
          if (sentMatch || (hadBuildStart && bufTrim.length > 6) || bufTrim.length >= 18) {
            streamTtsFired = true;
            speakResponse((sentMatch ? sentMatch[1] : bufTrim).trim());
          }
        }
      }
    }

    if (buffer.trim() && !buffer.startsWith('[build-start]')) processStreamLine(buffer);

    const cleanGpt = gptResponse.split('\n')
      .filter(l => !l.startsWith('[system]') && !l.startsWith('[file]') && !l.startsWith('[error]') && !l.startsWith('[warn]') && !l.startsWith('[info]') && !l.startsWith('[ack]'))
      .join('\n').trim();

    const claudeOutput = fullResponse.split('[build-start]')[1] || '';
    const cleanClaude = claudeOutput.split('\n')
      .filter(l => !l.startsWith('[system]') && !l.startsWith('[file]') && !l.startsWith('[error]') && !l.startsWith('[warn]') && !l.startsWith('[info]') && !l.startsWith('[ack]'))
      .join('\n').trim();

    if (cleanGpt) {
      addTerminalLine(cleanGpt, 'jarvis-line');
      playReceiveSound();
      highlightAgents(cleanGpt);
      if (voiceEnabled && userGestureReceived && !streamTtsFired) {
        const brief = cleanGpt.replace(/```[\s\S]*?```/g, '').replace(/[#*_`~>|]/g, '')
          .replace(/\n+/g, ' ').trim()
          .split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 5).slice(0, 2).join(' ').slice(0, 300);
        if (brief) await speakResponse(brief);
      }
    }

    if (cleanClaude) {
      addTerminalLine(cleanClaude, 'jarvis-line');
      if (!cleanGpt) { playReceiveSound(); highlightAgents(cleanClaude); }
    }

    setAvatarState('idle');
    scheduleNextListen(1500);
  } catch (err) {
    addTerminalLine(`[error] ${err.message}`, 'error-line');
    playErrorSound();
    setAvatarState('idle');
    scheduleNextListen(2000);
  } finally {
    if (fromVoice) isVoiceRequestInFlight = false;
  }
}

// ========== AVATAR STATES ==========
function setAvatarState(state) {
  if (avatarContainer) {
    avatarContainer.classList.remove('listening', 'thinking', 'speaking');
    if (state === 'listening' || state === 'thinking' || state === 'speaking') {
      avatarContainer.classList.add(state);
    }
  }
  switch (state) {
    case 'listening': setVoiceStatus('listening'); if (avatarStatus) avatarStatus.textContent = 'LISTENING'; break;
    case 'thinking':  setVoiceStatus('thinking'); if (avatarStatus) avatarStatus.textContent = 'THINKING'; break;
    case 'speaking':  setVoiceStatus('speaking'); if (avatarStatus) avatarStatus.textContent = 'SPEAKING'; break;
    default:          setVoiceStatus('auto'); if (avatarStatus) avatarStatus.textContent = '';
  }
  // Update particle orb (managed by interface.module.js)
  if (window.particleOrb) window.particleOrb.setState(state);
}

// ========== VOICE CAPTURE (MEDIARECORDER + WHISPER) ==========
let recordingStartTime = 0;
let audioAnalyser = null;
let peakVolume = 0;
let vadTimer = null;
let continuousMode = false;
let continuousTimer = null;

const VAD_SILENCE_MS = 1100;

function initContinuousBtn() {
  const btn = document.createElement('button');
  btn.id = 'continuous-btn';
  btn.className = 'screen-btn';
  btn.title = 'Continuous voice mode';
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M12 1a4 4 0 0 0-4 4v7a4 4 0 0 0 8 0V5a4 4 0 0 0-4-4z"/>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
    <circle cx="12" cy="22" r="1.5" fill="currentColor"/>
  </svg>`;
  btn.addEventListener('click', async () => {
    if (realtimeConnecting) {
      addTerminalLine(
        currentLang === 'BR' ? '[status] Conectando, aguarde...' : '[status] Connecting, please wait...',
        'info-line'
      );
      while (realtimeConnecting) await new Promise(r => setTimeout(r, 200));
      btn.style.color = realtimeActive ? 'var(--cyan)' : '';
      btn.style.background = realtimeActive ? 'rgba(0,212,255,0.1)' : '';
      addTerminalLine(
        realtimeActive
          ? (currentLang === 'BR' ? '[status] Modo contínuo: ATIVADO' : '[status] Continuous mode: ON')
          : (currentLang === 'BR' ? '[status] Modo contínuo: DESATIVADO' : '[status] Continuous mode: OFF'),
        'info-line'
      );
      return;
    }
    await startRealtime();
    btn.style.color = realtimeActive ? 'var(--cyan)' : '';
    btn.style.background = realtimeActive ? 'rgba(0,212,255,0.1)' : '';
    addTerminalLine(
      realtimeActive
        ? (currentLang === 'BR' ? '[status] Modo contínuo: ATIVADO' : '[status] Continuous mode: ON')
        : (currentLang === 'BR' ? '[status] Modo contínuo: DESATIVADO' : '[status] Continuous mode: OFF'),
      'info-line'
    );
  });
  const sb = document.getElementById('send-btn');
  sb.parentNode.insertBefore(btn, sb);
}

// ========== REALTIME VOICE MODE (OpenAI WebRTC — ~300ms latency) ==========
let realtimePC = null;
let realtimeStream = null;
let realtimeAudio = null;
let realtimeDC = null;
let realtimeActive = false;
let realtimeConnecting = false;
let realtimeUserDisabled = false;

async function startRealtime() {
  if (realtimeActive) { realtimeUserDisabled = true; return stopRealtime(); }
  if (realtimeConnecting) return;
  realtimeConnecting = true;
  realtimeUserDisabled = false;
  setVoiceStatus('listening');
  try {
    userGestureReceived = true;
    const tokenRes = await fetch('/api/realtime/session', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ language: currentLang, voice: getRealtimeVoice() })
    });
    const sess = await tokenRes.json();
    if (!sess.client_secret?.value) throw new Error(sess.error || 'No ephemeral token');

    const pc = new RTCPeerConnection();
    realtimePC = pc;

    realtimeAudio = new Audio();
    realtimeAudio.autoplay = true;
    pc.ontrack = (e) => { realtimeAudio.srcObject = e.streams[0]; setAvatarState('speaking'); };

    realtimeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    realtimeStream.getTracks().forEach(t => pc.addTrack(t, realtimeStream));

    const dc = pc.createDataChannel('oai-events');
    realtimeDC = dc;
    dc.addEventListener('message', (e) => {
      try {
        const ev = JSON.parse(e.data);
        if (ev.type === 'input_audio_buffer.speech_started') setAvatarState('listening');
        if (ev.type === 'input_audio_buffer.speech_stopped' || ev.type === 'input_audio_buffer.committed') setVoiceStatus('thinking');
        if (ev.type?.startsWith('response.audio.') && ev.type !== 'response.audio.done') {
          isJarvisSpeaking = true;
          setAvatarState('speaking');
        }
        if (ev.type === 'response.audio.done') {
          isJarvisSpeaking = false;
          lastVoiceCommandAt = Date.now();
          setAvatarState('idle');
        }
        if (ev.type === 'conversation.item.input_audio_transcription.completed' && ev.transcript) {
          setVoiceStatus('thinking');
          (async () => {
            try {
              const r = await fetch('/api/translate', {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ text: ev.transcript, targetLang: currentLang })
              });
              const d = await r.json();
              addTerminalLine('> ' + (d.translated || ev.transcript), 'user-line');
            } catch {
              addTerminalLine('> ' + ev.transcript, 'user-line');
            }
          })();
          window._pendingTranscript = ev.transcript;
          window._dispatchedThisTurn = false;
          clearTimeout(window._pendingTranscriptTimer);
          window._pendingTranscriptTimer = setTimeout(() => {
            if (window._dispatchedThisTurn) return;
            const t = window._pendingTranscript;
            if (!t) return;
            window._pendingTranscript = null;
            window._dispatchedThisTurn = true;
            handleRealtimeTask(null, JSON.stringify({ request: t }));
          }, 2000);
        }
        if (ev.type === 'response.audio_transcript.done' && ev.transcript) {
          addTerminalLine(ev.transcript, 'jarvis-line');
        }
        if (ev.type === 'response.function_call_arguments.done' && ev.name === 'execute_task') {
          window._pendingTranscript = null;
          clearTimeout(window._pendingTranscriptTimer);
          if (window._dispatchedThisTurn) return;
          window._dispatchedThisTurn = true;
          handleRealtimeTask(ev.call_id, ev.arguments);
        }
      } catch {}
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const sdpRes = await fetch('https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview', {
      method: 'POST',
      body: offer.sdp,
      headers: { 'Authorization': `Bearer ${sess.client_secret.value}`, 'Content-Type': 'application/sdp' }
    });
    await pc.setRemoteDescription({ type: 'answer', sdp: await sdpRes.text() });

    realtimeActive = true;
    isRealtimeActive = true;
    realtimeConnecting = false;
    try { if (wakeWordRecognition) { wakeWordRecognition.onend = null; wakeWordRecognition.stop(); } } catch {}
    const btn = document.getElementById('realtime-btn');
    if (btn) { btn.style.color = 'var(--cyan)'; btn.style.background = 'rgba(0,212,255,0.15)'; }
    const cbtn = document.getElementById('continuous-btn');
    if (cbtn) { cbtn.style.color = 'var(--cyan)'; cbtn.style.background = 'rgba(0,212,255,0.1)'; }
    micBtn.classList.add('recording');
    setVoiceStatus('listening');
  } catch (err) {
    addTerminalLine('[error] Realtime: ' + err.message, 'error-line');
    realtimeConnecting = false;
    stopRealtime();
  }
}

function stopRealtime() {
  realtimeActive = false;
  isRealtimeActive = false;
  isJarvisSpeaking = false;
  realtimeConnecting = false;
  try { realtimeDC?.close(); } catch {}
  try { realtimePC?.close(); } catch {}
  try { realtimeStream?.getTracks().forEach(t => t.stop()); } catch {}
  if (realtimeAudio) { realtimeAudio.srcObject = null; realtimeAudio = null; }
  realtimePC = null; realtimeStream = null; realtimeDC = null;
  const btn = document.getElementById('realtime-btn');
  if (btn) { btn.style.color = ''; btn.style.background = ''; }
  const cbtn = document.getElementById('continuous-btn');
  if (cbtn) { cbtn.style.color = ''; cbtn.style.background = ''; }
  micBtn.classList.remove('recording');
  setAvatarState('idle');
  if (wakeWordEnabled) { try { startWakeWord(); } catch {} }
}

async function routeVoiceCommand(text, { speak = true, announceRealtime = false } = {}) {
  try {
    setVoiceStatus('thinking');
    const res = await fetch('/api/voice-command-router', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, language: currentLang })
    });
    const data = await res.json();
    if (!data.handled) return data;

    if (data.output && !processStreamLine(data.output)) {
      addTerminalLine(data.output, 'system-line');
    }
    if (data.summary) {
      addTerminalLine(`[info] ${data.summary}`, 'info-line');
      if (announceRealtime) announceToRealtime(data.summary);
      else if (speak && voiceEnabled && userGestureReceived) await speakResponse(data.summary);
    }
    setAvatarState('idle');
    scheduleNextListen(1000);
    return data;
  } catch (err) {
    console.warn('[JARVIS] Voice router failed:', err.message);
    return { handled: false, error: err.message };
  }
}

async function handleRealtimeTask(callId, argsJson) {
  let request = '';
  try { request = JSON.parse(argsJson).request || ''; } catch {}
  if (!request) return;

  if (isJarvisSpeaking || Date.now() - lastVoiceCommandAt < VOICE_COMMAND_COOLDOWN_MS) {
    console.log('[VOICE] Ignorado: Jarvis estava falando');
    return;
  }
  if (isVoiceRequestInFlight) {
    console.log('[VOICE] Ignorado: requisição de voz já em andamento');
    return;
  }

  isVoiceRequestInFlight = true;
  lastVoiceCommandAt = Date.now();
  setVoiceStatus('thinking');

  try {
    const routed = await routeVoiceCommand(request, { speak: !realtimeActive, announceRealtime: realtimeActive });
    if (routed?.handled) {
      if (callId && realtimeDC?.readyState === 'open') {
        realtimeDC.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: callId,
            output: JSON.stringify({ status: 'handled', route: routed.route, message: routed.summary })
          }
        }));
      }
      return;
    }

    if (callId && realtimeDC?.readyState === 'open') {
      realtimeDC.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify({ status: 'dispatched', message: 'Task is executing in background' })
        }
      }));
      realtimeDC.send(JSON.stringify({ type: 'response.create' }));
    }

    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: request, fromVoice: true, language: currentLang, conclaveEnabled })
    });
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (line && !line.startsWith('[build-start]')) processStreamLine(line);
      }
    }
  } catch (err) {
    addTerminalLine('[error] Claude dispatch: ' + err.message, 'error-line');
  } finally {
    isVoiceRequestInFlight = false;
  }
}

function announceToRealtime(message) {
  if (realtimeActive && realtimeDC?.readyState === 'open') {
    try {
      const INSTR = {
        BR: `Fale exatamente esta frase ao senhor, sem traduzir nem adicionar nada: "${message}"`,
        ES: `Di exactamente esta frase al señor, sin traducir ni añadir nada: "${message}"`,
        EN: `Say exactly this sentence to the user, do not translate or add anything: "${message}"`
      };
      const instruction = INSTR[currentLang] || INSTR.EN;
      realtimeDC.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: instruction }] }
      }));
      realtimeDC.send(JSON.stringify({ type: 'response.create' }));
      return;
    } catch (e) {
      console.warn('[JARVIS] Realtime DC send failed, falling back to TTS:', e.message);
    }
  }
  if (userGestureReceived) {
    speakResponse(message);
  }
}

function initRealtimeBtn() {
  // Push-to-talk: Realtime only starts when user explicitly clicks mic button.
}

async function startRecording() {
  try {
    if (isRealtimeActive || realtimeActive) {
      console.log('[VOICE] Fluxo legado bloqueado porque Realtime está ativo');
      return;
    }
    if (isJarvisSpeaking || Date.now() - lastVoiceCommandAt < VOICE_COMMAND_COOLDOWN_MS) {
      console.log('[VOICE] Ignorado: Jarvis estava falando');
      return;
    }
    if (isVoiceRequestInFlight) {
      console.log('[VOICE] Ignorado: requisição de voz já em andamento');
      return;
    }

    userGestureReceived = true;

    if (canWebSpeech) {
      const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
      webSpeechRec = new SpeechRec();
      webSpeechRec.lang = ({ BR: 'pt-BR', ES: 'es-ES', EN: 'en-US' }[currentLang]) || 'en-US';
      webSpeechRec.interimResults = true;
      webSpeechRec.maxAlternatives = 1;
      webSpeechRec.continuous = false;

      let finalSent = false;
      webSpeechRec.onresult = (event) => {
        let interim = '', final = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i].isFinal) final += event.results[i][0].transcript;
          else interim += event.results[i][0].transcript;
        }
        if (interim) chatInput.value = interim;
        if (final && !finalSent) {
          finalSent = true;
          chatInput.value = final;
          stopRecording();
          sendMessage(final.trim(), true);
        }
      };

      webSpeechRec.onerror = (e) => {
        console.warn('[JARVIS] Web Speech error:', e.error, '— falling back to Whisper');
        isRecording = false;
        micBtn.classList.remove('recording');
        setAvatarState('idle');
        webSpeechRec = null;
      };

      webSpeechRec.onend = () => {
        if (!finalSent) {
          isRecording = false;
          micBtn.classList.remove('recording');
          setAvatarState('idle');
          webSpeechRec = null;
          if (continuousMode) {
            continuousTimer = setTimeout(() => startRecording(), 800);
          }
        }
      };

      webSpeechRec.start();
      isRecording = true;
      micBtn.classList.add('recording');
      setAvatarState('listening');
      playTone(1200, 40);
      addTerminalLine('[system] Listening (real-time)...', 'system-line');
      return;
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true }
    });

    try {
      const actx = getAudioCtx();
      const source = actx.createMediaStreamSource(stream);
      audioAnalyser = actx.createAnalyser();
      audioAnalyser.fftSize = 512;
      source.connect(audioAnalyser);
      peakVolume = 0;

      const dataArray = new Uint8Array(audioAnalyser.frequencyBinCount);
      const monitorVolume = () => {
        if (!isRecording) return;
        audioAnalyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        if (avg > peakVolume) peakVolume = avg;

        const elapsed = Date.now() - recordingStartTime;
        if (elapsed > 1200 && peakVolume > 8) {
          if (avg < 3) {
            if (!vadTimer) {
              vadTimer = setTimeout(() => {
                if (isRecording) {
                  addTerminalLine('[system] Silence detected — processing...', 'system-line');
                  stopRecording();
                }
              }, VAD_SILENCE_MS);
            }
          } else {
            clearTimeout(vadTimer);
            vadTimer = null;
          }
        }

        requestAnimationFrame(monitorVolume);
      };
      requestAnimationFrame(monitorVolume);
    } catch {}

    const recorderOpts = { audioBitsPerSecond: 64000 };
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
      recorderOpts.mimeType = 'audio/webm;codecs=opus';
    }

    mediaRecorder = new MediaRecorder(stream, recorderOpts);
    audioChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());

      const duration = Date.now() - recordingStartTime;
      if (duration < 800) {
        addTerminalLine('[warn] Recording too short. Hold the mic button and speak, then click again to stop.', 'warn-line');
        setAvatarState('idle');
        return;
      }

      const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      if (blob.size < 1000) {
        addTerminalLine('[warn] No audio captured. Check your microphone.', 'warn-line');
        setAvatarState('idle');
        return;
      }

      if (peakVolume < 5) {
        addTerminalLine('[warn] No voice detected — only silence captured. Speak louder or check mic.', 'warn-line');
        setAvatarState('idle');
        return;
      }

      addTerminalLine(`[system] Audio captured: ${(blob.size / 1024).toFixed(1)}KB, ${(duration / 1000).toFixed(1)}s, peak vol: ${peakVolume.toFixed(0)}`, 'system-line');
      await transcribeAndSend(blob);
    };

    mediaRecorder.start();
    recordingStartTime = Date.now();
    isRecording = true;
    micBtn.classList.add('recording');
    setAvatarState('listening');
    playTone(1200, 40);
    addTerminalLine('[system] Listening... Click mic again when done speaking.', 'system-line');
  } catch (err) {
    addTerminalLine(`[error] Microphone access denied: ${err.message}`, 'error-line');
    playErrorSound();
    setAvatarState('idle');
  }
}

function stopRecording() {
  clearTimeout(vadTimer); vadTimer = null;
  if (webSpeechRec && isRecording) {
    webSpeechRec.stop();
    isRecording = false;
    micBtn.classList.remove('recording');
    setAvatarState('thinking');
    playTone(800, 40);
    return;
  }
  if (mediaRecorder && isRecording) {
    mediaRecorder.stop();
    isRecording = false;
    micBtn.classList.remove('recording');
    setAvatarState('thinking');
    playTone(800, 40);
  }
}

function scheduleNextListen(delayMs = 1200) {
  if (!continuousMode) return;
  clearTimeout(continuousTimer);
  continuousTimer = setTimeout(() => {
    if (!isRecording && continuousMode) startRecording();
  }, delayMs);
}

async function transcribeAndSend(audioBlob) {
  try {
    if (isRealtimeActive || realtimeActive) {
      console.log('[VOICE] Fluxo legado bloqueado porque Realtime está ativo');
      setAvatarState('idle');
      return;
    }
    if (isJarvisSpeaking || Date.now() - lastVoiceCommandAt < VOICE_COMMAND_COOLDOWN_MS) {
      console.log('[VOICE] Ignorado: Jarvis estava falando');
      setAvatarState('idle');
      return;
    }
    if (isVoiceRequestInFlight) {
      console.log('[VOICE] Ignorado: requisição de voz já em andamento');
      setAvatarState('idle');
      return;
    }

    setAvatarState('thinking');
    addTerminalLine('[system] Transcribing voice...', 'system-line');

    const formData = new FormData();
    formData.append('audio', audioBlob, 'audio.webm');

    const sttRes = await fetch('/api/stt', { method: 'POST', body: formData });
    if (!sttRes.ok) {
      const err = await sttRes.json().catch(() => ({ error: 'STT failed' }));
      throw new Error(err.error || 'Transcription failed');
    }
    const sttData = await sttRes.json();

    if (sttData.filtered) {
      addTerminalLine(`[warn] ${sttData.reason || 'No clear speech detected.'}  Speak clearly and try again.`, 'warn-line');
      setAvatarState('idle');
      return;
    }

    if (!sttData.text || !sttData.text.trim()) {
      addTerminalLine('[warn] No speech detected. Try again.', 'warn-line');
      setAvatarState('idle');
      return;
    }

    await sendMessage(sttData.text, true);
  } catch (err) {
    addTerminalLine(`[error] Voice processing failed: ${err.message}`, 'error-line');
    playErrorSound();
    setAvatarState('idle');
  }
}

// ========== TTS PIPELINE (SERIAL QUEUE — prevents double-voice overlap) ==========
let _ttsQueue = Promise.resolve();
let _currentAudio = null;
let _currentTtsAbortController = null;
let _ttsPlaybackId = 0;

function speakResponse(text) {
  if (_currentAudio || currentTtsAudio) {
    try { (_currentAudio || currentTtsAudio).pause(); } catch {}
    try { (_currentAudio || currentTtsAudio).src = ''; } catch {}
    _currentAudio = null;
    currentTtsAudio = null;
    console.log('[VOICE] TTS anterior cancelado');
  }
  if (window.speechSynthesis?.speaking || window.speechSynthesis?.pending) {
    window.speechSynthesis.cancel();
    console.log('[VOICE] TTS anterior cancelado');
  }
  if (_currentTtsAbortController) {
    try { _currentTtsAbortController.abort(); } catch {}
    _currentTtsAbortController = null;
    console.log('[VOICE] TTS anterior cancelado');
  }

  const playbackId = ++_ttsPlaybackId;
  _ttsQueue = Promise.resolve().then(() => _ttsPlay(text, playbackId)).catch(() => _ttsPlay(text, playbackId));
  return _ttsQueue;
}

async function _ttsPlay(text, playbackId = _ttsPlaybackId) {
  const cleanText = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\[.*?\]/g, '')
    .replace(/[#*_`~>|]/g, '')
    .replace(/\n+/g, ' ')
    .trim();

  const sentences = cleanText
    .split(/(?<=[.!?])\s+/)
    .filter(s => s.trim().length > 5)
    .slice(0, 3);

  if (sentences.length === 0) return;
  if (playbackId !== _ttsPlaybackId) return;

  const ttsText = sentences.join(' ').slice(0, 500);

  setAvatarState('speaking');
  isJarvisSpeaking = true;

  try {
    const controller = new AbortController();
    _currentTtsAbortController = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: ttsText, language: currentLang, voice: ttsVoice }),
      signal: controller.signal
    });

    clearTimeout(timeout);
    if (playbackId !== _ttsPlaybackId) return;

    if (!res.ok) {
      console.error('TTS failed:', res.status);
      isJarvisSpeaking = false;
      setAvatarState('idle');
      return;
    }

    const blob = await res.blob();
    if (playbackId !== _ttsPlaybackId) return;
    const url = URL.createObjectURL(blob);

    await new Promise((resolve) => {
      const audio = new Audio(url);
      _currentAudio = audio;
      currentTtsAudio = audio;
      audio.onended = () => { if (playbackId === _ttsPlaybackId) { _currentAudio = null; currentTtsAudio = null; } URL.revokeObjectURL(url); resolve(); };
      audio.onerror = () => { if (playbackId === _ttsPlaybackId) { _currentAudio = null; currentTtsAudio = null; } URL.revokeObjectURL(url); resolve(); };
      audio.play().catch((e) => {
        console.warn('Audio autoplay blocked:', e.message);
        if (playbackId === _ttsPlaybackId) { _currentAudio = null; currentTtsAudio = null; }
        URL.revokeObjectURL(url);
        resolve();
      });
    });
  } catch (err) {
    if (err.name !== 'AbortError') console.error('TTS error:', err.message);
  }

  if (playbackId === _ttsPlaybackId) {
    _currentTtsAbortController = null;
    isJarvisSpeaking = false;
    lastVoiceCommandAt = Date.now();
    setAvatarState('idle');
  }
}

// ========== WAKE WORD DETECTION ==========
function startWakeWord() {
  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) return;

  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  wakeWordRecognition = new SpeechRec();
  wakeWordRecognition.continuous = true;
  wakeWordRecognition.interimResults = true;
  wakeWordRecognition.lang = currentLang === 'BR' ? 'pt-BR' : currentLang === 'ES' ? 'es-ES' : 'en-US';

  wakeWordRecognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript.toLowerCase();
      if (transcript.includes('jarvis') || transcript.includes('járvis') || transcript.includes('jarves')) {
        if (!realtimeActive && !realtimeConnecting) {
          addTerminalLine('[info] 🎤 JARVIS ativado por voz — modo escuta + cowork ON', 'info-line');
          startRealtime();
          fetch('/api/cowork/start', { method: 'POST' }).catch(() => {});
        }
        break;
      }
    }
  };

  wakeWordRecognition.onend = () => {
    if (wakeWordEnabled) wakeWordRecognition.start();
  };

  wakeWordRecognition.start();
}

function stopWakeWord() {
  if (wakeWordRecognition) {
    wakeWordEnabled = false;
    wakeWordRecognition.stop();
    wakeWordRecognition = null;
  }
}

// ========== ATTACHMENT ==========
if (fileAttach) fileAttach.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/attach', { method: 'POST', body: formData });
    const data = await res.json();

    currentAttachment = { id: data.attachmentId, name: data.name };
    showAttachmentPreview(data.name);
  } catch (err) {
    addTerminalLine(`[error] Upload failed: ${err.message}`, 'error-line');
  }
  fileAttach.value = '';
});

function showAttachmentPreview(name) {
  removeAttachmentPreview();
  const preview = document.createElement('div');
  preview.className = 'attachment-preview';
  preview.id = 'att-preview';
  preview.innerHTML = `📎 ${name} <button class="remove-att" onclick="removeAttachment()">✕</button>`;
  document.querySelector('.input-bar').insertAdjacentElement('beforebegin', preview);
}

function removeAttachmentPreview() {
  document.getElementById('att-preview')?.remove();
}

function removeAttachment() {
  currentAttachment = null;
  removeAttachmentPreview();
}

// ========== EVENT LISTENERS ==========
if (sendBtn) sendBtn.addEventListener('click', () => sendMessage(chatInput ? chatInput.value : ''));

if (chatInput) chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage(chatInput.value);
  }
});

if (micBtn) micBtn.addEventListener('click', () => {
  userGestureReceived = true;
  micBtn.classList.toggle('recording');
  setVoiceStatus(micBtn.classList.contains('recording') ? 'listening' : 'ready');
  addTerminalLine(realtimeActive ? '[system] Desconectando voz...' : '[system] Conectando voz...', 'system-line');
  startRealtime().then(() => {
    if (realtimeActive) {
      micBtn.classList.add('recording');
      setVoiceStatus('listening');
    } else {
      micBtn.classList.remove('recording');
      setVoiceStatus('auto');
    }
  }).catch((err) => {
    micBtn.classList.remove('recording');
    setVoiceStatus('auto');
    addTerminalLine(`[error] Voz: ${err.message || err}`, 'error-line');
  });
});

setVoiceStatus('ready');

if (terminal && chatInput) terminal.addEventListener('click', () => chatInput.focus());

// ========== INIT ==========
initContinuousBtn();
initRealtimeBtn();

// ── PUSH NOTIFICATION CHANNEL ──
(function initNotifications() {
  const es = new EventSource('/api/notifications');
  es.onmessage = (e) => {
    try {
      const payload = JSON.parse(e.data);
      switch (payload.type) {
        case 'build-complete':
          if (payload.message) {
            addTerminalLine(`[info] ✓ ${payload.message}`, 'info-line');
            console.log('[JARVIS] Build complete notification received:', payload.message);
            if (userGestureReceived) {
              if (realtimeActive || isRealtimeActive) announceToRealtime(payload.message);
              else speakResponse(payload.message);
            }
          }
          break;
        case 'pet-mic':
          if (payload.active === true || payload.on === true) {
            try { startRealtime(); } catch (err) { console.error('[JARVIS] pet-mic startRealtime falhou', err); }
          } else {
            try { stopRealtime(); } catch (err) { console.error('[JARVIS] pet-mic stopRealtime falhou', err); }
          }
          break;
      }
    } catch {}
  };
  es.onerror = () => { /* silent reconnect handled by browser */ };
})();

// ── PRE-FLIGHT VERIFICATION ──
(async function runPreflight() {
  const PREFLIGHT_KEY = 'jarvis_preflight_passed';
  const overlay = document.getElementById('preflight-overlay');
  if (!overlay) return;

  if (localStorage.getItem(PREFLIGHT_KEY) && !window._forcePreflightRecheck) {
    overlay.style.display = 'none';
    return;
  }

  overlay.style.display = 'flex';

  try {
    const res = await fetch('/api/health/preflight', { method: 'POST' });
    const data = await res.json();

    for (const [key, result] of Object.entries(data.results)) {
      const el = document.querySelector(`.pf-item[data-key="${key}"]`);
      if (!el) continue;
      const icon = el.querySelector('.pf-icon');
      if (result.status === 'ok') {
        icon.textContent = '✅';
        el.classList.add('pf-ok');
      } else {
        icon.textContent = '❌';
        el.classList.add('pf-err');
        el.setAttribute('data-detail', result.detail || 'Unknown error');
      }
    }

    const failedIssues = [];
    for (const [key, result] of Object.entries(data.results)) {
      if (result.status !== 'ok') {
        failedIssues.push({ key, detail: result.detail || 'Unknown error' });
      }
    }

    const resultDiv = document.getElementById('preflight-result');
    const msgEl = document.getElementById('preflight-msg');
    const okBtn = document.getElementById('preflight-ok');
    const retryBtn = document.getElementById('preflight-retry');
    resultDiv.style.display = 'block';

    let fixBtn = document.getElementById('preflight-autofix');
    if (!fixBtn) {
      fixBtn = document.createElement('button');
      fixBtn.id = 'preflight-autofix';
      fixBtn.style.cssText = 'background:linear-gradient(135deg,#00d4ff,#00ff88);color:#000;border:none;padding:10px 28px;border-radius:8px;font-weight:700;cursor:pointer;font-size:13px;margin-left:8px;';
      fixBtn.textContent = 'Corrigir Automaticamente';
      retryBtn.parentElement.appendChild(fixBtn);
    }

    let fixLog = document.getElementById('preflight-fixlog');
    if (!fixLog) {
      fixLog = document.createElement('div');
      fixLog.id = 'preflight-fixlog';
      fixLog.style.cssText = 'display:none;margin-top:14px;background:#060a1a;border:1px solid #1a3a5c;border-radius:8px;padding:12px;max-height:180px;overflow-y:auto;font-family:"JetBrains Mono",monospace;font-size:10px;color:#c9d1d9;white-space:pre-wrap;word-break:break-all;';
      resultDiv.appendChild(fixLog);
    }

    if (data.status === 'ready') {
      msgEl.textContent = 'Todos os sistemas operacionais. JARVIS esta pronto.';
      msgEl.style.color = '#00ff88';
      okBtn.textContent = 'Iniciar JARVIS';
      okBtn.style.background = '#00d4ff';
      okBtn.style.display = 'inline-block';
      retryBtn.style.display = 'none';
      fixBtn.style.display = 'none';
    } else {
      msgEl.textContent = 'Problemas detectados. JARVIS pode funcionar com recursos limitados.';
      msgEl.style.color = '#ffaa00';
      okBtn.textContent = 'Continuar Assim';
      okBtn.style.background = '#555';
      okBtn.style.display = 'inline-block';
      retryBtn.style.display = 'inline-block';
      const claudeOk = data.results.claude_cli?.status === 'ok';
      fixBtn.style.display = claudeOk ? 'inline-block' : 'none';
    }

    okBtn.onclick = () => {
      localStorage.setItem(PREFLIGHT_KEY, Date.now().toString());
      overlay.style.display = 'none';
    };

    retryBtn.onclick = () => {
      document.querySelectorAll('.pf-item').forEach(el => {
        el.classList.remove('pf-ok', 'pf-err');
        el.removeAttribute('data-detail');
        el.querySelector('.pf-icon').textContent = '⏳';
      });
      resultDiv.style.display = 'none';
      fixLog.style.display = 'none';
      fixLog.textContent = '';
      window._forcePreflightRecheck = true;
      runPreflight();
    };

    fixBtn.onclick = async () => {
      fixBtn.disabled = true;
      fixBtn.textContent = 'Corrigindo...';
      fixBtn.style.opacity = '0.6';
      retryBtn.disabled = true;
      okBtn.disabled = true;
      fixLog.style.display = 'block';
      fixLog.textContent = '[JARVIS] Acionando sistema para corrigir problemas...\n\n';

      try {
        const fixRes = await fetch('/api/health/autofix', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ issues: failedIssues })
        });

        const reader = fixRes.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          fixLog.textContent += chunk;
          fixLog.scrollTop = fixLog.scrollHeight;
        }

        fixLog.textContent += '\n\n[JARVIS] Correcao concluida. Executando verificacao novamente...\n';

        await new Promise(r => setTimeout(r, 2000));
        document.querySelectorAll('.pf-item').forEach(el => {
          el.classList.remove('pf-ok', 'pf-err');
          el.removeAttribute('data-detail');
          el.querySelector('.pf-icon').textContent = '⏳';
        });
        resultDiv.style.display = 'none';
        fixLog.style.display = 'none';
        fixLog.textContent = '';
        window._forcePreflightRecheck = true;
        runPreflight();

      } catch (err) {
        fixLog.textContent += `\n[ERRO] ${err.message}\n`;
        fixBtn.disabled = false;
        fixBtn.textContent = 'Corrigir Automaticamente';
        fixBtn.style.opacity = '1';
        retryBtn.disabled = false;
        okBtn.disabled = false;
      }
    };
  } catch (e) {
    const resultDiv = document.getElementById('preflight-result');
    const msgEl = document.getElementById('preflight-msg');
    resultDiv.style.display = 'block';
    msgEl.textContent = '❌ Cannot reach JARVIS server. Is it running?';
    msgEl.style.color = '#ff4444';
  }
})();

// ── Deps object — shared mutable state + functions for ES modules ──
const _deps = {
  get voiceEnabled() { return voiceEnabled; },
  set voiceEnabled(v) { voiceEnabled = v; },
  get currentLang() { return currentLang; },
  set currentLang(v) { currentLang = v; },
  get conclaveEnabled() { return conclaveEnabled; },
  set conclaveEnabled(v) { conclaveEnabled = v; },
  get wakeWordEnabled() { return wakeWordEnabled; },
  set wakeWordEnabled(v) { wakeWordEnabled = v; },
  get ttsVoice() { return ttsVoice; },
  set ttsVoice(v) { ttsVoice = v; },
  get realtimeActive() { return realtimeActive; },
  get userGestureReceived() { return userGestureReceived; },
  addTerminalLine,
  setVoiceStatus,
  setAvatarState,
  speakResponse,
  startRealtime,
  stopRealtime,
  startWakeWord,
  stopWakeWord,
  scheduleNextListen,
  setModelFromAgent,
  modules: {},
};

// ── Boot: load all 8 ES modules ──
(async function boot() {
  try {
    // Phase 1: independent modules (load in parallel)
    const [ifaceM, menuM, srvM] = await Promise.all([
      import('./js/modules/interface.module.js'),
      import('./js/modules/menu.module.js'),
      import('./js/modules/server-online.module.js'),
    ]);
    ifaceM.initInterfaceModule(_deps);
    menuM.initMenuModule(_deps);
    srvM.initServerOnlineModule(_deps);

    // Phase 2: agents must init before ai-models (provides pulseEntity)
    const agentsM = await import('./js/modules/agents.module.js');
    agentsM.initAgentsModule(_deps);

    // Phase 3: remaining modules (parallel)
    const [aiM, mbM, obsM, metricsM] = await Promise.all([
      import('./js/modules/ai-models.module.js'),
      import('./js/modules/mega-brain.module.js'),
      import('./js/modules/obsidian.module.js'),
      import('./js/modules/metrics-quick.module.js'),
    ]);
    aiM.initAiModelsModule(_deps);
    mbM.initMegaBrainModule(_deps);
    obsM.initObsidianModule(_deps);
    metricsM.initMetricsQuickModule(_deps);

  } catch (err) {
    console.error('[JARVIS] Module boot failed:', err);
  }
})();
