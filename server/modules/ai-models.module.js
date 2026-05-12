import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { toFile } from 'openai';

const HALLUCINATION_PATTERNS = [
  /^\.+$/,
  /^(bye|goodbye|farewell|see you|thank you for watching|thanks for watching)\.?$/i,
  /^(tchau|adeus|obrigado por assistir|obrigada por assistir|até logo)\.?$/i,
  /^(subscribe|like and subscribe|don't forget to subscribe)\.?$/i,
  /^(inscreva-se|se inscreva|curta e se inscreva)\.?$/i,
  /^(silence|silêncio|music|música|applause|laughter)\.?$/i,
  /^\[.*\]$/,
  /^\(.*\)$/,
  /^(um+|uh+|ah+|eh+|oh+|hm+|hmm+)\.?$/i,
  /^(you|you\.|he|she|it|the|a|an|is|was|I)\.?$/i,
  /^(o|a|e|é|ou|sim|não)\.?$/i,
  /^.{1,3}$/,
  /^(subs|sub|legendas|legenda).*$/i,
  /^(continue|continua|next|próximo)\.?$/i,
  /^(okay|ok)\.?$/i,
];

function isHallucination(text) {
  if (!text || !text.trim()) return true;
  const trimmed = text.trim();
  if (trimmed.length < 4) return true;
  if (!trimmed.includes(' ') && trimmed.length < 8) return true;
  for (const pattern of HALLUCINATION_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }
  return false;
}

export function registerAiModelsModule(app, deps) {
  const {
    JARVIS_DIR, PYTHON_CMD, CLAUDE_CMD,
    openai, upload,
    sessionStats, pools, pendingSpawns, acquireTaskProc,
    appendHistoryFast, findRelevantMemories, storeMemory, updateProjectStatus,
    buildJarvisPrompt, buildGPTSystemPrompt, loadMemoryCached, loadHistory,
    notifyBuildComplete, pushNotification,
    isSpreadsheetRequest, tryFastExecution, isMediaCommand, parseMediaRequest, handleMediaCommand,
    SCREEN_PATTERN,
    isPortuguese,
    coworkState
  } = deps;

  // POST /api/voice-spawn - Reserve a pre-warmed process for upcoming voice request
  app.post('/api/voice-spawn', (req, res) => {
    try {
      if (!deps.claudeCliAvailable) {
        return res.status(503).json({ error: 'Sistema de execução não configurado', detail: deps.claudeCliError });
      }
      const spawnId = `spawn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const proc = pools.haiku.acquire();
      if (!proc) return res.status(503).json({ error: 'Sistema sobrecarregado no momento' });
      pendingSpawns.set(spawnId, { proc });

      setTimeout(() => {
        if (pendingSpawns.has(spawnId)) {
          const s = pendingSpawns.get(spawnId);
          try { s.proc.kill(); } catch {}
          pendingSpawns.delete(spawnId);
          pools.haiku.fill();
        }
      }, 60000);

      res.json({ spawnId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/voice-complete - Send voice message to Claude using warm pool
  app.post('/api/voice-complete', async (req, res) => {
    const t0 = Date.now();
    try {
      const { spawnId, message } = req.body;
      if (!message) return res.status(400).json({ error: 'Message required' });

      sessionStats.requests++;
      sessionStats.tokensIn += Math.ceil(message.length / 4);

      if (spawnId && pendingSpawns.has(spawnId)) {
        const old = pendingSpawns.get(spawnId);
        try { old.proc.kill(); } catch {}
        pendingSpawns.delete(spawnId);
      }

      appendHistoryFast('user', message);

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('Cache-Control', 'no-cache');

      if (!deps.claudeCliAvailable) {
        const errMsg = 'Sistema de execução não configurado. Voz funciona, execução desativada.';
        console.error(`[JARVIS] ❌ voice-complete rejected: ${deps.claudeCliError}`);
        try { res.write(errMsg); res.end(); } catch {}
        return;
      }

      let proc;
      if (spawnId && pendingSpawns.has(spawnId)) {
        proc = pendingSpawns.get(spawnId).proc;
        pendingSpawns.delete(spawnId);
      } else {
        proc = acquireTaskProc({ model: 'sonnet' });
      }
      if (!proc) {
        try { res.write('[error] Sistema de execução indisponível.'); res.end(); } catch {}
        return;
      }

      const { language: voiceLang = 'EN' } = req.body;
      let voiceMessage = message;
      if (coworkState.active && coworkState.screenContext) {
        voiceMessage = `[SCREEN CONTEXT: The user is currently ${coworkState.screenContext}]\n\nUser question: ${message}`;
      }
      proc.stdin.write(buildJarvisPrompt(voiceMessage, '', true, voiceLang));
      proc.stdin.end();

      const killTimer = setTimeout(() => {
        try { proc.kill(); } catch {}
      }, 60000);

      let responseBuffer = '';
      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        responseBuffer += chunk;
        try { res.write(chunk); } catch {}
      });

      proc.on('close', () => {
        clearTimeout(killTimer);
        const elapsed = Date.now() - t0;
        sessionStats.tokensOut += Math.ceil(responseBuffer.length / 4);
        sessionStats.lastLatency = elapsed;
        console.log(`[JARVIS] 🎤 Voice → ${elapsed}ms | pool: H${pools.haiku.pool.length}`);
        appendHistoryFast('jarvis', responseBuffer);
        storeMemory(message, responseBuffer).catch(() => {});
        try { res.end(); } catch {}
        try { notifyBuildComplete(message, responseBuffer, voiceLang); } catch(e) {}
        updateProjectStatus(message, responseBuffer).catch(() => {});
      });

      proc.on('error', (err) => {
        clearTimeout(killTimer);
        try { res.write('[error] ' + err.message); res.end(); } catch {}
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/audio-complete - Messages to pre-spawned + streaming
  app.post('/api/audio-complete', async (req, res) => {
    try {
      const { spawnId, message } = req.body;
      if (!message) return res.status(400).json({ error: 'Message required' });

      sessionStats.requests++;
      const semanticContext = await findRelevantMemories(message);
      appendHistoryFast('user', message);

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('X-Accel-Buffering', 'no');

      if (!deps.claudeCliAvailable) {
        try { res.write('[error] Sistema de execução não configurado.'); res.end(); } catch {}
        return;
      }

      const proc = acquireTaskProc({ model: 'sonnet' });
      if (!proc) {
        try { res.write('[error] Sistema de execução indisponível.'); res.end(); } catch {}
        return;
      }

      proc.stdin.write(buildJarvisPrompt(message, semanticContext));
      proc.stdin.end();

      let responseBuffer = '';
      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        responseBuffer += chunk;
        res.write(chunk);
      });

      proc.on('close', () => {
        sessionStats.tokensOut += Math.ceil(responseBuffer.length / 4);
        appendHistoryFast('jarvis', responseBuffer);
        storeMemory(message, responseBuffer).catch(() => {});
        try { res.end(); } catch {}
        const _audLang = req.body.language || 'BR';
        try { notifyBuildComplete(message, responseBuffer, _audLang); } catch(e) {}
        updateProjectStatus(message, responseBuffer).catch(() => {});
      });

      proc.on('error', (err) => {
        res.write('[error] ' + err.message);
        res.end();
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/stt - Voice Transcription (Whisper) with dual-language + hallucination filter
  app.post('/api/stt', upload.single('audio'), async (req, res) => {
    try {
      if (!openai) return res.status(500).json({ error: 'OpenAI API key not configured' });
      if (!req.file) return res.status(400).json({ error: 'No audio file' });

      if (req.file.size < 2000) {
        console.log('[JARVIS] STT rejected: audio too small', req.file.size, 'bytes');
        return res.json({ text: '', filtered: true, reason: 'Audio too short' });
      }

      const debugPath = path.join(JARVIS_DIR, 'system', 'last-audio-debug.webm');
      try { fs.writeFileSync(debugPath, req.file.buffer); } catch {}

      console.log(`[JARVIS] STT input: ${req.file.size} bytes, mime: ${req.file.mimetype}, saved to debug`);

      const audioFile = await toFile(req.file.buffer, 'audio.webm', { type: 'audio/webm' });

      let transcription = await openai.audio.transcriptions.create({
        model: 'whisper-1',
        file: audioFile,
        language: 'en',
        prompt: 'Create an e-book about digital marketing. Build a website. Generate a report. Design a presentation. Analyze data. Write code. Hello JARVIS.'
      });

      let raw = transcription.text?.trim() || '';
      console.log('[JARVIS] STT [en]:', JSON.stringify(raw));

      if (isHallucination(raw)) {
        console.log('[JARVIS] EN was hallucination, trying PT...');
        const audioFile2 = await toFile(req.file.buffer, 'audio.webm', { type: 'audio/webm' });
        transcription = await openai.audio.transcriptions.create({
          model: 'whisper-1',
          file: audioFile2,
          language: 'pt',
          prompt: 'Crie um e-book sobre marketing digital. Construa um site. Gere um relatório. Olá JARVIS.'
        });
        raw = transcription.text?.trim() || '';
        console.log('[JARVIS] STT [pt]:', JSON.stringify(raw));
      }

      if (isHallucination(raw)) {
        console.log('[JARVIS] STT FILTERED both attempts:', JSON.stringify(raw));
        return res.json({ text: '', filtered: true, reason: 'Could not understand. Try speaking closer to the mic.' });
      }

      console.log('[JARVIS] STT accepted:', raw);
      res.json({ text: raw });
    } catch (err) {
      console.error('[JARVIS] STT error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/analyze-screen-fast - Vision via GPT-4o-mini (real-time, ~1s response)
  app.post('/api/analyze-screen-fast', async (req, res) => {
    try {
      if (!openai) return res.status(500).json({ error: 'OpenAI API key not configured' });
      const { image, message = '', language = 'BR', saveHistory = false } = req.body;
      if (!image) return res.status(400).json({ error: 'Image required' });

      const memory = loadMemoryCached();
      const systemPrompt = buildGPTSystemPrompt(language);

      const history = loadHistory().slice(-6);
      const historyText = history.length
        ? history.map(e => `[${e.role}] ${e.content}`).join('\n')
        : '';

      const question = message
        ? (language === 'BR' ? `O usuário perguntou sobre a tela: ${message}` : `User asked about the screen: ${message}`)
        : (language === 'BR' ? 'Descreva o que está nesta tela de forma útil e direta.' : 'Describe what is on this screen in a useful and direct way.');

      const contextualQuestion = historyText
        ? `${language === 'BR' ? 'Conversa recente (para contexto):' : 'Recent conversation (for context):'}\n${historyText}\n\n${question}`
        : question;

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: image, detail: 'auto' } },
              { type: 'text', text: contextualQuestion }
            ]
          }
        ],
        max_tokens: 600,
        temperature: 0.7
      });

      const response = completion.choices[0]?.message?.content?.trim() || '';

      if (saveHistory && response) {
        const userEntry = message ? `[screen] ${message}` : '[screen] (describe)';
        appendHistoryFast('user', userEntry);
        appendHistoryFast('assistant', response);
      }

      res.json({ response });
    } catch (err) {
      console.error('[JARVIS] Fast vision error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/analyze-screen - Vision: analyze screenshot via Claude CLI
  app.post('/api/analyze-screen', async (req, res) => {
    try {
      const { image, message = '', language = 'BR', saveHistory = false } = req.body;
      if (!image) return res.status(400).json({ error: 'Image required' });

      const base64Data = image.replace(/^data:image\/(png|jpeg|webp);base64,/, '');
      const ext = image.startsWith('data:image/jpeg') ? 'jpg' : 'png';
      const tmpImg = path.join(os.tmpdir(), `jarvis-screen-${Date.now()}.${ext}`);
      fs.writeFileSync(tmpImg, Buffer.from(base64Data, 'base64'));

      const memory = loadMemoryCached();
      const langInstruction = language === 'BR'
        ? 'Responda EXCLUSIVAMENTE em Português Brasileiro. Você é JARVIS, braço direito do usuário.'
        : 'Respond EXCLUSIVELY in English. You are JARVIS, the user\'s right-hand man.';

      const question = message
        ? (language === 'BR' ? `Pergunta do usuário sobre a tela: ${message}` : `User question about the screen: ${message}`)
        : (language === 'BR' ? 'Descreva o que está nesta tela de forma útil e direta.' : 'Describe what is on this screen in a useful and direct way.');

      const prompt = `${langInstruction}

${memory ? `MEMORY:\n${memory}\n` : ''}
Analyze this screenshot and answer: ${question}

Be direct and concise. If the user's question is about specific content visible on screen, focus on that.`;

      if (!deps.claudeCliAvailable) {
        try { fs.unlinkSync(tmpImg); } catch {}
        return res.status(503).json({ error: `Claude Code unavailable: ${deps.claudeCliError}` });
      }

      return new Promise((resolve) => {
        const proc = spawn(CLAUDE_CMD, [
          '--print', '--output-format', 'text',
          '--model', 'claude-sonnet-4-6',
          '--dangerously-skip-permissions',
          '--file', tmpImg
        ], { shell: true, cwd: JARVIS_DIR });

        proc.stdin.write(prompt);
        proc.stdin.end();

        let output = '';
        const killTimer = setTimeout(() => { try { proc.kill(); } catch {} }, 60000);

        proc.stdout.on('data', d => { output += d.toString(); });
        proc.on('close', () => {
          clearTimeout(killTimer);
          try { fs.unlinkSync(tmpImg); } catch {}
          sessionStats.requests++;
          const response = output.trim();
          if (saveHistory && response) {
            const userEntry = message ? `[screen] ${message}` : '[screen] (describe)';
            appendHistoryFast('user', userEntry);
            appendHistoryFast('assistant', response);
          }
          res.json({ response });
          resolve();
        });
        proc.on('error', (err) => {
          clearTimeout(killTimer);
          try { fs.unlinkSync(tmpImg); } catch {}
          res.status(500).json({ error: err.message });
          resolve();
        });
      });
    } catch (err) {
      console.error('[JARVIS] Screen analysis error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/tts - Voice Synthesis (OpenAI Speech)
  app.post('/api/tts', async (req, res) => {
    try {
      if (!openai) return res.status(500).json({ error: 'OpenAI API key not configured' });
      const { text, language = 'BR', voice: requestedVoice } = req.body;
      if (!text) return res.status(400).json({ error: 'Text required' });

      const VALID_VOICES = ['alloy','ash','coral','echo','fable','nova','onyx','sage','shimmer'];
      const voice = VALID_VOICES.includes(requestedVoice) ? requestedVoice
        : (language === 'BR' ? 'nova' : 'onyx');

      const mp3 = await openai.audio.speech.create({
        model: 'tts-1',
        voice,
        input: text
      });
      const buffer = Buffer.from(await mp3.arrayBuffer());
      res.setHeader('Content-Type', 'audio/mpeg');
      res.send(buffer);
    } catch (err) {
      console.error('[JARVIS] TTS error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/translate - Quick translate text to target language
  app.post('/api/translate', async (req, res) => {
    try {
      const { text, targetLang = 'EN' } = req.body || {};
      if (!text) return res.json({ translated: text });

      const LANG_NAMES = deps.LANG_NAMES || { BR: 'Portuguese', ES: 'Spanish', EN: 'English' };
      const langName = LANG_NAMES[targetLang] || 'English';
      const isAlreadyTarget =
        (targetLang === 'BR' && isPortuguese(text)) ||
        (targetLang === 'EN' && !isPortuguese(text) && !/[áéíóúñ¿¡]/i.test(text)) ||
        (targetLang === 'ES' && /\b(el|la|los|las|es|está|para|por|que|con|una|del)\b/i.test(text));

      if (isAlreadyTarget) return res.json({ translated: text });

      const translated = await deps.translateTo(text, langName);
      res.json({ translated });
    } catch (err) {
      res.json({ translated: req.body?.text || '' });
    }
  });

  // POST /api/realtime/session - Mint ephemeral token for OpenAI Realtime API
  app.post('/api/realtime/session', async (req, res) => {
    try {
      if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OpenAI API key not configured' });
      const { language = 'BR', voice = 'ash' } = req.body || {};

      const INSTRUCTIONS = {
        BR: `Você é JARVIS — assistente pessoal com poderes COMPLETOS sobre o computador do senhor. Fale APENAS em Português Brasileiro. Máximo 1 frase. Nunca mencione GPT ou OpenAI.

SUAS CAPACIDADES (informe ao senhor quando perguntar):
- Você VÊ a tela do senhor em tempo real (screenshot de todos os monitores)
- Você CONTROLA mouse e teclado (clica, digita, arrasta)
- Você CRIA arquivos, apps, sites, planilhas, PDFs, apresentações
- Você ABRE programas, sites, pastas — qualquer coisa
- Você EXECUTA código, comandos, automações
- Você tem MEMÓRIA — lembra de conversas e preferências anteriores

REGRA ABSOLUTA: Para QUALQUER pedido que não seja pergunta pura de conhecimento → chame IMEDIATAMENTE a função "execute_task" no MESMO turno. Falar "vou fazer", "já estou fazendo", "um momento" SEM chamar execute_task no mesmo turno = FALHA.

Exemplos: "abre o YouTube" → execute_task | "o que tem na minha tela?" → execute_task | "cria uma planilha" → execute_task | "olha meu monitor" → execute_task | "coloca música" → execute_task | "você consegue ver?" → execute_task (SIM, você vê)

NUNCA diga "não consigo", "não tenho acesso", "não posso ver". Você PODE tudo. SEMPRE chame execute_task.`,

        ES: `Eres JARVIS — asistente personal con poderes COMPLETOS sobre el computador del señor. SOLO Español. Máximo 1 frase. Nunca menciones GPT ni OpenAI.

TUS CAPACIDADES: VES la pantalla en tiempo real, CONTROLAS mouse y teclado, CREAS archivos/apps/sitios/PDFs, ABRES programas y sitios, EJECUTAS código y comandos, tienes MEMORIA de conversaciones anteriores.

REGLA: Para CUALQUIER pedido que no sea conocimiento puro → llama "execute_task". NUNCA digas "no puedo". Si pregunta "qué hay en mi pantalla" → execute_task. SIEMPRE execute_task.`,

        EN: `You are JARVIS — personal assistant with FULL powers over the user's computer. ONLY English. Max 1 sentence. Never mention GPT or OpenAI.

YOUR CAPABILITIES: You SEE the screen in real-time, CONTROL mouse and keyboard, CREATE files/apps/sites/PDFs, OPEN programs and sites, EXECUTE code and commands, have MEMORY of past conversations.

RULE: For ANY request that is not pure knowledge → call "execute_task". NEVER say "I can't". If asked "what's on my screen" → execute_task. ALWAYS execute_task.`
      };
      const instructions = INSTRUCTIONS[language] || INSTRUCTIONS.BR;

      const tools = [{
        type: 'function',
        name: 'execute_task',
        description: 'Execute ANY action on the computer via Claude Code. Use for: creating files/documents/code/PDFs, opening websites/folders/programs, playing music/video, searching the web, organizing files, installing software, sending emails, running commands — ANY action the user requests that needs to be done on the computer.',
        parameters: {
          type: 'object',
          properties: {
            request: { type: 'string', description: 'The full user request verbatim, in original language.' }
          },
          required: ['request']
        }
      }];

      const r = await fetch('https://api.openai.com/v1/realtime/sessions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-4o-realtime-preview',
          voice,
          instructions,
          turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 },
          input_audio_transcription: {
            model: 'whisper-1',
            language: { BR: 'pt', ES: 'es', EN: 'en' }[language] || 'pt'
          },
          modalities: ['audio', 'text'],
          tools,
          tool_choice: 'auto'
        })
      });
      const data = await r.json();
      if (!r.ok) {
        console.error('[JARVIS] Realtime session error:', data);
        return res.status(500).json({ error: data.error?.message || 'Realtime session failed' });
      }
      res.json(data);
    } catch (err) {
      console.error('[JARVIS] Realtime error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/voice-command-router - Fast voice-only routing before /api/chat
  app.post('/api/voice-command-router', async (req, res) => {
    try {
      const { message = '', language = 'BR' } = req.body || {};
      const text = String(message || '').trim();
      if (!text) return res.status(400).json({ handled: false, error: 'Message required' });

      if (isSpreadsheetRequest(text) || SCREEN_PATTERN.test(text)) {
        return res.json({ handled: false, reason: 'chat_required' });
      }

      const fastResult = tryFastExecution(text, language);
      if (fastResult) {
        appendHistoryFast('user', text);
        appendHistoryFast('jarvis', fastResult.summary);
        return res.json({
          handled: true,
          route: 'fast-path',
          summary: fastResult.summary,
          output: fastResult.output || ''
        });
      }

      if (isMediaCommand(text)) {
        const mediaRequest = parseMediaRequest(text);
        const mediaResult = await handleMediaCommand(mediaRequest);
        appendHistoryFast('user', text);
        appendHistoryFast('jarvis', mediaResult.summary);
        return res.json({
          handled: true,
          route: 'media',
          summary: mediaResult.summary,
          output: `[system] ${mediaRequest.platform}: ${mediaRequest.query}`
        });
      }

      return res.json({ handled: false, reason: 'no_fast_route' });
    } catch (err) {
      console.error('[JARVIS] Voice command router error:', err.message);
      res.status(500).json({ handled: false, error: err.message });
    }
  });
}
