import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { randomBytes } from 'crypto';

// ─── Executor constants ───────────────────────────────────────────────────────
const VALID_EXECUTOR_MODES = ['auto', 'claude', 'codex', 'openai'];
const VALID_EXECUTOR_TASK_TYPES = ['code', 'file', 'automation', 'voice', 'chat', 'analysis', 'unknown'];
const CODEX_WRITE_CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const CODEX_WRITE_TEST_EXTENSIONS = new Set(['.txt', '.md', '.html', '.json', '.csv']);

function normalizeExecutorMode(mode) {
  const normalized = String(mode || '').trim().toLowerCase();
  return VALID_EXECUTOR_MODES.includes(normalized) ? normalized : 'auto';
}

function normalizeExecutorTaskType(taskType) {
  const normalized = String(taskType || '').trim().toLowerCase();
  return VALID_EXECUTOR_TASK_TYPES.includes(normalized) ? normalized : 'unknown';
}

function detectTaskType(prompt) {
  const text = String(prompt || '').trim().toLowerCase();
  if (!text) return 'unknown';
  const hasAny = (patterns) => patterns.some((pattern) => pattern.test(text));

  if (hasAny([
    /\b(abra|abrir|clique|clicar|controle|controlar|digite|digitar|navegador|browser|mouse|teclado)\b/i,
    /\b(youtube|spotify|chrome|janela|site|p[aÃ¡]gina)\b/i
  ])) return 'automation';

  if (hasAny([/\b(voz|microfone|audio|[aÃ¡]udio|fale|falar|ouvir|escutar|tts|stt|realtime)\b/i])) return 'voice';

  if (hasAny([
    /\b(corrija|corrigir|implemente|implementar|refatore|refatorar|debug|bug|endpoint|api|rota)\b/i,
    /\b(c[oÃ³]digo|code|html|css|javascript|js|typescript|ts|python|node|react|script|fun[cÃ§][aÃ£]o)\b/i,
    /\b(edite|editar|altere|alterar).+\b(server\.js|script\.js|index\.html|\.js|\.ts|\.py|\.css|\.html)\b/i,
    /\b(analise|analisar).+\b(server\.js|script\.js|index\.html|c[oÃ³]digo|code)\b/i
  ])) return 'code';

  if (hasAny([
    /\b(responda|responde|answer)\s+apenas\b/i,
    /\b(explique|explicar|resuma|resumir|o que [eÃ©]|qual|quais|como funciona|me diga|diferen[cÃ§]a entre)\b/i
  ])) return 'chat';

  if (hasAny([
    /\b(crie|criar|gere|gerar|salve|salvar)\s+(um\s+|uma\s+)?arquivo\b/i,
    /\barquivo\b/i, /\bpasta\b/i, /\bplanilha\b/i, /\bexcel\b/i, /\bpdf\b/i, /\b(doc|docs|documento)\b/i
  ])) return 'file';

  if (hasAny([
    /\b(edite|editar|corrija|corrigir|implemente|implementar|refatore|refatorar)\b/i,
    /\b(c[oó]digo|code|html|css|javascript|js|typescript|ts|python|node|react|script|fun[cç][aã]o)\b/i,
    /\bbug\b/i
  ])) return 'code';

  if (hasAny([
    /\b(abra|abrir|clique|clicar|controle|controlar|digite|digitar|navegador|browser|mouse|teclado)\b/i,
    /\b(youtube|spotify|chrome|janela|site|p[aá]gina)\b/i
  ])) return 'automation';

  if (hasAny([/\b(voz|microfone|audio|[aá]udio|fale|falar|ouvir|escutar|tts|stt|realtime)\b/i])) return 'voice';

  if (hasAny([
    /\b(analise|analisar|an[aá]lise|compare|comparar|investigue|investigar|diagn[oó]stico|diagnosticar)\b/i,
    /\b(relat[oó]rio|prd|mapa t[eé]cnico)\b/i
  ])) return 'analysis';

  if (hasAny([/\b(explique|explicar|resuma|resumir|o que [eé]|qual|quais|como|por que|porque)\b/i])) return 'chat';

  return 'unknown';
}

function classifyExecutorError(outputOrError) {
  const raw = outputOrError instanceof Error
    ? `${outputOrError.message || ''}\n${outputOrError.stack || ''}`
    : String(outputOrError || '');
  const text = raw.toLowerCase();
  if (!text.trim()) return 'empty_output';
  if (/usage limit|out of extra usage|reset|rate limit|quota|too many requests/.test(text)) return 'limit';
  if (/not authenticated|unauthorized|auth|authentication|login|sign in|signin|token/.test(text)) return 'auth';
  if (/timeout|timed out|etimedout/.test(text)) return 'timeout';
  if (/command not found|not recognized|not installed|enoent|where.+could not find|which.+no/.test(text)) return 'not_installed';
  if (/process error|spawn|exit code|eacces|eperm|failed/.test(text)) return 'process_error';
  return 'unknown';
}

function createExecutorResult({
  ok = false, provider = null, output = '', errorType = null,
  rawError = null, fallbackUsed = false, fallbackReason = null
} = {}) {
  return { ok: Boolean(ok), provider, output: String(output || ''), errorType, rawError, fallbackUsed: Boolean(fallbackUsed), fallbackReason };
}

function checkCodexHealth() {
  const command = (process.env.JARVIS_CODEX_CMD || 'codex').trim() || 'codex';
  const authPattern = /auth|authentication|login|sign in|signin|token|unauthorized|not authenticated|not logged in/i;
  const result = (status, detail, extra = {}) => ({ status, detail, command, ...extra });

  try {
    const commandLooksLikePath = /[\\/]/.test(command) || /^[a-zA-Z]:/.test(command);
    let found = commandLooksLikePath ? fs.existsSync(command) : false;
    let detectedPath = commandLooksLikePath && found ? command : null;

    if (!found) {
      const lookupCmd = process.platform === 'win32' ? 'where' : 'which';
      const lookup = spawnSync(lookupCmd, [command], { encoding: 'utf-8', timeout: 5000, windowsHide: true });
      if (lookup.status === 0 && lookup.stdout?.trim()) {
        found = true;
        detectedPath = lookup.stdout.trim().split(/\r?\n/)[0]?.trim() || null;
      }
    }
    if (!found) return result('not_installed', 'Codex CLI nao encontrado no PATH');

    const runCodex = (args) => spawnSync(command, args, { encoding: 'utf-8', timeout: 8000, shell: process.platform === 'win32', windowsHide: true });
    const version = runCodex(['--version']);
    const versionOutput = `${version.stdout || ''}\n${version.stderr || ''}`.trim();
    if (version.status === 0 && versionOutput) return result('ok', 'Codex CLI disponivel', detectedPath ? { path: detectedPath } : {});
    if (authPattern.test(versionOutput)) return result('auth', 'Codex CLI requer login/autenticacao', detectedPath ? { path: detectedPath } : {});
    const help = runCodex(['--help']);
    const helpOutput = `${help.stdout || ''}\n${help.stderr || ''}`.trim();
    if (help.status === 0 && helpOutput) return result('ok', 'Codex CLI disponivel', detectedPath ? { path: detectedPath } : {});
    if (authPattern.test(helpOutput)) return result('auth', 'Codex CLI requer login/autenticacao', detectedPath ? { path: detectedPath } : {});
    const detail = helpOutput || versionOutput || 'Codex CLI encontrado, mas nao respondeu a --version ou --help';
    return result('error', detail.slice(0, 300), detectedPath ? { path: detectedPath } : {});
  } catch (err) {
    return result('unknown', err.message?.slice(0, 300) || 'Nao foi possivel determinar o status do Codex CLI');
  }
}

function codexHealthToErrorType(status, detail) {
  if (status === 'not_installed') return 'not_installed';
  if (status === 'auth') return 'auth';
  return classifyExecutorError(`${status || ''}\n${detail || ''}`);
}

function getCodexCommand() {
  return (process.env.JARVIS_CODEX_CMD || 'codex').trim() || 'codex';
}

function createSafeCodexEnv() {
  const keepKeys = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'USERNAME', 'CODEX_HOME'];
  const env = {};
  for (const key of keepKeys) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function runCodexCommand(args, { cwd, timeoutMs = 60000, input = '' } = {}) {
  return new Promise((resolve) => {
    const command = getCodexCommand();
    const maxBuffer = 1024 * 1024;
    let stdout = '', stderr = '', settled = false, timedOut = false, timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ok: result.ok, code: result.code, stdout: stdout.slice(0, maxBuffer), stderr: stderr.slice(0, maxBuffer), timedOut });
    };

    let child;
    try {
      child = spawn(command, args, { cwd, shell: process.platform === 'win32', windowsHide: true, env: createSafeCodexEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      stderr = err.message || String(err);
      return finish({ ok: false, code: null });
    }

    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { if (!child.killed) child.kill('SIGKILL'); } catch {} }, 2000);
    }, Math.max(1000, Number(timeoutMs) || 60000));

    child.stdout.on('data', (chunk) => { if (stdout.length < maxBuffer) stdout += chunk.toString('utf-8'); });
    child.stderr.on('data', (chunk) => { if (stderr.length < maxBuffer) stderr += chunk.toString('utf-8'); });
    child.on('error', (err) => { stderr += err.message || String(err); finish({ ok: false, code: null }); });
    child.on('close', (code) => { finish({ ok: code === 0 && !timedOut, code }); });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

function executeWithClaudeDryRun({ prompt, model, cwd } = {}) {
  return createExecutorResult({ ok: false, provider: 'claude', output: '', errorType: 'not_connected', rawError: 'Claude execution is not connected in Fase 4A', fallbackUsed: false, fallbackReason: null });
}

function executeWithCodexDryRun({ prompt, cwd } = {}) {
  const health = checkCodexHealth();
  if (health.status === 'ok') return createExecutorResult({ ok: true, provider: 'codex', output: 'Codex provider prepared for future execution', fallbackUsed: false, fallbackReason: null });
  return createExecutorResult({ ok: false, provider: 'codex', output: '', errorType: classifyExecutorError(health.detail || health.status), rawError: health.detail || 'Codex CLI unavailable', fallbackUsed: false, fallbackReason: null });
}

async function executeWithCodexReal({ prompt, cwd, timeoutMs = 60000 } = {}) {
  const health = checkCodexHealth();
  if (health.status !== 'ok') return createExecutorResult({ ok: false, provider: 'codex', output: '', errorType: codexHealthToErrorType(health.status, health.detail), rawError: health.detail || health.status || 'Codex CLI unavailable', fallbackUsed: false, fallbackReason: null });

  const userPrompt = String(prompt || '').trim();
  if (!userPrompt) return createExecutorResult({ ok: false, provider: 'codex', output: '', errorType: 'empty_output', rawError: 'Prompt vazio', fallbackUsed: false, fallbackReason: null });

  const safetyPrompt = ['Você está em um teste controlado do Jarvis.', 'Não altere arquivos, não instale pacotes, não execute comandos destrutivos e responda apenas ao pedido textual, salvo se o usuário pedir explicitamente uma ação de arquivo.', 'Não leia, exponha ou revele conteúdo de arquivos .env, chaves, tokens, senhas ou segredos.', '', userPrompt].join('\n');
  const args = ['--ask-for-approval', 'never', 'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '-C', cwd || process.cwd(), '-'];
  const result = await runCodexCommand(args, { cwd, timeoutMs, input: safetyPrompt });
  const combinedError = `${result.stderr || ''}\n${result.stdout || ''}`.trim();
  const output = String(result.stdout || '').trim();

  if (result.timedOut) return createExecutorResult({ ok: false, provider: 'codex', output, errorType: 'timeout', rawError: result.stderr || 'Codex CLI timeout', fallbackUsed: false, fallbackReason: null });
  if (result.code !== 0) return createExecutorResult({ ok: false, provider: 'codex', output, errorType: classifyExecutorError(combinedError) === 'empty_output' ? 'process_error' : classifyExecutorError(combinedError), rawError: result.stderr || `Codex CLI exited with code ${result.code}`, fallbackUsed: false, fallbackReason: null });
  if (!output) return createExecutorResult({ ok: false, provider: 'codex', output: '', errorType: 'empty_output', rawError: result.stderr || 'Codex CLI returned empty stdout', fallbackUsed: false, fallbackReason: null });
  return createExecutorResult({ ok: true, provider: 'codex', output, errorType: null, rawError: result.stderr ? result.stderr.trim() : null, fallbackUsed: false, fallbackReason: null });
}

function sanitizeProjectFilename(filename) {
  const raw = String(filename || '').trim();
  if (!raw) return { ok: false, error: 'Filename vazio' };
  if (path.isAbsolute(raw) || raw.includes('..') || raw.includes('/') || raw.includes('\\')) return { ok: false, error: 'Filename deve ser apenas um nome de arquivo simples' };
  if (raw !== path.basename(raw)) return { ok: false, error: 'Filename nao pode conter caminho' };
  if (!/^[a-zA-Z0-9 _.-]+$/.test(raw)) return { ok: false, error: 'Filename contem caracteres nao permitidos' };
  const ext = path.extname(raw).toLowerCase();
  if (!CODEX_WRITE_TEST_EXTENSIONS.has(ext)) return { ok: false, error: 'Extensao nao permitida' };
  return { ok: true, filename: raw };
}

function isInsideDirectory(parentDir, targetPath) {
  const parent = path.resolve(parentDir);
  const target = path.resolve(targetPath);
  const relative = path.relative(parent, target);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function createCodexWriteError({ errorType = 'unknown', message = 'Codex write test failed', output = '', rawError = null, filename = null, filePath = null } = {}) {
  return { ok: false, provider: 'codex', mode: 'write-test', fileCreated: false, filename, path: filePath, output: String(output || ''), errorType, message, rawError };
}

function cleanupExpiredCodexWriteRequests(pendingCodexWriteRequests) {
  const now = Date.now();
  for (const [id, item] of pendingCodexWriteRequests.entries()) {
    if (!item || item.expiresAt <= now) pendingCodexWriteRequests.delete(id);
  }
}

function listPendingCodexWriteRequests(pendingCodexWriteRequests) {
  cleanupExpiredCodexWriteRequests(pendingCodexWriteRequests);
  const now = Date.now();
  return Array.from(pendingCodexWriteRequests.values()).map((item) => ({
    id: item.id, filename: item.filename, expiresAt: new Date(item.expiresAt).toISOString(),
    secondsRemaining: Math.max(0, Math.ceil((item.expiresAt - now) / 1000)), source: item.source, mode: item.mode, taskType: item.taskType
  }));
}

function createCodexWriteConfirmation(pendingCodexWriteRequests, { filename, content, mode, taskType } = {}) {
  cleanupExpiredCodexWriteRequests(pendingCodexWriteRequests);
  let id;
  do { id = randomBytes(3).toString('hex').toUpperCase(); } while (pendingCodexWriteRequests.has(id));
  const now = Date.now();
  pendingCodexWriteRequests.set(id, { id, filename, content, createdAt: now, expiresAt: now + CODEX_WRITE_CONFIRMATION_TTL_MS, source: 'chat', mode, taskType });
  return { id, filename, expiresAt: now + CODEX_WRITE_CONFIRMATION_TTL_MS, message: ['Pedido de escrita pendente.', '', `Arquivo: ${filename}`, 'Destino: Documents and Projects', 'Expira em: 10 minutos', '', 'Para confirmar, envie:', `CONFIRMAR_ESCRITA_CODEX ${id}`, '', 'Para cancelar, envie:', `CANCELAR_ESCRITA_CODEX ${id}`].join('\n') };
}

function extractCodexWriteContent(text) {
  const raw = String(text || '');
  const normalized = raw.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const markers = ['com o conteudo:', 'com o conteudo', 'com conteudo:', 'com conteudo', 'com o texto:', 'com o texto', 'com texto:', 'com texto', 'o conteudo:', 'o conteudo'];
  for (const marker of markers) {
    const index = normalized.indexOf(marker);
    if (index >= 0) { const content = raw.slice(index + marker.length).trim(); return content || null; }
  }
  return null;
}

function parseCodexWriteRequestFromMessage(message) {
  const text = String(message || '').trim();
  if (!text) return { ok: false, errorType: 'unknown', message: 'Mensagem vazia' };
  const filenameMatch = text.match(/\barquivo\s+(?:chamado\s+)?["']?([^"'\s]+)["']?/i) || text.match(/\bsalve\s+em\s+["']?([^"'\s]+)["']?/i);
  if (!filenameMatch) return { ok: false, errorType: 'unknown', message: 'Use: crie um arquivo chamado NOME.txt com o conteudo: TEXTO' };
  const filename = filenameMatch[1]?.trim();
  const safeName = sanitizeProjectFilename(filename);
  if (!safeName.ok) return { ok: false, errorType: 'invalid_filename', message: safeName.error, filename };
  const extractedContent = extractCodexWriteContent(text);
  if (!extractedContent) return { ok: false, errorType: 'unknown', message: 'Informe o conteudo. Use: crie um arquivo chamado NOME.txt com o conteudo: TEXTO', filename: safeName.filename };
  return { ok: true, filename: safeName.filename, content: extractedContent };
}

function isCodexWriteRequestIntent(message) {
  const text = String(message || '');
  if (!text.trim()) return false;
  const hasWriteVerb = /\b(cri[ae]|criar|salv[ae]|salvar|edite|editar|atualize|atualizar|modifique|modificar|gere|gerar|fa[çc]a|fazer)\b/i.test(text);
  const hasFileSignal = /\b(arquivo|file|ficheiro|documento|chamado|salve\s+em)\b/i.test(text) || /\.[a-z0-9]{1,8}\b/i.test(text);
  const hasContentSignal = /\b(conte[uú]do|texto|com\s+o|com\s+a)\b/i.test(text);
  return hasWriteVerb && hasFileSignal && hasContentSignal;
}

function isCodexWriteConfirmation(message) {
  const match = String(message || '').trim().match(/^CONFIRMAR_ESCRITA_CODEX\s+([A-Z0-9]{6,16})$/i);
  return match ? match[1].toUpperCase() : null;
}

function isCodexWriteCancel(message) {
  const match = String(message || '').trim().match(/^CANCELAR_ESCRITA_CODEX\s+([A-Z0-9]{6,16})$/i);
  return match ? match[1].toUpperCase() : null;
}

async function executePendingCodexWrite(pendingCodexWriteRequests, PROJECTS_DIR, id) {
  const key = String(id || '').trim().toUpperCase();
  const pending = pendingCodexWriteRequests.get(key);
  if (!pending) {
    cleanupExpiredCodexWriteRequests(pendingCodexWriteRequests);
    return createCodexWriteError({ errorType: 'unknown', message: 'Nao encontrei uma escrita pendente com esse codigo.' });
  }
  if (pending.expiresAt <= Date.now()) {
    pendingCodexWriteRequests.delete(key);
    cleanupExpiredCodexWriteRequests(pendingCodexWriteRequests);
    return createCodexWriteError({ errorType: 'unknown', message: 'Esse pedido de escrita expirou. Envie o pedido novamente.', filename: pending.filename });
  }
  cleanupExpiredCodexWriteRequests(pendingCodexWriteRequests);
  const safeName = sanitizeProjectFilename(pending.filename);
  if (!safeName.ok) { pendingCodexWriteRequests.delete(key); return createCodexWriteError({ errorType: 'invalid_filename', message: safeName.error, filename: pending.filename }); }
  const result = await executeWithCodexWriteTest(PROJECTS_DIR, { filename: safeName.filename, content: pending.content });
  pendingCodexWriteRequests.delete(key);
  return result;
}

function buildCodexWriteConfirmationReply(pendingCodexWriteRequests, message, mode, taskType) {
  const parsed = parseCodexWriteRequestFromMessage(message);
  if (!parsed.ok) return { ok: false, errorType: parsed.errorType, message: parsed.errorType === 'invalid_filename' ? `Nao posso preparar essa escrita: ${parsed.message}.` : parsed.message };
  return { ok: true, ...createCodexWriteConfirmation(pendingCodexWriteRequests, { filename: parsed.filename, content: parsed.content, mode, taskType }) };
}

function writeCodexWriteConfirmationResponse(res, pendingCodexWriteRequests, message, mode, taskType) {
  const pending = buildCodexWriteConfirmationReply(pendingCodexWriteRequests, message, mode, taskType);
  res.write(pending.message);
  try { res.end(); } catch {}
  return pending;
}

async function writeCodexChatResponse({ res, message, prompt, language, t0, fallbackUsed = false, fallbackReason = null, taskType = 'unknown', JARVIS_DIR, PROJECTS_DIR, currentExecutorMode, appendHistoryFast, storeMemory, sessionStats } = {}) {
  const fallbackNotice = 'Executor Claude indisponivel. Continuei pelo Codex.';
  const readOnlyFileNotice = 'Codex foi acionado em modo somente leitura. Posso gerar o conteudo ou plano, mas a escrita pelo chat ainda nao esta liberada.';
  const codexPrompt = fallbackUsed && taskType === 'file'
    ? `${prompt}\n\n[IMPORTANTE - MODO SOMENTE LEITURA]\nVoce esta sendo chamado pelo /api/chat em modo read-only. Nao afirme que criou, editou ou salvou arquivos. Para pedidos de arquivo, gere apenas o conteudo ou um plano e informe que a escrita real ainda exige a rota controlada /api/executor/codex-write-test ou uma etapa futura.`
    : prompt;
  const codexResult = await executeWithCodexReal({ prompt: codexPrompt, cwd: JARVIS_DIR, timeoutMs: 90000 });

  if (codexResult.ok) {
    const notices = [];
    if (fallbackUsed && currentExecutorMode === 'auto') {
      notices.push(fallbackNotice);
      console.log(`[JARVIS][executor] mode=auto taskType=${taskType} fallbackNotice=shown`);
    }
    if (fallbackUsed && taskType === 'file') notices.push(readOnlyFileNotice);
    const output = [...notices, codexResult.output || ''].filter(Boolean).join('\n\n');
    sessionStats.tokensOut += Math.ceil(output.length / 4);
    sessionStats.lastLatency = Date.now() - t0;
    res.write(output);
    setImmediate(() => {
      appendHistoryFast('user', message);
      appendHistoryFast('jarvis', output);
      storeMemory(message, output).catch(() => {});
    });
    try { res.end(); } catch {}
    return true;
  }

  console.error(`[JARVIS][executor] provider=codex failed errorType=${codexResult.errorType || 'unknown'} fallbackUsed=${fallbackUsed}`);
  const codexErrorMsg = fallbackUsed
    ? 'Nao consegui executar pelo Claude nem pelo Codex neste momento. Verifique os limites/autenticacao dos executores.'
    : 'Nao consegui executar pelo Codex neste momento. Verifique se o Codex CLI esta autenticado e disponivel.';
  res.write(`[error] ${codexErrorMsg}`);
  try { res.end(); } catch {}
  return false;
}

async function executeWithCodexWriteTest(PROJECTS_DIR, { filename, content, timeoutMs = 120000 } = {}) {
  const safeName = sanitizeProjectFilename(filename);
  if (!safeName.ok) return createCodexWriteError({ errorType: 'invalid_filename', message: safeName.error, filename: String(filename || '') });

  const expectedContent = String(content ?? 'Arquivo criado pelo Codex via Jarvis em modo write controlado.');
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  const targetPath = path.resolve(PROJECTS_DIR, safeName.filename);
  if (!isInsideDirectory(PROJECTS_DIR, targetPath)) return createCodexWriteError({ errorType: 'invalid_filename', message: 'Caminho final fora de Documents and Projects', filename: safeName.filename, filePath: targetPath });

  const health = checkCodexHealth();
  if (health.status !== 'ok') return createCodexWriteError({ errorType: codexHealthToErrorType(health.status, health.detail), message: health.detail || 'Codex CLI indisponivel', filename: safeName.filename, filePath: targetPath, rawError: health.detail || health.status || null });

  const prompt = ['Voce esta em um teste controlado do Jarvis.', 'Seu diretorio de trabalho e Documents and Projects.', `Crie exatamente o arquivo "${safeName.filename}" neste diretorio.`, 'Conteudo exato do arquivo:', expectedContent, '', 'Regras:', '- Nao altere nenhum outro arquivo.', '- Nao crie pastas.', '- Nao leia .env.', '- Nao acesse arquivos fora deste diretorio.', '- Nao instale pacotes.', '- Nao execute comandos destrutivos.', '- Responda apenas com CODEX_WRITE_OK quando terminar.'].join('\n');
  const args = ['--ask-for-approval', 'never', '--disable', 'memories', 'exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--ephemeral', '--ignore-rules', '--color', 'never', '-C', '.', '-'];
  const startedAt = Date.now();
  const result = await runCodexCommand(args, { cwd: PROJECTS_DIR, timeoutMs, input: prompt });
  const output = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  const combined = `${stderr}\n${output}`.trim();

  if (result.timedOut) return createCodexWriteError({ errorType: 'timeout', message: 'Codex write test excedeu o tempo limite', output, rawError: stderr || 'timeout', filename: safeName.filename, filePath: targetPath });
  if (result.code !== 0) {
    const errorType = /workspace-write|possible values|invalid value|unexpected argument/i.test(combined) ? 'sandbox_not_supported' : (classifyExecutorError(combined) === 'empty_output' ? 'process_error' : classifyExecutorError(combined));
    return createCodexWriteError({ errorType, message: 'Codex write test retornou erro de processo', output, rawError: stderr || `Codex CLI exited with code ${result.code}`, filename: safeName.filename, filePath: targetPath });
  }
  if (!/CODEX_WRITE_OK/i.test(output)) return createCodexWriteError({ errorType: 'process_error', message: 'Codex nao confirmou a escrita com CODEX_WRITE_OK', output, rawError: stderr || null, filename: safeName.filename, filePath: targetPath });
  if (!fs.existsSync(targetPath)) return createCodexWriteError({ errorType: 'file_not_created', message: 'Arquivo nao foi criado em Documents and Projects', output, rawError: stderr || null, filename: safeName.filename, filePath: targetPath });
  const fileStat = fs.statSync(targetPath);
  if (fileStat.mtimeMs < startedAt - 2000) return createCodexWriteError({ errorType: 'file_not_created', message: 'Arquivo nao foi criado ou atualizado nesta execucao', output, rawError: stderr || null, filename: safeName.filename, filePath: targetPath });
  const actualContent = fs.readFileSync(targetPath, 'utf-8');
  if (!actualContent.trim()) return createCodexWriteError({ errorType: 'empty_output', message: 'Arquivo foi criado, mas esta vazio', output, rawError: stderr || null, filename: safeName.filename, filePath: targetPath });
  return { ok: true, provider: 'codex', mode: 'write-test', fileCreated: true, filename: safeName.filename, path: targetPath, output, errorType: null, rawError: stderr || null, contentMatches: actualContent.includes(expectedContent) };
}

function executeWithOpenAIDryRun({ prompt, openai } = {}) {
  return createExecutorResult({ ok: false, provider: 'openai', output: '', errorType: openai ? 'not_connected' : 'auth', rawError: openai ? 'OpenAI execution is not connected in Fase 4A' : 'OPENAI_API_KEY not configured', fallbackUsed: false, fallbackReason: null });
}

function selectDryRunProvider(mode, taskType) {
  if (mode === 'claude' || mode === 'codex' || mode === 'openai') return mode;
  switch (taskType) {
    case 'voice': return 'openai';
    default: return 'claude';
  }
}

export function registerAgentsModule(app, deps) {
  const {
    JARVIS_DIR, PROJECTS_DIR, PYTHON_CMD, CLAUDE_CMD, PORT,
    openai, pools, pendingSpawns, acquireWithFallback, acquireTaskProc,
    attachments, sessionStats,
    appendHistoryFast, loadMemoryCached, findRelevantMemories, storeMemory, updateProjectStatus,
    buildJarvisPrompt, handleGPTChat, generateAck, buildGPTSystemPrompt,
    isPortuguese, translateTo,
    isTaskRequest, detectParallelTasks, selectModelByComplexity,
    tryFastExecution, trySmartFastExecution, handleMediaCommand, isMediaCommand, parseMediaRequest,
    isSpreadsheetRequest, pendingExcelTemplateRequests, isExcelTemplateConfirmation, isExcelTemplateCancel,
    cleanupExpiredExcelTemplateRequests, createExcelTemplateConfirmation, executePendingExcelTemplate,
    createSpreadsheetFromRequest, SPREADSHEET_TEMPLATES, safeWorkbookName,
    SCREEN_PATTERN, COMPUTER_USE_PATTERN, NEEDS_SCREENSHOT_PATTERN,
    rateLimitedOpenAI,
    pushNotification, notifyBuildComplete,
    coworkState, executorState
  } = deps;

  let currentExecutorMode = normalizeExecutorMode(process.env.JARVIS_EXECUTOR_MODE);
  const pendingCodexWriteRequests = new Map();

  // Expose to deps for other modules (e.g. server-online)
  deps.checkCodexHealth = checkCodexHealth;
  executorState.currentExecutorMode = currentExecutorMode;
  executorState.VALID_EXECUTOR_MODES = VALID_EXECUTOR_MODES;

  // ── /api/chat ──────────────────────────────────────────────────────────────
  app.post('/api/chat', async (req, res) => {
    const t0 = Date.now();
    try {
      const { message, attachmentId, fromVoice, language = 'BR', conclaveEnabled = true } = req.body;
      if (!message) return res.status(400).json({ error: 'Message required' });

      sessionStats.requests++;
      sessionStats.tokensIn += Math.ceil(message.length / 4);

      const englishMessage = message;
      let fullMessage = englishMessage;
      if (attachmentId && attachments.has(attachmentId)) {
        fullMessage += `\n\n[ATTACHED FILE CONTENT]:\n${attachments.get(attachmentId)}`;
      }

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('Cache-Control', 'no-cache');

      const confirmWriteId = isCodexWriteConfirmation(fullMessage);
      if (confirmWriteId) {
        const result = await executePendingCodexWrite(pendingCodexWriteRequests, PROJECTS_DIR, confirmWriteId);
        if (result.ok) { res.write(`Arquivo criado com sucesso em Documents and Projects\\${result.filename}`); }
        else { res.write(`Nao consegui criar o arquivo pelo Codex. Motivo: ${result.message || result.errorType || 'erro desconhecido'}`); }
        try { res.end(); } catch {}
        return;
      }

      const cancelWriteId = isCodexWriteCancel(fullMessage);
      if (cancelWriteId) {
        cleanupExpiredCodexWriteRequests(pendingCodexWriteRequests);
        if (pendingCodexWriteRequests.delete(cancelWriteId)) { res.write('Pedido de escrita cancelado. Nenhum arquivo foi criado.'); }
        else { res.write('Nao encontrei uma escrita pendente com esse codigo.'); }
        try { res.end(); } catch {}
        return;
      }

      const confirmExcelId = isExcelTemplateConfirmation(fullMessage);
      if (confirmExcelId) {
        const result = await executePendingExcelTemplate(confirmExcelId, language);
        res.write(result.ok
          ? (result.summary || `Planilha criada com sucesso em Documents and Projects\\${path.basename(result.path || '')}`)
          : `Nao consegui criar a planilha. Motivo: ${result.message || result.error || 'erro desconhecido'}`);
        try { res.end(); } catch {}
        return;
      }

      const cancelExcelId = isExcelTemplateCancel(fullMessage);
      if (cancelExcelId) {
        cleanupExpiredExcelTemplateRequests();
        if (pendingExcelTemplateRequests.delete(cancelExcelId)) { res.write('Pedido de planilha cancelado. Nenhum arquivo foi criado.'); }
        else { res.write('Nao encontrei uma planilha pendente com esse codigo.'); }
        try { res.end(); } catch {}
        return;
      }

      const msgClean = fullMessage.toLowerCase().replace(/^jarvis[,.]?\s*/i, '').trim();
      if (/que\s+horas?|what\s+time|hora\s+atual|horas?\s+agora/i.test(msgClean)) {
        const now = new Date();
        const time = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        const answer = { BR: `São ${time}, senhor.`, ES: `Son las ${time}, señor.`, EN: `It's ${time}, sir.` }[language] || `It's ${time}.`;
        res.write(answer);
        try { res.end(); } catch {}
        return;
      }
      if (/que\s+dia|what\s+day|data\s+de\s+hoje|today/i.test(msgClean) && !/cria|faz|make|create/i.test(msgClean)) {
        const now = new Date();
        const date = now.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        const answer = { BR: `Hoje é ${date}.`, ES: `Hoy es ${date}.`, EN: `Today is ${date}.` }[language] || `Today is ${date}.`;
        res.write(answer);
        try { res.end(); } catch {}
        return;
      }

      if (isSpreadsheetRequest(fullMessage)) {
        const pending = createExcelTemplateConfirmation(fullMessage);
        res.write(pending.message);
        try { res.end(); } catch {}
        return;
      }

      if (isMediaCommand(fullMessage)) {
        const mediaRequest = parseMediaRequest(fullMessage);
        const mediaResult = await handleMediaCommand(mediaRequest);
        const elapsed = Date.now() - t0;
        console.log(`[JARVIS][media] platform=${mediaRequest.platform} query="${mediaRequest.query}" elapsed=${elapsed}ms`);
        res.write(mediaResult.summary);
        setImmediate(() => {
          appendHistoryFast('user', message);
          appendHistoryFast('jarvis', mediaResult.summary);
          pushNotification({ type: 'build-complete', message: mediaResult.summary, language: 'BR' });
        });
        try { res.end(); } catch {}
        return;
      }

      if (SCREEN_PATTERN.test(fullMessage) && openai) {
        try {
          console.log('[JARVIS] 👁️ Screen query — capturing monitors + cursor focus...');
          const scriptPath = path.join(JARVIS_DIR, 'system', 'screenshot.py');
          const cursorPath = path.join(JARVIS_DIR, 'system', 'screenshot-cursor.py');
          const { execSync } = await import('child_process');
          const [ssResult, cursorResult] = await Promise.all([
            new Promise(r => { try { r(execSync(`"${PYTHON_CMD}" "${scriptPath}" all`, { encoding: 'utf-8', timeout: 10000, maxBuffer: 30*1024*1024 })); } catch { r('{}'); } }),
            new Promise(r => { try { r(execSync(`"${PYTHON_CMD}" "${cursorPath}"`, { encoding: 'utf-8', timeout: 10000, maxBuffer: 30*1024*1024 })); } catch { r('{}'); } }),
          ]);
          const ssData = JSON.parse(ssResult.trim() || '{}');
          const cursorData = JSON.parse(cursorResult.trim() || '{}');
          const imageUrl = ssData.data;
          const monitorCount = ssData.monitors || 1;
          const cursorUrl = cursorData.data;
          const cursorInfo = cursorData.cursor_x ? `Cursor em (${cursorData.cursor_x}, ${cursorData.cursor_y}), monitor ${cursorData.monitor}.` : '';
          const langPrompts = {
            BR: `Você é JARVIS, assistente pessoal. Está VENDO a tela do senhor (${monitorCount} monitor${monitorCount > 1 ? 'es' : ''}). ${cursorInfo}\n\nPergunta: "${fullMessage}"\n\nA PRIMEIRA imagem mostra todos os monitores. A SEGUNDA imagem (se houver) mostra a região ao redor do cursor do mouse (marcado com um X vermelho) — este é o FOCO de atenção do senhor.\n\nREGRAS:\n- Foque PRINCIPALMENTE onde o cursor está (segunda imagem)\n- Leia textos visíveis, títulos, URLs, nomes de apps\n- Fale natural: "Tá com o Chrome aberto no YouTube...", "O cursor tá em cima de..."\n- Se perguntar algo específico, responda sobre aquilo\n- NUNCA diga "não consigo ver"\n- Máximo 4 frases diretas`,
            ES: `Eres JARVIS. Ves la pantalla (${monitorCount} monitor${monitorCount > 1 ? 'es' : ''}). ${cursorInfo} Pregunta: "${fullMessage}". Primera imagen = todos los monitores. Segunda = foco del cursor (X rojo). Enfócate en donde está el cursor. Lee textos, URLs, apps. Máximo 4 frases.`,
            EN: `You are JARVIS. You see the screen (${monitorCount} monitor${monitorCount > 1 ? 's' : ''}). ${cursorInfo} Question: "${fullMessage}". First image = all monitors. Second = cursor focus area (red X). Focus on where the cursor is. Read text, URLs, apps. Max 4 sentences.`
          };
          const visionContent = [
            { type: 'text', text: langPrompts[language] || langPrompts.EN },
            { type: 'image_url', image_url: { url: imageUrl, detail: 'auto' } },
          ];
          if (cursorUrl) visionContent.push({ type: 'image_url', image_url: { url: cursorUrl, detail: 'high' } });
          const visionRes = await rateLimitedOpenAI(() => openai.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: visionContent }], max_tokens: 400 }));
          const answer = visionRes.choices[0]?.message?.content?.trim();
          if (answer) {
            const elapsed = Date.now() - t0;
            console.log(`[JARVIS] 👁️ Screen vision (${monitorCount} monitors) → ${elapsed}ms`);
            res.write(answer);
            setImmediate(() => { appendHistoryFast('user', message); appendHistoryFast('jarvis', answer); pushNotification({ type: 'build-complete', message: answer.slice(0, 200), language }); });
            try { res.end(); } catch {}
            return;
          }
        } catch (e) { console.error('[JARVIS] Screen vision error:', e.message?.slice(0, 200)); }
      }

      const fastResult = tryFastExecution(fullMessage, language);
      if (fastResult) {
        const elapsed = Date.now() - t0;
        console.log(`[JARVIS] ⚡⚡ FAST-PATH L1 → ${elapsed}ms`);
        res.write(fastResult.summary);
        setImmediate(() => { appendHistoryFast('user', message); appendHistoryFast('jarvis', fastResult.summary); pushNotification({ type: 'build-complete', message: fastResult.summary, language }); });
        try { res.end(); } catch {}
        return;
      }

      const isComputerUseRequest = COMPUTER_USE_PATTERN.test(fullMessage)
        || /\b(abre|abra).+\be\b.+(cri[ae]|faz|mont|escrev|preenche|configur|edit)/i.test(fullMessage)
        || /\b(cri[ae]|mont[ae]|faz).+planilha/i.test(fullMessage)
        || /\b(youtube|spotify).+\b(coloca|toca|play|reproduz)/i.test(fullMessage)
        || /\b(coloca|toca|play).+(youtube|spotify)/i.test(fullMessage);
      const isPureCodeTask = /\b(cri[ae]|faz|build|make|develop).+\b(site|saas|app|software|sistema|projeto|api|dashboard|landing)\b/i.test(fullMessage) && !/\b(abre|abra|open|excel|word|browser|chrome)\b/i.test(fullMessage);

      if (isComputerUseRequest && !isPureCodeTask) {
        try {
          const needsScreenshot = NEEDS_SCREENSHOT_PATTERN.test(fullMessage) || SCREEN_PATTERN.test(fullMessage);
          console.log(`[JARVIS] 🖥️ Computer Use v2 → screenshot=${needsScreenshot}`);
          const cuBody = JSON.stringify({ task: fullMessage, screenshot: needsScreenshot });
          const cuRes = await new Promise((resolve, reject) => {
            const req = http.request({ hostname: '127.0.0.1', port: PORT, path: '/api/computer-use/v2', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(cuBody) } }, (r) => {
              let data = '';
              r.on('data', c => data += c);
              r.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
            });
            req.on('error', () => resolve(null));
            req.setTimeout(45000, () => { req.destroy(); resolve(null); });
            req.write(cuBody);
            req.end();
          });
          if (cuRes && cuRes.ok) {
            const elapsed = Date.now() - t0;
            const expected = cuRes.expected || '';
            const actions = cuRes.executed || 0;
            const failed = cuRes.failed || 0;
            let summary;
            if (language === 'BR') {
              summary = `Pronto! Executei ${actions} ações em ${(elapsed/1000).toFixed(1)}s.`;
              if (expected) summary += ` ${expected}`;
              if (failed > 0) summary += ` (${failed} ação(ões) precisaram de ajuste)`;
            } else {
              summary = `Done! Executed ${actions} actions in ${(elapsed/1000).toFixed(1)}s.`;
              if (expected) summary += ` ${expected}`;
            }
            console.log(`[JARVIS] 🖥️ Computer Use v2 → ${elapsed}ms | ${actions} actions | ${failed} failed`);
            res.write(summary);
            setImmediate(() => { appendHistoryFast('user', message); appendHistoryFast('jarvis', summary); pushNotification({ type: 'build-complete', message: summary, language }); });
            try { res.end(); } catch {}
            return;
          }
        } catch (cuErr) { console.error('[JARVIS] Computer Use v2 error:', cuErr.message?.slice(0, 200)); }
      }

      const smartResult = await trySmartFastExecution(fullMessage, language);
      if (smartResult) {
        const elapsed = Date.now() - t0;
        console.log(`[JARVIS] ⚡ FAST-PATH L2 (smart) → ${elapsed}ms`);
        res.write(smartResult.summary);
        setImmediate(() => { appendHistoryFast('user', message); appendHistoryFast('jarvis', smartResult.summary); pushNotification({ type: 'build-complete', message: smartResult.summary, language }); });
        try { res.end(); } catch {}
        return;
      }

      const executorTaskType = detectTaskType(fullMessage);
      const codexWriteIntent = isCodexWriteRequestIntent(message);

      if (currentExecutorMode === 'auto' && codexWriteIntent) {
        console.log(`[JARVIS][executor] mode=auto taskType=${executorTaskType} writeConfirmation=required`);
        writeCodexWriteConfirmationResponse(res, pendingCodexWriteRequests, message, currentExecutorMode, executorTaskType);
        return;
      }

      if (currentExecutorMode === 'codex') {
        if (executorTaskType === 'file' || codexWriteIntent) {
          console.log(`[JARVIS][executor] mode=codex taskType=${executorTaskType} writeConfirmation=required`);
          writeCodexWriteConfirmationResponse(res, pendingCodexWriteRequests, message, currentExecutorMode, executorTaskType);
          return;
        }
        console.log('[JARVIS][executor] mode=codex direct=true fallbackNotice=not_applicable');
        console.log('[JARVIS][executor] provider=codex mode=codex route=/api/chat');
        await writeCodexChatResponse({ res, message, prompt: fullMessage, language, t0, fallbackUsed: false, taskType: executorTaskType, JARVIS_DIR, PROJECTS_DIR, currentExecutorMode, appendHistoryFast, storeMemory, sessionStats });
        return;
      }

      const isTask = isTaskRequest(englishMessage);
      if (currentExecutorMode === 'auto' && !isTask && (executorTaskType === 'chat' || executorTaskType === 'analysis')) {
        console.log(`[JARVIS][executor] mode=auto taskType=${executorTaskType} fastPath=preserved`);
      }

      let gptResponse = '';
      if (isTask) {
        const instantAck = generateAck(fullMessage, language);
        res.write(instantAck);
        gptResponse = instantAck;
        sessionStats.lastAckLatency = Date.now() - t0;
        console.log(`[JARVIS] ⚡ Instant ACK → ${sessionStats.lastAckLatency}ms`);
        if (openai) { handleGPTChat(fullMessage, null, language, true).catch(() => {}); }
      } else {
        try {
          gptResponse = await handleGPTChat(fullMessage, res, language, false);
          sessionStats.lastAckLatency = Date.now() - t0;
          console.log(`[JARVIS] ⚡ GPT-4o-mini → ${sessionStats.lastAckLatency}ms`);
        } catch (gptErr) {
          console.error('[JARVIS] GPT-mini error:', gptErr.message);
          const fallback = language === 'BR' ? 'Estou aqui.' : 'I\'m here.';
          res.write(fallback);
          gptResponse = fallback;
        }
        setImmediate(() => { appendHistoryFast('user', message); appendHistoryFast('jarvis', gptResponse); storeMemory(message, gptResponse).catch(() => {}); });
        try { res.end(); } catch {}
        return;
      }

      const parallelTasks = detectParallelTasks(fullMessage);
      if (parallelTasks && parallelTasks.length > 1) {
        res.write('\n[build-start]\n');
        res.write(`[info] Executando ${parallelTasks.length} tarefas em paralelo...\n`);
        console.log(`[JARVIS] ⚡ PARALLEL: ${parallelTasks.length} tasks detected`);
        const semanticCtx = await findRelevantMemories(englishMessage);
        let allResults = '';
        await Promise.all(parallelTasks.map((task, idx) => new Promise((resolve) => {
          const taskModel = selectModelByComplexity(task);
          const taskProc = acquireWithFallback(taskModel);
          if (!taskProc) { resolve(); return; }
          const taskPrompt = buildJarvisPrompt(task, semanticCtx, false, language, taskModel, conclaveEnabled);
          taskProc.stdin.write(taskPrompt);
          taskProc.stdin.end();
          let buf = '';
          const timer = setTimeout(() => { try { taskProc.kill(); } catch {} resolve(); }, 120000);
          taskProc.stdout.on('data', d => { const chunk = d.toString(); buf += chunk; try { res.write(`[task-${idx + 1}] ${chunk}`); } catch {} });
          taskProc.on('close', () => { clearTimeout(timer); allResults += buf; resolve(); });
          taskProc.on('error', () => { clearTimeout(timer); resolve(); });
        })));
        setImmediate(() => { appendHistoryFast('user', message); appendHistoryFast('jarvis', allResults.slice(-500)); storeMemory(message, allResults.slice(-500)).catch(() => {}); notifyBuildComplete(message, allResults, language); });
        try { res.end(); } catch {}
        return;
      }

      res.write('\n[build-start]\n');

      const isScreenQuery = /\b(tela|monitor|screen|olh[aeo]|vej[ao]|mostr[ae]|v[eê]|see|look|what.*screen|o que.*tela|o que.*monitor|consegue.*ver|can.*see)\b/i.test(fullMessage);
      let screenContext = '';
      if (isScreenQuery) {
        try {
          console.log('[JARVIS] Auto-screenshot for screen query...');
          const { execSync } = await import('child_process');
          const scriptPath = path.join(JARVIS_DIR, 'system', 'screenshot.py');
          const ssResult = execSync(`"${PYTHON_CMD}" "${scriptPath}" all`, { encoding: 'utf-8', timeout: 10000, maxBuffer: 30 * 1024 * 1024 });
          const ssData = JSON.parse(ssResult.trim());
          const tmpImg = path.join(JARVIS_DIR, 'system', `_screen_${Date.now()}.jpg`);
          const imgBuffer = Buffer.from(ssData.data.split(',')[1], 'base64');
          fs.writeFileSync(tmpImg, imgBuffer);
          screenContext = `\n\n[SCREENSHOT CAPTURED: ${tmpImg}]\nThe user is asking about their screen. A screenshot has been saved at the path above. Use the --file flag or describe what you would see. Monitors: ${ssData.monitors || 1}. Resolution: ${ssData.width}x${ssData.height}.\nAnalyze the screenshot and describe what you see to the user.`;
          setTimeout(() => { try { fs.unlinkSync(tmpImg); } catch {} }, 30000);
        } catch (e) { console.error('[JARVIS] Auto-screenshot failed:', e.message); }
      }

      if (!deps.claudeCliAvailable) {
        if (currentExecutorMode === 'auto') {
          console.log(`[JARVIS][executor] mode=auto taskType=${executorTaskType} provider=claude status=checking`);
          console.log(`[JARVIS][executor] mode=auto taskType=${executorTaskType} fallback=codex reason=claude_error`);
          console.log('[JARVIS][executor] provider=codex route=/api/chat fallbackUsed=true');
          if (executorTaskType === 'file' || codexWriteIntent) {
            console.log(`[JARVIS][executor] mode=auto taskType=${executorTaskType} writeConfirmation=required`);
            writeCodexWriteConfirmationResponse(res, pendingCodexWriteRequests, message, currentExecutorMode, executorTaskType);
            return;
          }
          await writeCodexChatResponse({ res, message, prompt: fullMessage, language, t0, fallbackUsed: true, fallbackReason: classifyExecutorError(deps.claudeCliError || 'claude_error'), taskType: executorTaskType, JARVIS_DIR, PROJECTS_DIR, currentExecutorMode, appendHistoryFast, storeMemory, sessionStats });
          return;
        }
        const errorMsg = { BR: `[error] Sistema de execução temporariamente indisponível: ${deps.claudeCliError}.`, ES: `[error] Sistema de ejecución temporalmente no disponible: ${deps.claudeCliError}.`, EN: `[error] Execution system temporarily unavailable: ${deps.claudeCliError}.` };
        const errText = errorMsg[language] || errorMsg.BR;
        console.error(`[JARVIS] ❌ Task rejected — execution unavailable: ${deps.claudeCliError}`);
        try { res.write(errText); res.end(); } catch {}
        pushNotification({ type: 'build-complete', message: language === 'BR' ? 'Senhor, meu sistema de execução não está configurado nesta máquina.' : 'Sir, my execution system is not configured on this machine.', language });
        return;
      }

      const semanticContext = await findRelevantMemories(englishMessage);
      const metaContext = '';
      const model = selectModelByComplexity(englishMessage);
      if (currentExecutorMode === 'claude') console.log('[JARVIS][executor] mode=claude fallback=disabled');
      if (currentExecutorMode === 'auto') console.log(`[JARVIS][executor] mode=auto taskType=${executorTaskType} provider=claude status=checking`);
      const proc = acquireTaskProc({ model }) || acquireWithFallback(model);

      if (!proc) {
        console.error('[JARVIS] ❌ All pools exhausted, cold spawn failed');
        if (currentExecutorMode === 'auto') {
          console.log(`[JARVIS][executor] mode=auto taskType=${executorTaskType} fallback=codex reason=process_error`);
          console.log('[JARVIS][executor] provider=codex route=/api/chat fallbackUsed=true');
          if (executorTaskType === 'file' || codexWriteIntent) {
            console.log(`[JARVIS][executor] mode=auto taskType=${executorTaskType} writeConfirmation=required`);
            writeCodexWriteConfirmationResponse(res, pendingCodexWriteRequests, message, currentExecutorMode, executorTaskType);
            return;
          }
          await writeCodexChatResponse({ res, message, prompt: fullMessage, language, t0, fallbackUsed: true, fallbackReason: 'process_error', taskType: executorTaskType, JARVIS_DIR, PROJECTS_DIR, currentExecutorMode, appendHistoryFast, storeMemory, sessionStats });
          return;
        }
        try { res.write('[error] Sistema sobrecarregado no momento. Tente novamente.'); res.end(); } catch {}
        return;
      }

      const prompt = buildJarvisPrompt(fullMessage, semanticContext + metaContext + screenContext, false, language, model, conclaveEnabled);
      proc.stdin.write(prompt);
      proc.stdin.end();

      let clientAlive = true;
      let killedByTimeout = false;
      const killTimer = setTimeout(() => { killedByTimeout = true; try { proc.kill(); } catch {} }, 300000);
      req.on('close', () => { clientAlive = false; });

      let responseBuffer = '';
      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        responseBuffer += chunk;
        if (clientAlive) { try { res.write(chunk); } catch {} }
      });
      proc.stderr.on('data', (data) => {
        const msg = data.toString();
        if (msg.trim()) console.error('[JARVIS stderr]', msg);
      });
      proc.on('close', async (code) => {
        clearTimeout(killTimer);
        const elapsed = Date.now() - t0;
        sessionStats.tokensOut += Math.ceil(responseBuffer.length / 4);
        sessionStats.lastLatency = elapsed;

        if (!responseBuffer.trim() && (code !== 0 || killedByTimeout)) {
          if (currentExecutorMode === 'auto' && clientAlive) {
            const fallbackReason = killedByTimeout ? 'timeout' : classifyExecutorError(`process exited with code ${code}`);
            console.log(`[JARVIS][executor] mode=auto taskType=${executorTaskType} fallback=codex reason=${fallbackReason}`);
            console.log('[JARVIS][executor] provider=codex route=/api/chat fallbackUsed=true');
            if (executorTaskType === 'file' || codexWriteIntent) {
              console.log(`[JARVIS][executor] mode=auto taskType=${executorTaskType} writeConfirmation=required`);
              writeCodexWriteConfirmationResponse(res, pendingCodexWriteRequests, message, currentExecutorMode, executorTaskType);
              return;
            }
            await writeCodexChatResponse({ res, message, prompt: fullMessage, language, t0, fallbackUsed: true, fallbackReason, taskType: executorTaskType, JARVIS_DIR, PROJECTS_DIR, currentExecutorMode, appendHistoryFast, storeMemory, sessionStats });
            return;
          }
          console.error(`[JARVIS] ❌ Execução saiu com code ${code} e sem output`);
          const failMsg = language === 'BR' ? 'Senhor, encontrei uma instabilidade processando essa tarefa.' : 'Sir, I encountered an instability processing this task.';
          pushNotification({ type: 'build-complete', message: failMsg, language });
          if (clientAlive) { try { res.write(`[error] Execução interrompida (code=${code})`); } catch {} }
        } else {
          console.log(`[JARVIS] ⚡ ${model.includes('opus')?'Opus':model.includes('sonnet')?'Sonnet':'Haiku'} → ${elapsed}ms`);
          setImmediate(() => {
            appendHistoryFast('user', message);
            appendHistoryFast('jarvis', responseBuffer);
            storeMemory(message, responseBuffer).catch(() => {});
            updateProjectStatus(message, responseBuffer).catch(() => {});
            const fileMatches = responseBuffer.match(/\[file\]\s*([^\n|]+)/g);
            deps._lastAction = { task: message, result: responseBuffer.slice(-800), time: Date.now(), files: fileMatches ? fileMatches.map(f => f.replace('[file]', '').trim()) : [] };
            notifyBuildComplete(message, responseBuffer, language);
          });
        }
        if (clientAlive) { try { res.end(); } catch {} }
      });
      proc.on('error', async (err) => {
        clearTimeout(killTimer);
        console.error('[JARVIS] ❌ Spawn error:', err.message);
        if (currentExecutorMode === 'auto' && clientAlive) {
          const fallbackReason = classifyExecutorError(err);
          console.log(`[JARVIS][executor] mode=auto taskType=${executorTaskType} fallback=codex reason=${fallbackReason}`);
          if (executorTaskType === 'file' || codexWriteIntent) {
            writeCodexWriteConfirmationResponse(res, pendingCodexWriteRequests, message, currentExecutorMode, executorTaskType);
            return;
          }
          await writeCodexChatResponse({ res, message, prompt: fullMessage, language, t0, fallbackUsed: true, fallbackReason, taskType: executorTaskType, JARVIS_DIR, PROJECTS_DIR, currentExecutorMode, appendHistoryFast, storeMemory, sessionStats });
          return;
        }
        const spawnErrMsg = language === 'BR' ? `Senhor, não consegui executar: ${err.message}` : `Sir, execution failed: ${err.message}`;
        pushNotification({ type: 'build-complete', message: spawnErrMsg, language });
        if (clientAlive) { try { res.write(`[error] Erro de execução: ${err.message}`); res.end(); } catch {} }
      });

    } catch (err) {
      console.error('[JARVIS] Chat error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── /api/executor/* ────────────────────────────────────────────────────────

  app.get('/api/executor/mode', (req, res) => {
    res.json({ mode: currentExecutorMode, validModes: VALID_EXECUTOR_MODES });
  });

  app.post('/api/executor/mode', (req, res) => {
    const requestedMode = String(req.body?.mode || '').trim().toLowerCase();
    if (!VALID_EXECUTOR_MODES.includes(requestedMode)) {
      return res.status(400).json({ ok: false, error: 'Modo inválido', validModes: VALID_EXECUTOR_MODES });
    }
    currentExecutorMode = requestedMode;
    executorState.currentExecutorMode = currentExecutorMode;
    res.json({ ok: true, mode: currentExecutorMode });
  });

  app.post('/api/executor/dry-run', (req, res) => {
    const normalizedMode = normalizeExecutorMode(req.body?.mode || currentExecutorMode);
    const detectedTaskType = req.body?.taskType ? normalizeExecutorTaskType(req.body.taskType) : detectTaskType(req.body?.prompt || '');
    const selectedProvider = selectDryRunProvider(normalizedMode, detectedTaskType);
    let providerResult;
    if (selectedProvider === 'codex') providerResult = executeWithCodexDryRun({ prompt: req.body?.prompt || '', cwd: JARVIS_DIR });
    else if (selectedProvider === 'openai') providerResult = executeWithOpenAIDryRun({ prompt: req.body?.prompt, openai });
    else providerResult = executeWithClaudeDryRun({ prompt: req.body?.prompt || '', cwd: JARVIS_DIR });
    res.json({ ok: true, dryRun: true, mode: normalizedMode, taskType: detectedTaskType, selectedProvider, executorMode: normalizedMode, fallbackEnabled: false, providerReady: providerResult.ok, providerStatus: providerResult, message: `Executor router dry-run: ${selectedProvider} seria usado, mas nenhuma tarefa foi executada nesta fase.` });
  });

  app.post('/api/executor/codex-test', async (req, res) => {
    try {
      const requestedTimeout = Number(req.body?.timeoutMs) || 60000;
      const result = await executeWithCodexReal({ prompt: req.body?.prompt || '', cwd: JARVIS_DIR, timeoutMs: Math.min(Math.max(requestedTimeout, 5000), 120000) });
      res.status(result.ok ? 200 : 500).json(result);
    } catch (err) {
      res.status(500).json(createExecutorResult({ ok: false, provider: 'codex', output: '', errorType: classifyExecutorError(err), rawError: err.message || String(err), fallbackUsed: false, fallbackReason: null }));
    }
  });

  app.get('/api/executor/codex-write-pending', (req, res) => {
    const items = listPendingCodexWriteRequests(pendingCodexWriteRequests);
    res.json({ ok: true, count: items.length, items });
  });

  app.post('/api/executor/codex-write-test', async (req, res) => {
    try {
      const requestedTimeout = Number(req.body?.timeoutMs) || 120000;
      const result = await executeWithCodexWriteTest(PROJECTS_DIR, { filename: req.body?.filename || 'TESTE-CODEX-WRITE.txt', content: req.body?.content ?? 'Arquivo criado pelo Codex via Jarvis em modo write controlado.', timeoutMs: Math.min(Math.max(requestedTimeout, 10000), 180000) });
      res.status(result.ok ? 200 : (result.errorType === 'invalid_filename' ? 400 : 500)).json(result);
    } catch (err) {
      res.status(500).json(createCodexWriteError({ errorType: classifyExecutorError(err), message: 'Erro inesperado no Codex write test', rawError: err.message || String(err) }));
    }
  });

  app.post('/api/executor/excel-template-test', async (req, res) => {
    try {
      const requestedTemplate = String(req.body?.template || 'generico').trim().toLowerCase();
      const template = SPREADSHEET_TEMPLATES[requestedTemplate] ? requestedTemplate : 'generico';
      const result = await createSpreadsheetFromRequest({ filename: req.body?.filename || safeWorkbookName(`${template} template`), template, sampleRows: req.body?.sampleRows !== false, openFile: req.body?.openFile === true }, req.body?.language || 'BR');
      res.status(result.ok ? 200 : (result.errorType === 'invalid_filename' || result.errorType === 'invalid_path' ? 400 : 500)).json(result);
    } catch (err) {
      res.status(500).json({ ok: false, errorType: classifyExecutorError(err), message: 'Erro inesperado no excel-template-test', rawError: err.message || String(err) });
    }
  });
}
