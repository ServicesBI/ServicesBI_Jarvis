import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import os from 'os';
import { spawn, execSync, spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import OpenAI, { toFile } from 'openai';
import puppeteer from 'puppeteer';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Global error handlers — prevent server crashes
process.on('uncaughtException', (err) => {
  console.error('[JARVIS] UNCAUGHT EXCEPTION:', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[JARVIS] UNHANDLED REJECTION:', reason);
});

const app = express();
const PORT = process.env.PORT || 3000;
const JARVIS_DIR = __dirname;
const PROJECTS_DIR = path.join(JARVIS_DIR, 'Documents and Projects');
const SYSTEM_DIR = path.join(JARVIS_DIR, 'system');
const MEMORY_FILE = path.join(SYSTEM_DIR, 'JARVIS-MEMORY.md');
const HISTORY_FILE = path.join(SYSTEM_DIR, 'JARVIS-HISTORY.json');
const EMBEDDINGS_FILE = path.join(SYSTEM_DIR, 'memory-embeddings.json');
const MAX_HISTORY = 20;
const MAX_EMBEDDINGS = 2000;

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// ========== RATE LIMITER — Prevent 429 errors ==========
const _rateLimiter = { lastCall: 0, minInterval: 500 }; // min 500ms between OpenAI calls

async function rateLimitedOpenAI(fn) {
  const now = Date.now();
  const wait = Math.max(0, _rateLimiter.minInterval - (now - _rateLimiter.lastCall));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _rateLimiter.lastCall = Date.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if ((err?.status === 429 || err?.message?.includes('429')) && attempt < 2) {
        const delay = (attempt + 1) * 3000;
        console.warn(`[JARVIS] Rate limited (429). Retry ${attempt+1}/2 in ${delay/1000}s...`);
        await new Promise(r => setTimeout(r, delay));
        _rateLimiter.lastCall = Date.now();
        continue;
      }
      throw err;
    }
  }
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const pendingSpawns = new Map();
const attachments = new Map();

// ── Context tracking: last actions for follow-up commands ──
let _lastAction = { task: '', result: '', time: 0, files: [] };

// ========== CLAUDE CLI HEALTH CHECK ==========
// Non-blocking: checks CLI exists synchronously (fast), defers auth check.
let claudeCliAvailable = false;
let claudeCliChecking = true;
let claudeCliError = '';

// Procura o binario do Claude CLI com QUINTUPLO CHECK:
// 0. Via .env (CLAUDE_CLI_PATH) — salvo pelo instalador
// 1. Via PATH (rapido)
// 2. Via 'where claude' / 'which claude' (descobre caminho real)
// 3. Via caminhos conhecidos hardcoded (npm + native installer + Program Files)
// 4. Busca recursiva em AppData\Local\Programs (fallback final)
function findClaudeCli() {
  // Estrategia 0: caminho salvo no .env pelo instalador
  if (process.env.CLAUDE_CLI_PATH && fs.existsSync(process.env.CLAUDE_CLI_PATH)) {
    try {
      execSync(`"${process.env.CLAUDE_CLI_PATH}" --version`, { stdio: 'pipe', timeout: 5000, shell: true });
      console.log(`[JARVIS] Claude CLI encontrado via .env: ${process.env.CLAUDE_CLI_PATH}`);
      return process.env.CLAUDE_CLI_PATH;
    } catch {}
  }

  // Estrategia 1: PATH direto
  try {
    execSync('claude --version', { stdio: 'pipe', timeout: 5000, shell: true });
    console.log('[JARVIS] Claude CLI encontrado via PATH');
    return 'claude';
  } catch {}

  // Estrategia 2: where/which (descobre caminho real mesmo se o Electron tiver PATH reduzido)
  try {
    const cmd = process.platform === 'win32' ? 'where claude' : 'which claude';
    const result = execSync(cmd, { encoding: 'utf-8', timeout: 5000, shell: true });
    const paths = result.split('\n').map(p => p.trim()).filter(Boolean);
    for (const p of paths) {
      if (fs.existsSync(p)) {
        try {
          execSync(`"${p}" --version`, { stdio: 'pipe', timeout: 5000, shell: true });
          console.log(`[JARVIS] Claude CLI encontrado via where: ${p}`);
          return p;
        } catch {}
      }
    }
  } catch {}

  // Estrategia 3: caminhos conhecidos
  const HOME = os.homedir();
  const candidates = [
    // Native installer (novo — Claude Code v2.1+)
    path.join(HOME, '.local', 'bin', 'claude.exe'),
    path.join(HOME, '.local', 'bin', 'claude.cmd'),
    path.join(HOME, '.local', 'bin', 'claude'),
    path.join(HOME, 'AppData', 'Local', 'Programs', 'claude-code', 'claude.exe'),
    path.join(HOME, 'AppData', 'Local', 'Programs', 'Claude', 'claude.exe'),
    path.join(HOME, 'AppData', 'Local', 'Anthropic', 'Claude Code', 'claude.exe'),
    path.join(HOME, 'AppData', 'Local', 'claude-code', 'claude.exe'),
    path.join(HOME, 'AppData', 'Local', 'anthropic', 'claude-code', 'claude.exe'),
    // npm global bin (antigo)
    path.join(HOME, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
    path.join(HOME, 'AppData', 'Roaming', 'npm', 'claude.exe'),
    // Program Files
    'C:\\Program Files\\Claude Code\\claude.exe',
    'C:\\Program Files\\Claude\\claude.exe',
    'C:\\Program Files\\Anthropic\\Claude Code\\claude.exe',
    'C:\\Program Files\\nodejs\\claude.cmd',
  ];

  for (const cmd of candidates) {
    if (fs.existsSync(cmd)) {
      try {
        execSync(`"${cmd}" --version`, { stdio: 'pipe', timeout: 5000, shell: true });
        console.log(`[JARVIS] Claude CLI encontrado via candidato: ${cmd}`);
        return cmd;
      } catch {}
    }
  }

  // Estrategia 4: busca recursiva em AppData\Local\Programs
  try {
    const programsDir = path.join(HOME, 'AppData', 'Local', 'Programs');
    if (fs.existsSync(programsDir)) {
      const dirs = fs.readdirSync(programsDir);
      for (const d of dirs) {
        if (d.toLowerCase().includes('claude') || d.toLowerCase().includes('anthropic')) {
          const subDir = path.join(programsDir, d);
          try {
            const files = fs.readdirSync(subDir);
            for (const f of files) {
              if (f.toLowerCase().startsWith('claude') && (f.endsWith('.exe') || f.endsWith('.cmd'))) {
                const exePath = path.join(subDir, f);
                try {
                  execSync(`"${exePath}" --version`, { stdio: 'pipe', timeout: 5000, shell: true });
                  console.log(`[JARVIS] Claude CLI encontrado via busca: ${exePath}`);
                  return exePath;
                } catch {}
              }
            }
          } catch {}
        }
      }
    }
  } catch {}

  return null;
}

let CLAUDE_CMD = 'claude'; // Atualizado em checkClaudeCliSync()

// ========== PATCH 5 (v8.0) — Cold spawn dedicado para tarefas reais ==========
// Warm pool morre silenciosamente entre _spawn e acquire (cli.js sai com stdin vazio).
// Cold spawn nasce direto com prompt, sem janela intermediaria.
function findClaudeCliJs() {
  const HOME = os.homedir();
  const candidates = [
    path.join(HOME, 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    path.join(HOME, '.local', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    'C:\\Program Files\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}
const CLAUDE_CLI_JS = findClaudeCliJs();
if (CLAUDE_CLI_JS) console.log(`[JARVIS] Cold spawn cli.js: ${CLAUDE_CLI_JS}`);

function spawnColdProc(model = 'sonnet') {
  const modelId = model.includes('opus')
    ? 'claude-opus-4-6'
    : model.includes('haiku')
      ? 'claude-haiku-4-5-20251001'
      : 'claude-sonnet-4-6';
  const args = ['--print', '--output-format', 'text', '--model', modelId, '--dangerously-skip-permissions'];
  if (CLAUDE_CLI_JS) {
    return spawn(process.execPath, [CLAUDE_CLI_JS, ...args], { shell: false, cwd: JARVIS_DIR, windowsHide: true });
  }
  return spawn(CLAUDE_CMD, args, { shell: true, cwd: JARVIS_DIR });
}

function acquireTaskProc({ model = 'sonnet' } = {}) {
  if (!claudeCliAvailable) return null;
  return spawnColdProc(model);
}


// Localiza o Python instalado (evita o alias do Windows Store)
function findPythonExe() {
  const candidates = [
    'C:\\Program Files\\Python311\\python.exe',
    'C:\\Program Files\\Python312\\python.exe',
    'C:\\Program Files\\Python310\\python.exe',
    'C:\\Program Files (x86)\\Python311\\python.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'python.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python310', 'python.exe'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Fallback: tentar via where (evita alias do Store que redireciona)
  try {
    const result = execSync('where python', { encoding: 'utf-8', timeout: 5000, shell: true });
    const paths = result.split('\n').map(p => p.trim()).filter(Boolean);
    for (const p of paths) {
      if (p.includes('WindowsApps')) continue;
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  return 'python';
}

const PYTHON_CMD = findPythonExe();
console.log(`[JARVIS] Python em: ${PYTHON_CMD}`);

function checkClaudeCliSync() {
  const found = findClaudeCli();
  if (found) {
    CLAUDE_CMD = found;
    return true;
  }
  claudeCliError = 'Claude Code CLI not found. Install: npm install -g @anthropic-ai/claude-code';
  console.error(`[JARVIS] ❌ ${claudeCliError}`);
  return false;
}

async function checkClaudeCliAuth() {
  // Slow check: can Claude actually execute? (~5-15s) — runs AFTER server starts
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn(CLAUDE_CMD, [
        '--print', '--output-format', 'text',
        '--dangerously-skip-permissions'
      ], { shell: true, cwd: JARVIS_DIR });

      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { try { proc.kill(); } catch {} reject(new Error('timeout')); }, 60000);

      proc.stdin.write('say OK');
      proc.stdin.end();
      proc.stdout.on('data', d => { stdout += d; });
      proc.stderr.on('data', d => { stderr += d; });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 && stdout.trim().length > 0) resolve(stdout);
        else reject(new Error(stderr || `exit code ${code}`));
      });
      proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    });

    claudeCliAvailable = true;
    claudeCliError = '';
    claudeCliChecking = false;
    console.log('[JARVIS] ✅ Claude Code CLI: authenticated and working');

    // Now fill pools
    pools.opus.fill();
    pools.sonnet.fill();
    pools.haiku.fill();
    console.log(`[JARVIS] ✅ Pools filled: Opus×${pools.opus.pool.length} Sonnet×${pools.sonnet.pool.length} Haiku×${pools.haiku.pool.length}`);
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('auth') || msg.includes('login') || msg.includes('API key') || msg.includes('401')) {
      claudeCliError = 'Claude not authenticated. Run: claude (login in terminal)';
    } else if (msg.includes('permission') || msg.includes('dangerous')) {
      claudeCliError = 'Claude needs permission setup. Run: claude --dangerously-skip-permissions';
    } else if (msg === 'timeout') {
      claudeCliError = 'Claude auth check timed out (20s). May be slow or not authenticated.';
    } else {
      claudeCliError = `Claude test failed: ${msg.slice(0, 200)}`;
    }
    claudeCliAvailable = false;
    claudeCliChecking = false;
    console.error(`[JARVIS] ❌ ${claudeCliError}`);
  }
}

function checkClaudeCli() {
  // Sync wrapper for API endpoint recheck
  claudeCliChecking = true;
  const exists = checkClaudeCliSync();
  if (!exists) { claudeCliChecking = false; return false; }
  // Kick off async auth check
  checkClaudeCliAuth();
  return exists; // optimistic: CLI exists, auth pending
}

// Run fast sync check now (does CLI exist?), defer auth to after server starts
const cliExists = checkClaudeCliSync();
if (cliExists) {
  claudeCliAvailable = true; // optimistic — will be reverted if auth fails
  claudeCliChecking = true;
}

// ========== WARM POOL — Zero-latency CLI spawning ==========
// Pre-spawns claude processes so they're ready before requests arrive.
// Acquiring from pool = 0ms spawn wait. Background refill keeps pool full.
class WarmPool {
  constructor(model, size) {
    this.model = model;
    this.size = size;
    this.pool = [];
    this.spawnErrors = 0;
    // Only fill if Claude CLI is available
    if (claudeCliAvailable) this.fill();
    // Periodic cleanup: kill processes older than 90s to free PIDs
    this._cleanupInterval = setInterval(() => {
      const now = Date.now();
      const before = this.pool.length;
      this.pool = this.pool.filter(proc => {
        if (now - proc._warmSince > 90000) {
          try { proc.kill(); } catch {}
          return false;
        }
        return true;
      });
      if (before > this.pool.length) {
        console.log(`[JARVIS] [${this.model}] Cleaned ${before - this.pool.length} stale pool process(es)`);
        if (claudeCliAvailable) this.fill();
      }
    }, 30000); // Check every 30s
  }

  _spawn() {
    const proc = spawn(CLAUDE_CMD, [
      '--print', '--output-format', 'text',
      '--model', this.model,
      '--dangerously-skip-permissions'
    ], { shell: true, cwd: JARVIS_DIR });
    proc._warmSince = Date.now();
    proc._model = this.model;
    // Log stderr errors — filter expected warm-pool warnings
    proc.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (!msg) return;
      // Warm pool processes will always warn about no stdin — that's expected
      if (msg.includes('no stdin data received') || msg.includes('Input must be provided')) return;
      console.error(`[JARVIS] [${this.model}] stderr: ${msg}`);
    });
    // Track spawn failures
    proc.on('error', async (err) => {
      this.spawnErrors++;
      console.error(`[JARVIS] [${this.model}] spawn error #${this.spawnErrors}: ${err.message}`);
      if (this.spawnErrors >= 3 && claudeCliAvailable) {
        claudeCliAvailable = false;
        claudeCliError = `Claude CLI crashed ${this.spawnErrors} times. Check installation.`;
        console.error(`[JARVIS] ❌ DISABLED: Claude pools disabled after ${this.spawnErrors} spawn errors`);
      }
    });
    return proc;
  }

  fill() {
    if (!claudeCliAvailable) return;
    while (this.pool.length < this.size) {
      this.pool.push(this._spawn());
    }
  }

  // Acquire a warm process. Immediately schedule refill.
  acquire() {
    if (!claudeCliAvailable) return null;
    let proc;
    if (this.pool.length > 0) {
      proc = this.pool.shift();
      // Drop stale processes (>90s old — they may have timed out)
      if (Date.now() - proc._warmSince > 90000) {
        try { proc.kill(); } catch {}
        proc = this._spawn();
      }
    } else {
      proc = this._spawn(); // emergency cold spawn
    }
    setImmediate(() => this.fill()); // refill async
    return proc;
  }

  // Drain and refill (e.g. after model change)
  flush() {
    for (const p of this.pool) try { p.kill(); } catch {}
    this.pool = [];
    if (claudeCliAvailable) this.fill();
  }
}

// One pool per model tier — sized by expected traffic
const pools = {
  opus:   new WarmPool('claude-opus-4-6',         1),
  sonnet: new WarmPool('claude-sonnet-4-6',        3),
  haiku:  new WarmPool('claude-haiku-4-5-20251001',4),
};

function getPool(model) {
  if (model.includes('opus'))   return pools.opus;
  if (model.includes('sonnet')) return pools.sonnet;
  return pools.haiku;
}

// PATCH 12 v8.1: Haiku banido da execucao real. Cold spawn de Sonnet como ultimo recurso.
function acquireWithFallback(model) {
  const tierOrder = model.includes('opus')
    ? [pools.opus, pools.sonnet]
    : [pools.sonnet];

  for (const pool of tierOrder) {
    const proc = pool.acquire();
    if (proc) {
      if (pool !== tierOrder[0]) {
        console.log(`[JARVIS] Pool fallback: ${model} → ${pool.model}`);
      }
      return proc;
    }
  }
  // Last resort: cold spawn Sonnet (Haiku ignora Write tool)
  console.warn('[JARVIS] Pools exhausted — cold spawning Sonnet');
  return spawnColdProc('sonnet');
}

// ========== POOL AUTO-RECOVERY — Re-enable CLI after transient failures ==========
// Every 60s, if CLI was disabled by spawn errors, try a test spawn to re-enable
setInterval(() => {
  if (claudeCliAvailable) return; // already healthy
  try {
    const testProc = require('child_process').spawnSync(CLAUDE_CMD, ['--version'], {
      shell: true, timeout: 10000, encoding: 'utf-8'
    });
    if (testProc.status === 0 && testProc.stdout && testProc.stdout.trim().length > 0) {
      console.log('[JARVIS] ✅ Pool auto-recovery: Claude CLI is back — re-enabling pools');
      claudeCliAvailable = true;
      claudeCliError = '';
      pools.opus.spawnErrors = 0;
      pools.sonnet.spawnErrors = 0;
      pools.haiku.spawnErrors = 0;
      pools.opus.fill();
      pools.sonnet.fill();
      pools.haiku.fill();
    }
  } catch {}
}, 60000);

// ========== IN-MEMORY CACHE — Avoid disk reads on every request ==========
const _cache = {
  memory: { value: '', mtime: 0 },
  history: { value: [], dirty: false },
};

function loadMemoryCached() {
  try {
    const stat = fs.statSync(MEMORY_FILE);
    if (stat.mtimeMs !== _cache.memory.mtime) {
      _cache.memory.value = fs.readFileSync(MEMORY_FILE, 'utf-8');
      _cache.memory.mtime = stat.mtimeMs;
    }
  } catch { _cache.memory.value = ''; }
  return _cache.memory.value;
}

function loadHistoryCached() {
  if (_cache.history.dirty) {
    _cache.history.value = loadHistory();
    _cache.history.dirty = false;
  }
  return _cache.history.value;
}

// Write lock to prevent concurrent read-modify-write race conditions on history file
let _historyWriteLock = false;
const _historyWriteQueue = [];

function _flushHistoryQueue() {
  if (_historyWriteLock || _historyWriteQueue.length === 0) return;
  _historyWriteLock = true;
  try {
    const exchanges = loadHistory();
    // Drain all queued entries in one batch write
    while (_historyWriteQueue.length > 0) {
      exchanges.push(_historyWriteQueue.shift());
    }
    if (exchanges.length > MAX_HISTORY * 2) {
      const overflow = exchanges.splice(0, exchanges.length - MAX_HISTORY * 2);
      compactToMemory(overflow);
    }
    saveHistory(exchanges);
    _cache.history.dirty = true;
  } finally {
    _historyWriteLock = false;
  }
  // If more entries arrived while we were writing, flush again
  if (_historyWriteQueue.length > 0) setImmediate(_flushHistoryQueue);
}

function appendHistoryFast(role, content) {
  _historyWriteQueue.push({ role, content: content.slice(0, 2000), ts: new Date().toISOString() });
  if (!_historyWriteLock) _flushHistoryQueue();
}

// Compact overflow history into JARVIS-MEMORY.md as a summary section
// This preserves all context permanently without bloating the active prompt
function compactToMemory(entries) {
  try {
    const summary = entries.map(e => `  [${e.ts?.slice(0,10)||''}][${e.role}] ${e.content.slice(0,300)}`).join('\n');
    const block = `\n## Archived History (${new Date().toISOString().slice(0,10)})\n${summary}\n`;
    fs.appendFileSync(MEMORY_FILE, block);
    _cache.memory.mtime = 0; // invalidate memory cache
    compactMemoryIfNeeded(); // OPT-1: prevent unbounded growth
  } catch {}
}

// OPT-1: Cap JARVIS-MEMORY.md growth — if over 10KB, summarize oldest 50% via GPT-4o-mini
async function compactMemoryIfNeeded() {
  try {
    const stats = fs.statSync(MEMORY_FILE);
    if (stats.size <= 10 * 1024) return; // under 10KB, nothing to do

    const content = fs.readFileSync(MEMORY_FILE, 'utf-8');
    const lines = content.split('\n');
    const half = Math.floor(lines.length / 2);
    const oldHalf = lines.slice(0, half).join('\n');
    const newHalf = lines.slice(half).join('\n');

    if (!openai) {
      // No OpenAI key — hard-truncate: keep only the newer half with a marker
      const truncated = `## [Auto-compacted ${new Date().toISOString().slice(0,10)} — older entries removed, no summarizer available]\n\n${newHalf}`;
      fs.writeFileSync(MEMORY_FILE, truncated);
      _cache.memory.mtime = 0;
      console.log('[JARVIS] Memory compacted (truncated, no OpenAI for summary)');
      return;
    }

    // Use GPT-4o-mini to summarize the oldest 50%
    const res = await rateLimitedOpenAI(() =>
      openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'Summarize the following JARVIS memory entries into a single compact paragraph. Preserve key facts, user preferences, project names, and important decisions. Drop redundant or trivial entries. Max 300 words.'
          },
          { role: 'user', content: oldHalf.slice(0, 8000) }
        ],
        max_tokens: 400,
        temperature: 0
      })
    );

    const summaryText = res.choices[0]?.message?.content?.trim();
    if (!summaryText) return;

    const compacted = `## Compacted Memory (${new Date().toISOString().slice(0,10)})\n${summaryText}\n\n${newHalf}`;
    fs.writeFileSync(MEMORY_FILE, compacted);
    _cache.memory.mtime = 0;
    console.log('[JARVIS] Memory compacted via GPT-4o-mini (was ' + (stats.size / 1024).toFixed(1) + 'KB)');
  } catch (err) {
    console.error('[JARVIS] Memory compaction error:', err.message);
  }
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ========== CHROME DETECTION (OPT-2: cached) ==========
let _cachedChromePath = undefined; // undefined = not checked yet, null = not found
function findChrome() {
  if (_cachedChromePath !== undefined) return _cachedChromePath;
  const paths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/usr/bin/google-chrome',
    '/usr/lib/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ];
  for (const p of paths) {
    try { if (fs.existsSync(p)) { _cachedChromePath = p; return p; } } catch {}
  }
  _cachedChromePath = null;
  return null;
}

// ========== HTML TO PDF ==========
async function htmlToPdf(htmlPath, pdfPath) {
  const chromePath = findChrome();
  const launchOpts = {
    headless: true,
    pipe: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-setuid-sandbox']
  };
  if (chromePath) launchOpts.executablePath = chromePath;

  const browser = await puppeteer.launch(launchOpts);
  try {
    const page = await browser.newPage();
    await page.goto(`file:///${htmlPath.replace(/\\/g, '/')}`, { waitUntil: 'networkidle0' });
    await page.pdf({ path: pdfPath, format: 'A4', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  } finally {
    await browser.close();
  }
}

// ========== PERSISTENT MEMORY ==========
function loadMemory() {
  try { return fs.readFileSync(MEMORY_FILE, 'utf-8'); } catch { return ''; }
}

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8')); } catch { return []; }
}

function saveHistory(exchanges) {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(exchanges, null, 2)); } catch {}
}

// OPT-3: appendHistory() removed — all callers use appendHistoryFast() which includes overflow compaction

// Adaptive history window — voice=6 entries, text=16 entries (fast), task=32
// Older entries are summarized into JARVIS-MEMORY on overflow, never deleted
function formatHistoryForPrompt(exchanges, isVoice = false, isTask = false) {
  const window = isVoice ? 6 : (isTask ? 32 : 16);
  return exchanges.slice(-window).map(e =>
    `[${e.role}] ${e.content}`
  ).join('\n');
}

// ========== SEMANTIC MEMORY (EMBEDDINGS) — cached in memory ==========
let _embeddingsCache = null;
let _embeddingsCacheMtime = 0;

function loadEmbeddings() {
  try {
    const stat = fs.statSync(EMBEDDINGS_FILE);
    if (_embeddingsCache && stat.mtimeMs === _embeddingsCacheMtime) return _embeddingsCache;
    _embeddingsCache = JSON.parse(fs.readFileSync(EMBEDDINGS_FILE, 'utf-8'));
    _embeddingsCacheMtime = stat.mtimeMs;
    return _embeddingsCache;
  } catch { return []; }
}

function saveEmbeddings(entries) {
  try {
    fs.writeFileSync(EMBEDDINGS_FILE, JSON.stringify(entries));
    _embeddingsCache = entries; // update cache immediately
    _embeddingsCacheMtime = Date.now();
  } catch {}
}

function cosineSimilar(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

async function embed(text) {
  if (!openai) return null;
  return rateLimitedOpenAI(async () => {
    const res = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text.slice(0, 5000)
    });
    return res.data[0].embedding;
  });
}

// ========== RAG MEMORY SYSTEM — Long-term categorized memory ==========
const MEMORY_CATEGORIES = ['conversation', 'project', 'preference', 'decision', 'skill', 'fact'];

function categorizeMemory(userMsg, jarvisReply) {
  const combined = (userMsg + ' ' + jarvisReply).toLowerCase();
  if (/prefer|gosto|sempre|nunca|modo|estilo|formato|tom|voice|idioma/i.test(combined)) return 'preference';
  if (/decid|escolh|optei|vamos com|confirmo|aprovado|go with/i.test(combined)) return 'decision';
  if (/projeto|project|criou|deploy|site|app|saas|planilha|pdf|apresenta/i.test(combined)) return 'project';
  if (/aprendi|descobri|lembr|importante|anotar|salvar|memoriz/i.test(combined)) return 'fact';
  if (/como fazer|tutorial|passo|instrução|configur|instalar/i.test(combined)) return 'skill';
  return 'conversation';
}

function chunkText(text, maxChunk = 800) {
  if (text.length <= maxChunk) return [text];
  const chunks = [];
  const sentences = text.split(/[.!?\n]+/);
  let current = '';
  for (const s of sentences) {
    if ((current + s).length > maxChunk && current) {
      chunks.push(current.trim());
      current = s;
    } else {
      current += (current ? '. ' : '') + s;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

async function storeMemory(userMsg, jarvisReply) {
  try {
    if (!openai) return;
    const category = categorizeMemory(userMsg, jarvisReply);
    const fullText = `User: ${userMsg}\nJARVIS: ${jarvisReply}`;
    const chunks = chunkText(fullText);

    const entries = loadEmbeddings();

    for (const chunk of chunks) {
      const embedding = await embed(chunk);
      if (!embedding) continue;
      entries.push({
        text: chunk.slice(0, 1200),
        category,
        embedding,
        ts: new Date().toISOString(),
        tokens: Math.ceil(chunk.length / 4)
      });
    }

    // Prune: keep max entries, remove oldest conversations first (preserve preferences/decisions longer)
    if (entries.length > MAX_EMBEDDINGS) {
      const important = entries.filter(e => ['preference', 'decision', 'project'].includes(e.category));
      const regular = entries.filter(e => !['preference', 'decision', 'project'].includes(e.category));
      // Remove oldest regular entries first
      while (important.length + regular.length > MAX_EMBEDDINGS && regular.length > 0) {
        regular.shift();
      }
      saveEmbeddings([...regular, ...important]);
    } else {
      saveEmbeddings(entries);
    }
  } catch (e) {
    console.error('[JARVIS] Memory store error:', e.message);
  }
}

async function findRelevantMemories(query, topK = 5) {
  try {
    if (!openai) return '';
    const queryEmb = await Promise.race([
      embed(query),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000))
    ]);
    if (!queryEmb) return '';
    const entries = loadEmbeddings();
    const now = Date.now();

    const scored = entries.map(e => {
      const similarity = cosineSimilar(queryEmb, e.embedding);
      // Boost recent entries (decay over 30 days)
      const age = (now - new Date(e.ts).getTime()) / (1000 * 60 * 60 * 24);
      const recencyBoost = Math.max(0, 0.1 * (1 - age / 30));
      // Boost important categories
      const categoryBoost = ['preference', 'decision'].includes(e.category) ? 0.05 : 0;
      return { ...e, score: similarity + recencyBoost + categoryBoost };
    })
      .sort((a, b) => b.score - a.score)
      .filter(e => e.score > 0.68)
      .slice(0, topK);

    if (scored.length === 0) return '';
    return scored.map(e => `[${e.category}|${new Date(e.ts).toLocaleDateString()}] ${e.text.slice(0, 600)}`).join('\n---\n');
  } catch { return ''; }
}

// ========== PROJECT CONTEXT ==========
function loadProjectContext() {
  try {
    const projects = fs.readdirSync(PROJECTS_DIR);
    for (const p of projects) {
      const ctxPath = path.join(PROJECTS_DIR, p, 'CONTEXT.md');
      if (fs.existsSync(ctxPath)) return fs.readFileSync(ctxPath, 'utf-8');
    }
    return '';
  } catch { return ''; }
}

// ========== MODEL ROUTING — Agent × Complexity Matrix ==========
// Each agent maps to its optimal model. Message content refines the choice.

const AGENT_MODEL_MAP = {
  // OPUS 4.7 — Highest reasoning, architecture, orchestration
  'architect':           'claude-opus-4-6',
  'aios-master':         'claude-opus-4-6',
  'conclave-critico':    'claude-opus-4-6',
  'conclave-advogado':   'claude-opus-4-6',
  'conclave-sintetizador': 'claude-opus-4-6',
  'data-engineer':       'claude-opus-4-6',
  'devops':              'claude-opus-4-6',

  // SONNET 4.6 — Balanced: code, UX, product, research
  'dev':      'claude-sonnet-4-6',
  'ux':       'claude-sonnet-4-6',
  'pm':       'claude-sonnet-4-6',
  'po':       'claude-sonnet-4-6',
  'analyst':  'claude-sonnet-4-6',
  'qa':       'claude-sonnet-4-6',

  // PATCH 12 v8.1: 'sm' tambem usa Sonnet (Haiku banido como executor)
  'sm':       'claude-sonnet-4-6',
};

function detectAgent(message) {
  // Detect explicit @agent mention
  const match = message.match(/@([\w-]+)/);
  if (match) return match[1].toLowerCase();

  // Detect implicit agent from keywords
  const lower = message.toLowerCase();
  if (/\b(arquitetura|architecture|system design|stack|padrão|pattern|decisão técnica)\b/i.test(lower)) return 'architect';
  if (/\b(banco|database|schema|migration|sql|query|índice|index|rls)\b/i.test(lower)) return 'data-engineer';
  if (/\b(deploy|push|ci\/cd|pipeline|release|infraestrutura)\b/i.test(lower)) return 'devops';
  if (/\b(conclave|delibera|critique|critique|worst.case|attack)\b/i.test(lower)) return 'conclave-critico';
  if (/\b(ui|ux|interface|design|layout|componente|component|wireframe)\b/i.test(lower)) return 'ux';
  if (/\b(epic|prd|spec|requisito|requirement|roadmap)\b/i.test(lower)) return 'pm';
  if (/\b(story|história|backlog|prioridade|aceite)\b/i.test(lower)) return 'po';
  if (/\b(teste|test|bug|qualidade|quality|coverage)\b/i.test(lower)) return 'qa';
  if (/\b(pesquisa|research|analise|dados|data|relatório|report)\b/i.test(lower)) return 'analyst';
  return null;
}

function selectModelByComplexity(message) {
  const lower = message.toLowerCase();

  // 0. Explicit model override — user can force any model
  if (/\bopus\b/i.test(lower))  return 'claude-opus-4-6';
  if (/\bsonnet\b/i.test(lower)) return 'claude-sonnet-4-6';
  if (/\bhaiku\b/i.test(lower))  return 'claude-haiku-4-5-20251001';

  // 1. Agent-based routing — any agent can be used with any model
  //    Default mapping below is optimal, but not a restriction
  const agent = detectAgent(message);
  if (agent && AGENT_MODEL_MAP[agent]) return AGENT_MODEL_MAP[agent];

  // 2. Complexity-based routing (fallback)
  if (/\b(architect|redesign|refactor|infrastructure|migration|deploy|scale|system design|e-?book|full system|complete|advanced|complex|comprehensive|deep analysis|entire|production|enterprise|conclave|delibera|schema|database|migration)\b/i.test(lower))
    return 'claude-opus-4-6';

  if (/\b(create|generate|build|make|write|produce|design|implement|develop|fix|update|modify|analyze|report|presentation|website|app|pdf|document|code|script|html|css|cria|crie|gere|construa|faça|escreva|implemente|corrija)\b/i.test(lower))
    return 'claude-sonnet-4-6';

  // PATCH 12 v8.1: default Sonnet (Haiku ignora Write tool, nunca cria arquivos)
  return 'claude-sonnet-4-6';
}

// Expose detected agent for prompt enrichment
function getAgentContext(message) {
  const agent = detectAgent(message);
  if (!agent) return '';
  const contexts = {
    'architect':    'You are operating as @architect (Aria). Focus on system design, technology decisions, scalability, and architectural patterns.',
    'dev':          'You are operating as @dev (Dex). Write clean, production-ready code. Execute and deliver immediately.',
    'qa':           'You are operating as @qa (Quinn). Find bugs, validate logic, write test cases. Be rigorous.',
    'devops':       'You are operating as @devops (Gage). Handle deployment, infrastructure, CI/CD. You have exclusive authority over git push and PRs.',
    'pm':           'You are operating as @pm (Morgan). Create structured specs, epics, and requirements. Be precise and complete.',
    'po':           'You are operating as @po (Pax). Validate requirements, prioritize backlog, define acceptance criteria.',
    'sm':           'You are operating as @sm (River). Create user stories from epics using the standard template.',
    'data-engineer':'You are operating as @data-engineer (Dara). Design schemas, write migrations, optimize queries.',
    'analyst':      'You are operating as @analyst. Research thoroughly, analyze data, produce clear reports with findings.',
    'ux':           'You are operating as @ux-design-expert. Design world-class interfaces following 2026 design systems.',
    'aios-master':  'You are operating as @aios-master (Orion). Orchestrate the full team. Execute any task directly. No restrictions.',
    'conclave-critico':    'You are the Crítico Metodológico. Audit every claim. Find gaps. Demand sources.',
    'conclave-advogado':   'You are the Advogado do Diabo. Attack the decision. Find worst-cases. Challenge every assumption.',
    'conclave-sintetizador': 'You are the Sintetizador. Integrate all perspectives into one clear, actionable recommendation.',
  };
  return contexts[agent] || '';
}

// ========== TASK DETECTION ==========
// Task detection — comprehensive word list (all conjugations hardcoded)
const _taskWords = new Set([
  // English
  'create','generate','build','make','write','produce','design','implement','develop',
  'fix','update','modify','analyze','report','research','search','find','plan','draft',
  'compile','summarize','convert','export','deploy','install','setup','configure',
  'refactor','test','debug','document','open','access','navigate','play','stream',
  'run','execute','send','schedule','move','rename','delete','download','upload',
  'organize','show','display','start','stop','close','save','copy','paste','edit',
  'add','remove','change','set','get','list','check','read','print','scan','connect',
  // PT — criar
  'cria','crie','crio','criou','criar','criando','criado',
  // PT — gerar
  'gera','gere','gero','gerou','gerar','gerando','gerado',
  // PT — fazer
  'faz','faça','fez','fazer','fazendo','feito',
  // PT — abrir
  'abre','abra','abro','abriu','abrir','abrindo','aberto',
  // PT — escrever
  'escreve','escreva','escreveu','escrever','escrevendo','escrito',
  // PT — construir
  'constroi','construa','construiu','construir','construindo',
  // PT — desenhar
  'desenha','desenhe','desenhou','desenhar','desenhando',
  // PT — implementar
  'implementa','implemente','implementou','implementar','implementando',
  // PT — desenvolver
  'desenvolve','desenvolva','desenvolveu','desenvolver','desenvolvendo',
  // PT — corrigir
  'corrige','corrija','corrigiu','corrigir','corrigindo',
  // PT — atualizar
  'atualiza','atualize','atualizou','atualizar','atualizando',
  // PT — analisar
  'analisa','analise','analisou','analisar','analisando',
  // PT — pesquisar
  'pesquisa','pesquise','pesquisou','pesquisar','pesquisando',
  // PT — buscar
  'busca','busque','buscou','buscar','buscando',
  // PT — encontrar
  'encontra','encontre','encontrou','encontrar','encontrando',
  // PT — planejar
  'planeja','planeje','planejou','planejar','planejando',
  // PT — montar
  'monta','monte','montou','montar','montando',
  // PT — preparar
  'prepara','prepare','preparou','preparar','preparando',
  // PT — elaborar
  'elabora','elabore','elaborou','elaborar','elaborando',
  // PT — colocar
  'coloca','coloque','colocou','colocar','colocando',
  // PT — tocar/reproduzir
  'toca','toque','tocou','tocar','tocando','reproduz','reproduza','reproduzir',
  // PT — executar
  'executa','execute','executou','executar','executando',
  // PT — enviar/mandar
  'envia','envie','enviou','enviar','enviando','manda','mande','mandou','mandar',
  // PT — agendar
  'agenda','agende','agendou','agendar','agendando',
  // PT — mover
  'move','mova','moveu','mover','movendo',
  // PT — salvar
  'salva','salve','salvou','salvar','salvando',
  // PT — mostrar/exibir
  'mostra','mostre','mostrou','mostrar','mostrando','exibe','exiba','exibir',
  // PT — editar
  'edita','edite','editou','editar','editando',
  // PT — deletar/apagar
  'deleta','delete','deletou','deletar','apaga','apague','apagou','apagar',
  // PT — baixar
  'baixa','baixe','baixou','baixar','baixando',
  // PT — organizar
  'organiza','organize','organizou','organizar','organizando',
  // PT — formatar
  'formata','formate','formatou','formatar','formatando',
  // PT — calcular
  'calcula','calcule','calculou','calcular','calculando',
  // PT — traduzir
  'traduz','traduza','traduziu','traduzir','traduzindo',
  // PT — publicar
  'publica','publique','publicou','publicar','publicando',
  // PT — instalar
  'instala','instale','instalou','instalar','instalando',
  // PT — configurar
  'configura','configure','configurou','configurar','configurando',
  // PT — testar
  'testa','teste','testou','testar','testando',
  // PT — documentar
  'documenta','documente','documentou','documentar','documentando',
  // PT — rodar
  'roda','rode','rodou','rodar','rodando',
  // PT — fechar
  'fecha','feche','fechou','fechar','fechando',
  // PT — copiar
  'copia','copie','copiou','copiar','copiando',
  // PT — adicionar
  'adiciona','adicione','adicionou','adicionar','adicionando',
  // PT — remover
  'remove','remova','removeu','remover','removendo',
  // PT — alterar/mudar
  'altera','altere','alterou','alterar','muda','mude','mudou','mudar',
  // PT — verificar
  'verifica','verifique','verificou','verificar','verificando',
  // PT — digitar
  'digita','digite','digitou','digitar','digitando',
  // PT — conectar
  'conecta','conecte','conectou','conectar','conectando',
  // PT — compartilhar
  'compartilha','compartilhe','compartilhou','compartilhar',
  // PT — responder
  'responde','responda','respondeu','responder',
  // PT — ouvir/escutar
  'ouvir','escutar','ouça','escute',
  // PT — iniciar/parar
  'inicia','inicie','iniciou','iniciar','para','pare','parou','parar',
  // PT — renomear
  'renomeia','renomeie','renomeou','renomear',
  // ES
  'haz','haga','abre','abra','busca','busque','crea','cree','pon','ponga',
]);

// Simple regex fallback for task detection
const TASK_PATTERN = /\b(create|build|make|write|open|play|search|find|fix|update|install|cria|crie|criar|abre|abra|abrir|faz|faça|fazer|gera|gere|gerar|monta|monte|montar|coloca|coloque|colocar|toca|toque|tocar|pesquisa|pesquise|pesquisar|busca|busque|buscar|edita|edite|editar|salva|salve|salvar|envia|envie|enviar|manda|mande|mandar|move|mova|mover|baixa|baixe|baixar|organiza|organize|organizar|formata|formate|formatar|calcula|calcule|calcular|traduz|traduza|traduzir|instala|instale|instalar|configura|configure|configurar|testa|teste|testar|executa|execute|executar|roda|rode|rodar|fecha|feche|fechar|copia|copie|copiar|adiciona|adicione|adicionar|remove|remova|remover|altera|altere|alterar|verifica|verifique|verificar|conecta|conecte|conectar|publica|publique|publicar|compartilha|compartilhe|compartilhar|responde|responda|responder|ouvir|escutar|ouça|escute|reproduz|reproduza|reproduzir|desenvolve|desenvolva|desenvolver|implementa|implemente|implementar|analisa|analise|analisar|elabora|elabore|elaborar|prepara|prepare|preparar|documenta|documente|documentar|corrige|corrija|corrigir|atualiza|atualize|atualizar|desenha|desenhe|desenhar|constroi|construa|construir|renomeia|renomeie|renomear|deleta|delete|deletar|apaga|apague|apagar|agenda|agende|agendar|digita|digite|digitar|inicia|inicie|iniciar|para|pare|parar)\b/i;

function isTaskRequest(message) {
  const words = message.toLowerCase().replace(/[^a-záàâãéèêíïóôõúüçñ\s]/gi, '').split(/\s+/);
  if (words.some(w => _taskWords.has(w))) return true;
  if (SCREEN_PATTERN.test(message)) return true;
  return false;
}

// Screen/vision queries — always route to Claude (never GPT-mini)
const SCREEN_PATTERN = /\b(tela|monitor|screen|olh[aeo]|vej[ao]|mostr[ae]|v[eê]|see|look|what.*screen|o que.*tela|o que.*monitor|consegue.*ver|can.*see|minha tela|my screen|está aberto|what.*open)\b/i;

// Computer Use v2 patterns — actions that interact with the PC directly
const COMPUTER_USE_PATTERN = /\b(abre|abra|abrir|fecha|feche|fechar|minimiza|minimize|minimizar|maximiza|maximize|maximizar|alterna|alterne|alternar|foca|foque|focar|digita|digite|digitar|clica|clique|clicar|pressiona|pressione|scroll|rola|role|navega|navegue|navegar|preenche|preencha|preencher|configura|configure|configurar|instala|instale|instalar|desliga|desligue|desligar|reinicia|reinicie|reiniciar|bloco de notas|notepad|calculadora|calculator|explorador|explorer|gerenciador|task.?manager|prompt|cmd|terminal|powershell)\b/i;

// Needs screenshot? (visual tasks that require seeing the screen)
const NEEDS_SCREENSHOT_PATTERN = /\b(o que|what|mostra|show|veja|see|olha|look|onde|where|qual|which|como.*tá|how.*look|identifica|identify|encontra|find.*screen|acha.*tela|botão|button|ícone|icon|cor|color|imagem|image|visual)\b/i;

// Detect multi-task requests that can run in parallel
// "cria o site, a planilha e a apresentação" → 3 parallel tasks
function detectParallelTasks(message) {
  const msg = message.replace(/^jarvis[,.]??\s*/i, '').trim();

  // Pattern: "cria/faz X, Y e Z" or "cria X e também Y"
  // Split by: ", e ", " e também ", ", depois ", ", além de ", " + "
  const splitPatterns = /\s*(?:,\s*e\s+também\s+|,\s*e\s+|,\s*depois\s+|,\s*além\s*d[eio]\s+|,\s*também\s+|\s+e\s+também\s+|\s+e\s+depois\s+)\s*/i;

  // Only split if the message has multiple action verbs
  const actionVerbs = msg.match(/\b(cri[ae]|faz|faça|gere|construa|escreva|abra|monte|prepare|analise|pesquise|create|build|make|write|open|generate|design)\b/gi);
  if (!actionVerbs || actionVerbs.length < 2) {
    // Check for list pattern: "X, Y e Z"
    if (!splitPatterns.test(msg)) return null;
    // Must have at least one action verb
    if (!actionVerbs || actionVerbs.length === 0) return null;
  }

  const parts = msg.split(splitPatterns).filter(p => p.trim().length > 5);
  if (parts.length < 2) return null;
  if (parts.length > 5) return null; // safety limit

  // Ensure first part has an action verb; propagate verb to other parts if missing
  const firstVerb = parts[0].match(/^(\w+)/)?.[1] || '';
  return parts.map((p, i) => {
    const trimmed = p.trim();
    // If part doesn't start with an action verb, prepend the first part's verb
    if (i > 0 && !TASK_PATTERN.test(trimmed)) {
      return `${firstVerb} ${trimmed}`;
    }
    return trimmed;
  });
}

// ========== FAST-PATH: Instant actions without Claude CLI ==========
// Two modes:
// 1. Regex patterns for ultra-common actions (~50ms) — open youtube, google, etc.
// 2. GPT-4o-mini smart routing (~500ms) — interprets complex commands and generates shell command
function normalizeMediaText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/^jarvis[,.]?\s*/i, '')
    .trim();
}

function isMediaCommand(message) {
  const text = normalizeMediaText(message);
  if (!text) return false;
  const hasMediaVerb = /\b(toque|tocar|toca|coloca|coloque|bota|poe|põe|play|reproduz|reproduzir|ouvir|escutar|abra|abre|abrir)\b/i.test(text);
  const hasMediaNoun = /\b(musica|som|playlist|youtube|spotify|video)\b/i.test(text);
  const hasPlayPhrase = /\b(toque|toca|play|reproduz|ouvir|escutar)\b/i.test(text);
  return hasMediaVerb && hasMediaNoun;
}

function normalizeIntentText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function isSpreadsheetRequest(message) {
  const text = normalizeIntentText(message);
  if (!text) return false;
  const mentionsSpreadsheet = /\b(planilha|excel|xlsx|spreadsheet)\b/i.test(text);
  const asksForWork = /\b(cria|crie|criar|abre|abra|abrir|faz|faca|fazer|monta|monte|montar|coloca|coloque|adiciona|adicione|preenche|configure|configura)\b/i.test(text);
  const hasSpreadsheetObject = /\b(vendas|colunas?|produto|quantidade|preco|valor total|cliente)\b/i.test(text);
  return mentionsSpreadsheet && (asksForWork || hasSpreadsheetObject);
}

function splitSpreadsheetColumns(rawColumns) {
  return String(rawColumns || '')
    .replace(/\b(e|and)\b/ig, ',')
    .split(',')
    .map(item => item.replace(/[.;:]+$/g, '').trim())
    .filter(Boolean);
}

function extractSpreadsheetColumns(message) {
  const raw = String(message || '');
  const match = raw.match(/colunas?\s*:?\s*(.+?)(?:\s+(?:na|no|em|para)\s+(?:a\s+|o\s+)?planilha|\s*$)/i);
  if (match?.[1]) {
    const columns = splitSpreadsheetColumns(match[1]);
    if (columns.length) return columns;
  }

  const salesColumns = [
    'Produto',
    'Quantidade',
    'Preço Unitário',
    'Valor Total',
    'Cliente'
  ];

  if (/\b(vendas|produto|quantidade|pre[cç]o|valor total|cliente)\b/i.test(raw)) {
    return salesColumns;
  }

  return ['Item', 'Quantidade', 'Preço Unitário', 'Valor Total', 'Observações'];
}

const SPREADSHEET_TEMPLATES = {
  vendas: {
    title: 'Planilha de Vendas',
    mainSheet: 'Vendas',
    columns: ['Data', 'Cliente', 'Produto', 'Categoria', 'Quantidade', 'Valor Unitario', 'Desconto', 'Total', 'Forma de Pagamento', 'Vendedor', 'Status'],
    sampleRows: [
      ['09/05/2026', 'Cliente A', 'Produto Alpha', 'Eletronicos', 2, 149.90, 0, null, 'Cartao', 'Ana', 'Pago'],
      ['09/05/2026', 'Cliente B', 'Produto Beta', 'Casa', 1, 89.50, 5, null, 'Pix', 'Bruno', 'Pendente'],
      ['09/05/2026', 'Cliente C', 'Produto Gamma', 'Servicos', 3, 59.90, 10, null, 'Boleto', 'Carla', 'Pago']
    ],
    formulas: { 8: '=E{row}*F{row}-G{row}' },
    currencyColumns: [6, 7, 8],
    integerColumns: [5],
    summary: [['Total de Vendas', '=SUM(Vendas!H2:H4)', 'currency'], ['Quantidade de Pedidos', '=COUNTA(Vendas!B2:B4)', 'integer'], ['Ticket Medio', '=IF(B4=0,0,B3/B4)', 'currency']],
    chart: { title: 'Vendas por Produto', xTitle: 'Produto', yTitle: 'Total de Vendas', categoryCol: 3, valueCol: 8 }
  },
  financeiro: {
    title: 'Planilha Financeira',
    mainSheet: 'Lancamentos',
    columns: ['Data', 'Tipo', 'Categoria', 'Centro de Custo', 'Descricao', 'Valor', 'Forma de Pagamento', 'Status', 'Vencimento', 'Pagamento'],
    sampleRows: [
      ['09/05/2026', 'Entrada', 'Vendas', 'Comercial', 'Recebimento cliente A', 1200, 'Pix', 'Pago', '09/05/2026', '09/05/2026'],
      ['10/05/2026', 'Saida', 'Fornecedores', 'Operacoes', 'Pagamento fornecedor', 450, 'Boleto', 'Pendente', '15/05/2026', ''],
      ['11/05/2026', 'Entrada', 'Servicos', 'Comercial', 'Contrato mensal', 800, 'Cartao', 'Pago', '11/05/2026', '11/05/2026']
    ],
    currencyColumns: [6],
    summary: [['Total Entradas', '=SUMIF(Lancamentos!B2:B4,"Entrada",Lancamentos!F2:F4)', 'currency'], ['Total Saidas', '=SUMIF(Lancamentos!B2:B4,"Saida",Lancamentos!F2:F4)', 'currency'], ['Saldo', '=B3-B4', 'currency']],
    chart: { title: 'Entradas x Saidas por Categoria', xTitle: 'Categoria', yTitle: 'Valor', categoryCol: 3, valueCol: 6 }
  },
  compras: {
    title: 'Planilha de Compras',
    mainSheet: 'Compras',
    columns: ['Data', 'Fornecedor', 'Produto/Servico', 'Categoria', 'Quantidade', 'Valor Unitario', 'Total', 'Pedido', 'Status', 'Comprador'],
    sampleRows: [
      ['09/05/2026', 'Fornecedor A', 'Notebook', 'Tecnologia', 2, 3500, null, 'PED-001', 'Aprovado', 'Ana'],
      ['10/05/2026', 'Fornecedor B', 'Material escritorio', 'Administrativo', 10, 25, null, 'PED-002', 'Pendente', 'Bruno'],
      ['11/05/2026', 'Fornecedor A', 'Monitor', 'Tecnologia', 3, 950, null, 'PED-003', 'Recebido', 'Carla']
    ],
    formulas: { 7: '=E{row}*F{row}' },
    currencyColumns: [6, 7],
    integerColumns: [5],
    summary: [['Total Comprado', '=SUM(Compras!G2:G4)', 'currency'], ['Quantidade de Pedidos', '=COUNTA(Compras!H2:H4)', 'integer'], ['Top Fornecedores', '=COUNTA(Compras!B2:B4)', 'integer']],
    chart: { title: 'Compras por Fornecedor', xTitle: 'Fornecedor', yTitle: 'Total Comprado', categoryCol: 2, valueCol: 7 }
  },
  estoque: {
    title: 'Planilha de Estoque',
    mainSheet: 'Estoque',
    columns: ['Codigo', 'Produto', 'Categoria', 'Local', 'Quantidade', 'Custo Unitario', 'Valor Total', 'Estoque Minimo', 'Status'],
    sampleRows: [
      ['SKU-001', 'Produto Alpha', 'Eletronicos', 'Prateleira A', 12, 80, null, 5, 'OK'],
      ['SKU-002', 'Produto Beta', 'Casa', 'Prateleira B', 3, 35, null, 6, 'Abaixo do minimo'],
      ['SKU-003', 'Produto Gamma', 'Servicos', 'Prateleira C', 20, 15, null, 8, 'OK']
    ],
    formulas: { 7: '=E{row}*F{row}' },
    currencyColumns: [6, 7],
    integerColumns: [5, 8],
    summary: [['Valor Total em Estoque', '=SUM(Estoque!G2:G4)', 'currency'], ['Itens abaixo do minimo', '=COUNTIF(Estoque!I2:I4,"Abaixo do minimo")', 'integer'], ['Quantidade de SKUs', '=COUNTA(Estoque!A2:A4)', 'integer']],
    chart: { title: 'Estoque por Categoria', xTitle: 'Categoria', yTitle: 'Valor em Estoque', categoryCol: 3, valueCol: 7 }
  },
  fluxo_caixa: {
    title: 'Planilha de Fluxo de Caixa',
    mainSheet: 'Fluxo',
    columns: ['Data', 'Tipo', 'Categoria', 'Descricao', 'Entrada', 'Saida', 'Saldo', 'Conta', 'Status'],
    sampleRows: [
      ['09/05/2026', 'Entrada', 'Vendas', 'Venda diaria', 1200, 0, null, 'Conta Corrente', 'Confirmado'],
      ['10/05/2026', 'Saida', 'Fornecedor', 'Pagamento fornecedor', 0, 450, null, 'Conta Corrente', 'Pendente'],
      ['11/05/2026', 'Entrada', 'Servicos', 'Contrato mensal', 800, 0, null, 'Conta Corrente', 'Confirmado']
    ],
    formulas: { 7: '=E{row}-F{row}' },
    currencyColumns: [5, 6, 7],
    summary: [['Total Entradas', '=SUM(Fluxo!E2:E4)', 'currency'], ['Total Saidas', '=SUM(Fluxo!F2:F4)', 'currency'], ['Saldo Final', '=B3-B4', 'currency']],
    chart: { title: 'Entradas x Saidas', xTitle: 'Categoria', yTitle: 'Valor', categoryCol: 3, valueCol: 7 }
  },
  generico: {
    title: 'Planilha',
    mainSheet: 'Planilha',
    columns: ['Item', 'Quantidade', 'Valor Unitario', 'Total', 'Observacoes'],
    sampleRows: [['Item A', 1, 100, null, 'Exemplo'], ['Item B', 2, 50, null, 'Exemplo'], ['Item C', 3, 25, null, 'Exemplo']],
    formulas: { 4: '=B{row}*C{row}' },
    currencyColumns: [3, 4],
    integerColumns: [2],
    summary: [['Total', '=SUM(Planilha!D2:D4)', 'currency'], ['Itens', '=COUNTA(Planilha!A2:A4)', 'integer'], ['Media', '=IF(B4=0,0,B3/B4)', 'currency']],
    chart: { title: 'Total por Item', xTitle: 'Item', yTitle: 'Total', categoryCol: 1, valueCol: 4 }
  }
};

const pendingExcelTemplateRequests = new Map();
const EXCEL_TEMPLATE_CONFIRMATION_TTL_MS = 10 * 60 * 1000;

function detectSpreadsheetTemplate(message) {
  const text = normalizeIntentText(message);
  if (/\bfluxo[\s_-]*caixa\b|\bcash\s*flow\b/.test(text)) return 'fluxo_caixa';
  if (/\bfinanceir|financas|despesas|receitas|lancamentos|lancamento\b/.test(text)) return 'financeiro';
  if (/\bcompras|fornecedor|pedido\b/.test(text)) return 'compras';
  if (/\bestoque|inventario|sku|almoxarifado\b/.test(text)) return 'estoque';
  if (/\bvendas|cliente|produto|ticket|vendedor\b/.test(text)) return 'vendas';
  return 'generico';
}

function sanitizeExcelTemplateFilename(filename) {
  const raw = String(filename || '').trim();
  if (!raw) return { ok: false, error: 'Filename vazio' };
  if (path.isAbsolute(raw) || raw.includes('..') || raw.includes('/') || raw.includes('\\')) {
    return { ok: false, error: 'Filename deve ser apenas um nome de arquivo simples' };
  }
  if (raw !== path.basename(raw)) return { ok: false, error: 'Filename nao pode conter caminho' };
  if (!/^[a-zA-Z0-9 _.-]+$/.test(raw)) return { ok: false, error: 'Filename contem caracteres nao permitidos' };
  if (path.extname(raw).toLowerCase() !== '.xlsx') return { ok: false, error: 'Extensao nao permitida' };
  return { ok: true, filename: raw };
}

function cleanupExpiredExcelTemplateRequests() {
  const now = Date.now();
  for (const [id, item] of pendingExcelTemplateRequests.entries()) {
    if (item.expiresAt <= now) pendingExcelTemplateRequests.delete(id);
  }
}

function isExcelTemplateConfirmation(message) {
  const match = String(message || '').trim().match(/^CONFIRMAR_PLANILHA_EXCEL\s+([A-Z0-9]{6,16})$/i);
  return match ? match[1].toUpperCase() : null;
}

function isExcelTemplateCancel(message) {
  const match = String(message || '').trim().match(/^CANCELAR_PLANILHA_EXCEL\s+([A-Z0-9]{6,16})$/i);
  return match ? match[1].toUpperCase() : null;
}

function createExcelTemplateConfirmation(message) {
  cleanupExpiredExcelTemplateRequests();
  const template = detectSpreadsheetTemplate(message);
  const filename = safeWorkbookName(message);
  const safeName = sanitizeExcelTemplateFilename(filename);
  if (!safeName.ok) {
    return { ok: false, message: `Nao posso preparar essa planilha: ${safeName.error}.` };
  }
  const id = crypto.randomBytes(4).toString('hex').toUpperCase();
  pendingExcelTemplateRequests.set(id, {
    filename: safeName.filename,
    template,
    sampleRows: true,
    expiresAt: Date.now() + EXCEL_TEMPLATE_CONFIRMATION_TTL_MS
  });
  return {
    ok: true,
    id,
    message: [
      `Vou criar a planilha "${safeName.filename}" usando o template ${template}.`,
      'Destino: Documents and Projects',
      'Para confirmar, envie:',
      `CONFIRMAR_PLANILHA_EXCEL ${id}`,
      '',
      'Para cancelar, envie:',
      `CANCELAR_PLANILHA_EXCEL ${id}`
    ].join('\n')
  };
}

async function executePendingExcelTemplate(id, language = 'BR') {
  const key = String(id || '').trim().toUpperCase();
  const pending = pendingExcelTemplateRequests.get(key);
  if (!pending) {
    cleanupExpiredExcelTemplateRequests();
    return { ok: false, message: 'Nao encontrei uma planilha pendente com esse codigo.' };
  }
  if (pending.expiresAt <= Date.now()) {
    pendingExcelTemplateRequests.delete(key);
    return { ok: false, message: 'Esse pedido de planilha expirou. Envie o pedido novamente.' };
  }
  const result = await createSpreadsheetFromRequest({
    filename: pending.filename,
    template: pending.template,
    sampleRows: pending.sampleRows,
    openFile: true
  }, language);
  pendingExcelTemplateRequests.delete(key);
  return result;
}

function safeWorkbookName(message) {
  const text = normalizeIntentText(message);
  if (/\btemplate\b/.test(text)) {
    const template = detectSpreadsheetTemplate(message);
    const names = {
      vendas: 'PLANILHA_VENDAS_TEMPLATE.xlsx',
      financeiro: 'PLANILHA_FINANCEIRA_TEMPLATE.xlsx',
      compras: 'PLANILHA_COMPRAS_TEMPLATE.xlsx',
      estoque: 'PLANILHA_ESTOQUE_TEMPLATE.xlsx',
      fluxo_caixa: 'PLANILHA_FLUXO_CAIXA_TEMPLATE.xlsx',
      generico: 'PLANILHA_TEMPLATE.xlsx'
    };
    return names[template] || names.generico;
  }
  if (/\bgrafico\b/.test(text)) return 'PLANILHA_VENDAS_COM_GRAFICO.xlsx';
  if (/\bcorrigida\b/.test(text)) return 'PLANILHA_VENDAS_CORRIGIDA.xlsx';
  const template = detectSpreadsheetTemplate(message);
  const names = {
    vendas: 'Planilha de Vendas.xlsx',
    financeiro: 'Planilha Financeira.xlsx',
    compras: 'Planilha de Compras.xlsx',
    estoque: 'Planilha de Estoque.xlsx',
    fluxo_caixa: 'Planilha de Fluxo de Caixa.xlsx',
    generico: 'Planilha.xlsx'
  };
  return names[template] || names.generico;
}

async function createSpreadsheetFromRequest(request, language = 'BR') {
  const options = typeof request === 'object' && request !== null ? request : {};
  const message = typeof request === 'string' ? request : (options.message || '');
  const templateName = SPREADSHEET_TEMPLATES[options.template] ? options.template : detectSpreadsheetTemplate(message);
  const template = SPREADSHEET_TEMPLATES[templateName] || SPREADSHEET_TEMPLATES.generico;
  const filename = options.filename || safeWorkbookName(message || template.title);
  const safeName = sanitizeExcelTemplateFilename(filename);
  if (!safeName.ok) return { ok: false, error: safeName.error, errorType: 'invalid_filename' };
  const targetPath = path.resolve(PROJECTS_DIR, safeName.filename);
  if (!isInsideDirectory(PROJECTS_DIR, targetPath)) {
    return { ok: false, error: 'Caminho final fora de Documents and Projects', errorType: 'invalid_path' };
  }
  const payload = {
    path: targetPath,
    templateName,
    template,
    sampleRows: options.sampleRows !== false,
    openFile: options.openFile !== false
  };

  return executeSpreadsheetTemplatePayload(payload, language);

  const script = `
import json, os, subprocess, sys
from openpyxl import Workbook, load_workbook
from openpyxl.chart import BarChart, Reference
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

payload = json.loads(sys.argv[1])
path = payload["path"]
columns = [
    "Data",
    "Cliente",
    "Produto",
    "Categoria",
    "Quantidade",
    "Valor Unitário",
    "Desconto",
    "Total",
    "Forma de Pagamento",
    "Vendedor",
    "Status",
]

os.makedirs(os.path.dirname(path), exist_ok=True)
wb = Workbook()
ws = wb.active
ws.title = "Vendas"
summary = wb.create_sheet("Resumo")
ws.sheet_view.showGridLines = False
summary.sheet_view.showGridLines = False

header_fill = PatternFill("solid", fgColor="1F4E79")
summary_fill = PatternFill("solid", fgColor="D9EAF7")
header_font = Font(color="FFFFFF", bold=True)
title_font = Font(color="1F4E79", bold=True, size=14)
thin = Side(style="thin", color="B7C9E2")
border = Border(left=thin, right=thin, top=thin, bottom=thin)

if len(set(columns)) != len(columns) or any(not str(c).strip() for c in columns):
    raise ValueError("Cabeçalhos inválidos: vazios ou duplicados")

for idx, title in enumerate(columns, 1):
    cell = ws.cell(row=1, column=idx, value=title)
    cell.fill = header_fill
    cell.font = header_font
    cell.alignment = Alignment(horizontal="center")
    cell.border = border

examples = [
    ["09/05/2026", "Cliente A", "Produto Alpha", "Eletrônicos", 2, 149.90, 0, None, "Cartão", "Ana", "Pago"],
    ["09/05/2026", "Cliente B", "Produto Beta", "Casa", 1, 89.50, 5, None, "Pix", "Bruno", "Pendente"],
    ["09/05/2026", "Cliente C", "Produto Gamma", "Serviços", 3, 59.90, 10, None, "Boleto", "Carla", "Pago"],
]

for row_idx, row_values in enumerate(examples, 2):
    for col_idx, value in enumerate(row_values, 1):
        cell = ws.cell(row=row_idx, column=col_idx, value=value)
        cell.border = border
        cell.alignment = Alignment(vertical="center")
    ws.cell(row=row_idx, column=8, value=f'=E{row_idx}*F{row_idx}-G{row_idx}')

for idx, title in enumerate(columns, 1):
    width = max(12, min(26, len(str(title)) + 5))
    ws.column_dimensions[get_column_letter(idx)].width = width

for row in range(2, 5):
    ws.cell(row=row, column=5).number_format = '0'
    for col in (6, 7, 8):
        ws.cell(row=row, column=col).number_format = 'R$ #,##0.00'

ws.freeze_panes = "A2"
ws.auto_filter.ref = f"A1:{get_column_letter(len(columns))}4"

summary["A1"] = "Resumo"
summary["A1"].font = title_font
summary["A3"] = "Total de Vendas"
summary["A4"] = "Quantidade de Pedidos"
summary["A5"] = "Ticket Médio"
summary["B3"] = "=SUM(Vendas!H2:H4)"
summary["B4"] = "=COUNTA(Vendas!B2:B4)"
summary["B5"] = '=IF(B4=0,0,B3/B4)'
for row in range(3, 6):
    summary.cell(row=row, column=1).fill = summary_fill
    summary.cell(row=row, column=1).font = Font(bold=True)
    summary.cell(row=row, column=1).border = border
    summary.cell(row=row, column=2).border = border
    if row in (3, 5):
        summary.cell(row=row, column=2).number_format = 'R$ #,##0.00'
summary.column_dimensions["A"].width = 24
summary.column_dimensions["B"].width = 18

has_chart_data = any(ws.cell(row=row, column=3).value and ws.cell(row=row, column=8).value for row in range(2, 5))
if has_chart_data:
    chart = BarChart()
    chart.type = "col"
    chart.style = 10
    chart.title = "Vendas por Produto"
    chart.y_axis.title = "Total de Vendas"
    chart.x_axis.title = "Produto"
    chart.y_axis.majorGridlines = None
    chart.x_axis.majorGridlines = None
    values = Reference(ws, min_col=8, min_row=1, max_row=4)
    categories = Reference(ws, min_col=3, min_row=2, max_row=4)
    chart.add_data(values, titles_from_data=True)
    chart.set_categories(categories)
    chart.height = 7
    chart.width = 14
    summary.add_chart(chart, "D2")
else:
    summary["D2"] = "O gráfico será exibido quando houver dados de vendas."
    summary["D2"].font = Font(italic=True, color="666666")

wb.save(path)
checked = load_workbook(path, data_only=False)
checked.save(path)
if payload.get("openFile"):
    subprocess.Popen(["cmd", "/c", "start", "", path], shell=True)
print(json.dumps({"ok": True, "path": path, "columns": columns}))
`;

  const tmpScript = path.join(os.tmpdir(), `jarvis_create_spreadsheet_${Date.now()}.py`);
  fs.writeFileSync(tmpScript, script, 'utf-8');
  const { execFile } = await import('child_process');

  return new Promise((resolve) => {
    execFile(PYTHON_CMD, [tmpScript, JSON.stringify(payload)], { timeout: 30000 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpScript); } catch {}
      if (err) {
        resolve({ ok: false, error: err.message, stderr });
        return;
      }
      try {
        const result = JSON.parse(stdout.trim());
        const summary = language === 'BR'
          ? `Planilha criada: ${path.basename(result.path)} com as colunas ${result.columns.join(', ')}.`
          : `Spreadsheet created: ${path.basename(result.path)} with columns ${result.columns.join(', ')}.`;
        resolve({ ...result, summary });
      } catch {
        resolve({ ok: false, error: 'Parse error', raw: stdout });
      }
    });
  });
}

async function executeSpreadsheetTemplatePayload(payload, language = 'BR') {
  const script = `
import json, os, subprocess, sys
from openpyxl import Workbook, load_workbook
from openpyxl.chart import BarChart, Reference
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

payload = json.loads(sys.argv[1])
path = payload["path"]
template = payload["template"]
columns = template["columns"]
main_sheet = template["mainSheet"]
examples = template.get("sampleRows", []) if payload.get("sampleRows", True) else []
formulas = {int(k): v for k, v in template.get("formulas", {}).items()}
currency_columns = set(template.get("currencyColumns", []))
integer_columns = set(template.get("integerColumns", []))
summary_items = template.get("summary", [])
chart_spec = template.get("chart")

os.makedirs(os.path.dirname(path), exist_ok=True)
wb = Workbook()
ws = wb.active
ws.title = main_sheet[:31]
summary = wb.create_sheet("Resumo")
ws.sheet_view.showGridLines = False
summary.sheet_view.showGridLines = False

header_fill = PatternFill("solid", fgColor="1F4E79")
summary_fill = PatternFill("solid", fgColor="D9EAF7")
header_font = Font(color="FFFFFF", bold=True)
title_font = Font(color="1F4E79", bold=True, size=14)
thin = Side(style="thin", color="B7C9E2")
border = Border(left=thin, right=thin, top=thin, bottom=thin)

if len(set(columns)) != len(columns) or any(not str(c).strip() for c in columns):
    raise ValueError("Cabecalhos invalidos: vazios ou duplicados")

for idx, title in enumerate(columns, 1):
    cell = ws.cell(row=1, column=idx, value=title)
    cell.fill = header_fill
    cell.font = header_font
    cell.alignment = Alignment(horizontal="center")
    cell.border = border

for row_idx, row_values in enumerate(examples, 2):
    for col_idx, value in enumerate(row_values, 1):
        cell = ws.cell(row=row_idx, column=col_idx, value=value)
        cell.border = border
        cell.alignment = Alignment(vertical="center")
    for formula_col, formula in formulas.items():
        ws.cell(row=row_idx, column=formula_col, value=formula.replace("{row}", str(row_idx)))

for idx, title in enumerate(columns, 1):
    width = max(12, min(28, len(str(title)) + 5))
    ws.column_dimensions[get_column_letter(idx)].width = width

last_row = max(2, len(examples) + 1)
for row in range(2, last_row + 1):
    for col in integer_columns:
        ws.cell(row=row, column=col).number_format = '0'
    for col in currency_columns:
        ws.cell(row=row, column=col).number_format = 'R$ #,##0.00'

ws.freeze_panes = "A2"
if examples:
    ws.auto_filter.ref = f"A1:{get_column_letter(len(columns))}{last_row}"

summary["A1"] = "Resumo"
summary["A1"].font = title_font
for idx, item in enumerate(summary_items, 3):
    label, formula, kind = item
    summary.cell(row=idx, column=1, value=label)
    summary.cell(row=idx, column=2, value=formula)
    summary.cell(row=idx, column=1).fill = summary_fill
    summary.cell(row=idx, column=1).font = Font(bold=True)
    summary.cell(row=idx, column=1).border = border
    summary.cell(row=idx, column=2).border = border
    if kind == "currency":
        summary.cell(row=idx, column=2).number_format = 'R$ #,##0.00'
    elif kind == "integer":
        summary.cell(row=idx, column=2).number_format = '0'
summary.column_dimensions["A"].width = 28
summary.column_dimensions["B"].width = 18

has_chart_data = bool(chart_spec and examples and any(ws.cell(row=row, column=chart_spec["categoryCol"]).value and ws.cell(row=row, column=chart_spec["valueCol"]).value for row in range(2, last_row + 1)))
if has_chart_data:
    chart = BarChart()
    chart.type = "col"
    chart.style = 10
    chart.title = chart_spec["title"]
    chart.y_axis.title = chart_spec["yTitle"]
    chart.x_axis.title = chart_spec["xTitle"]
    chart.y_axis.majorGridlines = None
    chart.x_axis.majorGridlines = None
    values = Reference(ws, min_col=chart_spec["valueCol"], min_row=1, max_row=last_row)
    categories = Reference(ws, min_col=chart_spec["categoryCol"], min_row=2, max_row=last_row)
    chart.add_data(values, titles_from_data=True)
    chart.set_categories(categories)
    chart.height = 7
    chart.width = 14
    summary.add_chart(chart, "D2")
else:
    summary["D2"] = "O grafico sera exibido quando houver dados."
    summary["D2"].font = Font(italic=True, color="666666")

wb.save(path)
checked = load_workbook(path, data_only=False)
checked.save(path)
if payload.get("openFile"):
    subprocess.Popen(["cmd", "/c", "start", "", path], shell=True)
print(json.dumps({"ok": True, "path": path, "columns": columns, "template": payload["templateName"]}))
`;

  const tmpScript = path.join(os.tmpdir(), `jarvis_excel_template_${Date.now()}.py`);
  fs.writeFileSync(tmpScript, script, 'utf-8');
  const { execFile } = await import('child_process');

  return new Promise((resolve) => {
    execFile(PYTHON_CMD, [tmpScript, JSON.stringify(payload)], { timeout: 30000 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpScript); } catch {}
      if (err) {
        resolve({ ok: false, error: err.message, stderr });
        return;
      }
      try {
        const result = JSON.parse(stdout.trim());
        const summary = language === 'BR'
          ? `Planilha criada: ${path.basename(result.path)} usando o template ${result.template}.`
          : `Spreadsheet created: ${path.basename(result.path)} using template ${result.template}.`;
        resolve({ ...result, summary });
      } catch {
        resolve({ ok: false, error: 'Parse error', raw: stdout });
      }
    });
  });
}

function cleanMediaQuery(query) {
  return String(query || '')
    .replace(/\b(no|na|pelo|pela|abrir|abra|abre)\s+(youtube|spotify)\b/ig, ' ')
    .replace(/\b(youtube|spotify)\b/ig, ' ')
    .replace(/\b(pra|para)\s+(mim|tocar|reproduzir)\b/ig, ' ')
    .replace(/\b(a|o|uma|um)\s+(musica|música|som|video|vídeo)\b/ig, ' ')
    .replace(/^(de|do|da|dos|das)\s+/i, '')
    .replace(/[?.!,;]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseMediaRequest(message) {
  const raw = String(message || '').replace(/^jarvis[,.]?\s*/i, '').trim();
  const normalized = normalizeMediaText(raw);
  const platform = /\bspotify\b/i.test(normalized) ? 'spotify' : 'youtube';
  const patterns = [
    /(?:toque|tocar|toca|coloca|coloque|bota|p[oõ]e|play|reproduz(?:ir)?|ouvir|escutar)\s+(?:a\s+)?(?:m[uú]sica\s+|som\s+|playlist\s+)?(.+)/i,
    /(?:abra|abre|abrir)\s+(?:a\s+)?(?:m[uú]sica\s+)?(.+?)(?:\s+(?:no|na|pelo|pela)\s+(?:youtube|spotify))?$/i,
    /(?:youtube|spotify)\s+(?:toca|toque|coloca|play|reproduz(?:ir)?)\s+(.+)/i
  ];
  let query = '';
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match?.[1]) {
      query = match[1];
      break;
    }
  }
  return {
    platform,
    query: cleanMediaQuery(query || raw),
    action: 'play'
  };
}

function openJarvisUrl(url) {
  execSync(`start "" "${url}"`, { shell: true, timeout: 3000 });
}

async function handleYouTubeMediaCommand({ query }) {
  const clean = cleanMediaQuery(query);
  if (!clean) return { ok: false, summary: 'Preciso do nome da musica ou artista para abrir no YouTube, senhor.' };

  const ytPlayScript = path.join(JARVIS_DIR, 'system', 'youtube-play.py');
  if (fs.existsSync(ytPlayScript)) {
    try {
      execSync(`"${PYTHON_CMD}" "${ytPlayScript}" "${clean}"`, {
        encoding: 'utf-8',
        timeout: 12000,
        shell: true
      });
      return { ok: true, started: true, summary: `Tocando ${clean} no YouTube, senhor.` };
    } catch (err) {
      console.warn('[JARVIS][media] YouTube auto-play fallback:', err.message?.slice(0, 160));
    }
  }

  try {
    openJarvisUrl(`https://www.youtube.com/results?search_query=${encodeURIComponent(clean)}`);
    return { ok: true, started: false, summary: `Abri a busca de ${clean} no YouTube. Não consegui iniciar automaticamente a reprodução.` };
  } catch {
    return { ok: false, summary: `Não consegui abrir ${clean} no YouTube neste momento, senhor.` };
  }
}

async function handleSpotifyMediaCommand({ query }) {
  const clean = cleanMediaQuery(query);
  if (!clean) return { ok: false, summary: 'Preciso do nome da musica, artista ou playlist para abrir no Spotify, senhor.' };
  try {
    openJarvisUrl(`https://open.spotify.com/search/${encodeURIComponent(clean)}`);
    return { ok: true, started: false, summary: `Abri a busca de ${clean} no Spotify. Se o navegador bloquear reprodução automática, clique no resultado desejado.` };
  } catch {
    return { ok: false, summary: `Não consegui abrir ${clean} no Spotify neste momento, senhor.` };
  }
}

async function handleMediaCommand(request) {
  if (request.platform === 'spotify') return handleSpotifyMediaCommand(request);
  return handleYouTubeMediaCommand(request);
}

function tryFastExecution(message, language = 'BR') {
  const msg = message.toLowerCase().replace(/^jarvis[,.]??\s*/i, '').trim();

  // ── SAUDAÇÕES: Bom dia / Boa tarde / Boa noite ──
  if (/^(bom\s+dia|boa\s+tarde|boa\s+noite)/i.test(msg)) {
    const now = new Date();
    const hour = now.getHours();
    const time = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const gr = hour >= 5 && hour < 12 ? 'Bom dia' : hour >= 12 && hour < 18 ? 'Boa tarde' : 'Boa noite';
    const summ = {
      BR: `${gr}, senhor. São ${time}. O que posso fazer pelo senhor?`,
      ES: `${gr}, señor. Son las ${time}. ¿En qué puedo ayudar?`,
      EN: `Good ${hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}, sir. It's ${time}. How can I help?`
    }[language] || `${gr}, senhor. São ${time}.`;
    return { output: '[system] Saudação', summary: summ };
  }

  // ── PRESENÇA / STATUS ──
  if (/\b(voc[eê]\s+est[aá]\s+a[ií]|est[aá]\s+a[ií]|est[aá]\s+online|est[aá]\s+funcionando|est[aá]\s+ativo|me\s+escuta\b|me\s+ouve\b|t[aá]\s+a[ií])\b/i.test(msg)) {
    const summ = { BR: 'Sim, senhor. Estou online.', ES: 'Sí, señor. Estoy en línea.', EN: 'Yes, sir. Online and ready.' }[language] || 'Sim, senhor. Estou online.';
    return { output: '[system] Status', summary: summ };
  }

  // ── Open URL patterns ──
  const urlPatterns = [
    { rx: /(?:abr[aie]|open|acesse?|navegue?)\s+(?:o\s+)?youtube(?!\s+e\s)/i, url: 'https://www.youtube.com' },
    { rx: /(?:abr[aie]|open|acesse?)\s+(?:o\s+)?google/i, url: 'https://www.google.com' },
    { rx: /(?:abr[aie]|open|acesse?)\s+(?:o\s+)?spotify/i, url: 'https://open.spotify.com' },
    { rx: /(?:abr[aie]|open|acesse?)\s+(?:o\s+)?github/i, url: 'https://github.com' },
    { rx: /(?:abr[aie]|open|acesse?)\s+(?:o\s+)?gmail/i, url: 'https://mail.google.com' },
    { rx: /(?:abr[aie]|open|acesse?)\s+(?:o\s+)?whatsapp/i, url: 'https://web.whatsapp.com' },
    { rx: /(?:abr[aie]|open|acesse?)\s+(?:o\s+)?twitter|(?:abr[aie]|open)\s+(?:o\s+)?x\b/i, url: 'https://x.com' },
    { rx: /(?:abr[aie]|open|acesse?)\s+(?:o\s+)?instagram/i, url: 'https://www.instagram.com' },
    { rx: /(?:abr[aie]|open|acesse?)\s+(?:o\s+)?linkedin/i, url: 'https://www.linkedin.com' },
    { rx: /(?:abr[aie]|open|acesse?)\s+(?:o\s+)?netflix/i, url: 'https://www.netflix.com' },
    { rx: /(?:abr[aie]|open|acesse?)\s+(?:o\s+)?claude/i, url: 'https://claude.ai' },
    { rx: /(?:abr[aie]|open|acesse?)\s+(?:o\s+)?chatgpt/i, url: 'https://chat.openai.com' },
    { rx: /(?:abr[aie]|open|acesse?)\s+(?:o\s+)?notion/i, url: 'https://www.notion.so' },
    { rx: /(?:abr[aie]|open|acesse?)\s+(?:o\s+)?figma/i, url: 'https://www.figma.com' },
    { rx: /(?:abr[aie]|open|acesse?)\s+(?:o\s+)?canva/i, url: 'https://www.canva.com' },
    { rx: /(?:abr[aie]|open|acesse?)\s+(?:o\s+)?trello/i, url: 'https://trello.com' },
    { rx: /(?:abr[aie]|open|acesse?)\s+(?:o\s+)?vercel/i, url: 'https://vercel.com' },
    { rx: /(?:abr[aie]|open|acesse?)\s+(?:o\s+)?supabase/i, url: 'https://supabase.com' },
    { rx: /(?:abr[aie]|open|acesse?)\s+(?:o\s+)?twitch/i, url: 'https://www.twitch.tv' },
    { rx: /(?:abr[aie]|open|acesse?)\s+(?:o\s+)?reddit/i, url: 'https://www.reddit.com' },
    { rx: /(?:abr[aie]|open|acesse?)\s+(?:o\s+)?amazon/i, url: 'https://www.amazon.com.br' },
    { rx: /(?:abr[aie]|open|acesse?)\s+(?:o\s+)?mercado\s*livre/i, url: 'https://www.mercadolivre.com.br' },
  ];

  for (const { rx, url } of urlPatterns) {
    if (rx.test(msg)) {
      try {
        execSync(`start "" "${url}"`, { shell: true, timeout: 3000 });
        const name = new URL(url).hostname.replace('www.', '');
        const summaries = { BR: `${name} aberto.`, ES: `${name} abierto.`, EN: `${name} opened.` };
        return { output: `[file] ${url}`, summary: summaries[language] || summaries.EN };
      } catch (e) { return null; }
    }
  }

  // ═══════════════════════════════════════════════════════
  // SMART HOOKS — Ações comuns executadas instantaneamente
  // ═══════════════════════════════════════════════════════

  // Helper: open URL and return result
  function openUrl(url, summary) {
    try { execSync(`start "" "${url}"`, { shell: true, timeout: 3000 }); return { output: `[file] ${url}`, summary }; } catch { return null; }
  }

  // ── YOUTUBE: Tocar música/vídeo ──
  // Patterns: "quero ouvir X", "toca X", "coloca X", "play X", "ouvir X no youtube"
  let ytQuery = null;

  const ytPatterns = [
    // "abre youtube e coloca/toca X"
    msg.match(/youtube\s+e\s+(?:coloca?|toca?|reproduz[ai]?|play|bota?|p[oõ]e)\s+(?:pra\s+)?(?:tocar\s+|play\s+)?(?:a\s+)?(?:m[uú]sica\s+|music\s+|song\s+|v[ií]deo\s+)?(.+)/i),
    // "coloca X pra tocar" / "bota X pra tocar" (pra tocar no final)
    msg.match(/(?:coloca?|bota?|p[oõ]e)\s+(.+?)\s+(?:pra|para)\s+(?:tocar|reproduzir|ouvir|play)/i),
    // "coloca/toca/reproduz X no youtube"
    msg.match(/(?:coloca?|toca?|reproduz[ai]?|play|bota?|p[oõ]e)\s+(?:pra\s+tocar\s+)?(?:a\s+)?(?:m[uú]sica\s+|music\s+|song\s+|v[ií]deo\s+)?(.+?)(?:\s+no\s+youtube|\s+on\s+youtube)/i),
    // "pesquisa X no youtube"
    msg.match(/(?:pesquis[ae]|search|busca?)\s+(.+?)(?:\s+no\s+youtube|\s+on\s+youtube)/i),
    // "toca a música X" / "play X"
    msg.match(/(?:coloca?|toca?|reproduz[ai]?|play|bota?|p[oõ]e)\s+(?:pra\s+tocar\s+)?(?:a\s+)?(?:m[uú]sica|music|song)\s+(.+)/i),
    // "toca X" / "play X" (simples, sem "música")
    msg.match(/(?:toca|toque|play)\s+(?:a\s+)?(.+)/i),
    // "quero ouvir X" / "quero escutar X" — requires explicit music/media noun to avoid false positives
    msg.match(/(?:quero|want)\s+(?:ouvir|escutar|hear|listen)\s+(?:a\s+)?(?:m[uú]sica|music|song|playlist)\s+(.+)/i),
    // "ouvir a música X" — requires "música" explicitly to avoid "ouvir sua opinião" etc.
    msg.match(/(?:ouvir|escutar)\s+(?:a\s+)?(?:m[uú]sica|music|playlist)\s+(.+)/i),
  ];
  for (const m of ytPatterns) { if (m) { ytQuery = m[1]; break; } }

  // Guard: reject conversational fragments (too short or pure stop-words)
  if (ytQuery) {
    const _qClean = ytQuery.replace(/[?.!,]+$/, '').trim();
    if (_qClean.length < 4 || /^(aqui|isso|a[ií]|sim|n[aã]o|ok|oi|ol[aá]|isso aqui|l[aá]|here|there|that|this)\s*$/i.test(_qClean)) {
      ytQuery = null;
    }
  }

  if (ytQuery) {
    const clean = ytQuery.replace(/[?.!,]+$/, '').replace(/\s+no\s+youtube.*/i, '').replace(/\s+pra\s+mim.*/i, '').trim();

    // Open video DIRECTLY — no search page, no double tabs
    const ytPlayScript = path.join(JARVIS_DIR, 'system', 'youtube-play.py');
    try {
      // Run synchronously to get the video URL before responding
      const ytResult = execSync(`"${PYTHON_CMD}" "${ytPlayScript}" "${clean}"`, {
        encoding: 'utf-8', timeout: 10000, shell: true
      });
      console.log(`[JARVIS] ▶ YouTube: ${ytResult.trim()}`);
    } catch (e) {
      // Fallback: open search page
      execSync(`start "" "https://www.youtube.com/results?search_query=${encodeURIComponent(clean)}"`, { shell: true, timeout: 3000 });
    }
    const summaries = { BR: `Tocando "${clean}" no YouTube.`, ES: `Reproduciendo "${clean}" en YouTube.`, EN: `Playing "${clean}" on YouTube.` };
    return { output: `[system] YouTube: ${clean}`, summary: summaries[language] || summaries.EN };
  }

  // ── SPOTIFY: Tocar música ──
  const spotifyMatch = msg.match(/(?:toca?|play|coloca?|reproduz|ouvir|escutar)\s+(.+?)(?:\s+no\s+spotify|\s+on\s+spotify)/i);
  if (spotifyMatch) {
    const q = encodeURIComponent(spotifyMatch[1].trim());
    return openUrl(`https://open.spotify.com/search/${q}`, { BR: `Buscando "${spotifyMatch[1].trim()}" no Spotify.`, ES: `Buscando en Spotify.`, EN: `Searching Spotify.` }[language]);
  }

  // ── GOOGLE: Pesquisar ──
  const googleMatch = msg.match(/(?:pesquis[ae]|search|busca?|googl[ae]|procur[ae])\s+(?:no\s+google\s+)?(?:sobre\s+|about\s+|por\s+|for\s+)?(.+?)(?:\s+no\s+google)?$/i);
  if (googleMatch && /pesquis|search|busca|google|procur/i.test(msg)) {
    const q = encodeURIComponent(googleMatch[1].replace(/\s+no\s+google$/i, '').trim());
    return openUrl(`https://www.google.com/search?q=${q}`, { BR: `Pesquisando no Google.`, ES: `Buscando en Google.`, EN: `Searching Google.` }[language]);
  }

  // ── GOOGLE MAPS: Navegação / Como chegar ──
  const mapsMatch = msg.match(/(?:como\s+cheg[ao]|rota\s+(?:para|pra|até)|naveg[ae]\s+(?:para|pra|até)|directions?\s+to|how\s+to\s+get\s+to|route\s+to)\s+(.+)/i)
    || msg.match(/(?:abr[aie]|open)\s+(?:o\s+)?(?:google\s+)?maps?\s+(?:em|in|para|pra|de)?\s*(.+)/i);
  if (mapsMatch) {
    const dest = encodeURIComponent(mapsMatch[1].trim());
    return openUrl(`https://www.google.com/maps/search/${dest}`, { BR: `Abrindo mapa.`, ES: `Abriendo mapa.`, EN: `Opening map.` }[language]);
  }

  // ── TIMER / ALARME ──
  const timerMatch = msg.match(/(?:timer|temporizador|alarme|alarm|cronômetro|cronometro)\s+(?:de\s+|for\s+|em\s+)?(\d+)\s*(min|minuto|minute|seg|segundo|second|hora|hour|h|m|s)/i);
  if (timerMatch) {
    const val = parseInt(timerMatch[1]);
    const unit = timerMatch[2].toLowerCase();
    let ms = val * 1000;
    if (unit.startsWith('min') || unit === 'm') ms = val * 60000;
    if (unit.startsWith('hora') || unit.startsWith('hour') || unit === 'h') ms = val * 3600000;
    // Set system timer via PowerShell notification
    const psCmd = `powershell -Command "Start-Sleep -Seconds ${ms/1000}; [System.Media.SystemSounds]::Exclamation.Play(); Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Timer de ${val} ${timerMatch[2]} finalizado!','JARVIS - Timer')"`;
    spawn('cmd', ['/c', psCmd], { detached: true, shell: true, stdio: 'ignore' });
    return { output: `[system] Timer ${val}${unit}`, summary: { BR: `Timer de ${val} ${timerMatch[2]} iniciado.`, ES: `Temporizador de ${val} ${timerMatch[2]} iniciado.`, EN: `${val} ${timerMatch[2]} timer started.` }[language] };
  }

  // ── TRADUZIR ──
  const translateMatch = msg.match(/(?:traduz[ai]?|translate|traduc[ie])\s+(?:isso|isto|this|para|to|pra|em)?\s*(?:para|to|pra|em)?\s*(?:o\s+)?(?:inglês|english|espanhol|spanish|português|portuguese|francês|french|alemão|german)?\s*[:\-]?\s*"?(.+)"?/i);
  if (translateMatch && /traduz|translate|traduc/i.test(msg)) {
    // Let Claude handle translation — not a fast-path
    return null;
  }

  // ── HORA / DATA ──
  if (/(?:que\s+horas?\s+(?:s[aã]o|é)|what\s+time|hora\s+atual|current\s+time|que\s+dia\s+(?:é|e)\s+hoje|what\s+day|data\s+de\s+hoje|today'?s?\s+date|horas?\s+agora|que\s+horas?\s+agora)/i.test(msg)) {
    const now = new Date();
    const time = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const date = now.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    return { output: `[system] ${time} - ${date}`, summary: { BR: `São ${time}, ${date}.`, ES: `Son las ${time}, ${date}.`, EN: `It's ${time}, ${date}.` }[language] };
  }

  // ── VOLUME do sistema ──
  const volMatch = msg.match(/(?:volume|som)\s+(?:em|para|pra|to|at)?\s*(\d+)\s*%?/i)
    || msg.match(/(?:aumenta?|sobe?|up)\s+(?:o\s+)?(?:volume|som)/i)
    || msg.match(/(?:diminui?|abaixa?|baixa?|down)\s+(?:o\s+)?(?:volume|som)/i)
    || msg.match(/(?:muta?|mute|silenci[ao])\s+(?:o\s+)?(?:volume|som|audio)/i);
  if (volMatch) {
    let volCmd = '';
    if (/muta|mute|silenci/i.test(msg)) {
      volCmd = 'powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]173)"';
    } else if (/aumenta|sobe|up/i.test(msg)) {
      volCmd = 'powershell -Command "1..5 | % { (New-Object -ComObject WScript.Shell).SendKeys([char]175) }"';
    } else if (/diminui|abaixa|baixa|down/i.test(msg)) {
      volCmd = 'powershell -Command "1..5 | % { (New-Object -ComObject WScript.Shell).SendKeys([char]174) }"';
    } else if (volMatch[1]) {
      const vol = parseInt(volMatch[1]);
      volCmd = `powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]173); Start-Sleep -Milliseconds 200; $vol=${Math.round(vol/2)}; 1..$vol | % { (New-Object -ComObject WScript.Shell).SendKeys([char]175) }"`;
    }
    if (volCmd) {
      try { execSync(volCmd, { shell: true, timeout: 5000 }); } catch {}
      return { output: '[system] Volume ajustado', summary: { BR: 'Volume ajustado.', ES: 'Volumen ajustado.', EN: 'Volume adjusted.' }[language] };
    }
  }

  // ── SCREENSHOT / PRINT ──
  if (/\b(screenshot|print\s*screen|captur[ae]\s+tela|capture\s+screen|tira\s+(?:um\s+)?print|salva?\s+(?:a\s+)?tela)\b/i.test(msg)) {
    try {
      const ssPath = path.join(PROJECTS_DIR, `screenshot-${Date.now()}.jpg`);
      const scriptPath = path.join(JARVIS_DIR, 'system', 'screenshot.py');
      const result = execSync(`"${PYTHON_CMD}" "${scriptPath}" 1`, { encoding: 'utf-8', timeout: 10000, maxBuffer: 30*1024*1024 });
      const data = JSON.parse(result.trim());
      const buf = Buffer.from(data.data.split(',')[1], 'base64');
      fs.writeFileSync(ssPath, buf);
      return { output: `[file] ${ssPath}`, summary: { BR: `Screenshot salvo.`, ES: `Captura guardada.`, EN: `Screenshot saved.` }[language] };
    } catch { return null; }
  }

  // ── DESLIGAR / REINICIAR PC ──
  if (/\b(deslig[ae]|shutdown|turn\s+off)\s+(?:o\s+)?(?:pc|computador|computer|máquina)\b/i.test(msg)) {
    return { output: '[system] Shutdown solicitado', summary: { BR: 'Desligando em 30 segundos. Digite "shutdown /a" pra cancelar.', ES: 'Apagando en 30 segundos.', EN: 'Shutting down in 30 seconds.' }[language] };
  }
  if (/\b(reinici[ae]|restart|reboot)\s+(?:o\s+)?(?:pc|computador|computer|máquina)\b/i.test(msg)) {
    return { output: '[system] Restart solicitado', summary: { BR: 'Reiniciando em 30 segundos.', ES: 'Reiniciando en 30 segundos.', EN: 'Restarting in 30 seconds.' }[language] };
  }

  // ── Guard: composite commands ("abre X e faz Y") → skip fast-path, route to Computer Use v2 ──
  if (/\b(e|and|depois|then|também|also)\b.*\b(cri[ae]|faz|make|create|edit|escrev|write|mont|build|configur|preenche|coloc|add|digit|typ)/i.test(msg)) {
    return null; // Multi-step → Computer Use v2 or Claude handles it
  }

  // ── Open programs (only simple "abre X" without follow-up actions) ──
  // FIX #1 (post-launch): aceita possessivos/fillers ("o meu vscode pra mim", "minha calculadora ai")
  // FIX #3 (post-launch): protocolos URI (spotify:, discord:, etc) silenciosamente falham se app
  //  nao estiver instalado — Windows abre a popup "obter app" mas o exit code e 0. Detecta exe e
  //  cai pra versao web se nao achar.
  const _openRx = (pat) => new RegExp(`(?:abr[aie]|open)\\s+(?:(?:o|a|os|as|um|uma|meu|minha|seu|sua)\\s+){0,2}(?:${pat})(?=\\b|$)`, 'i');
  const _has = (...paths) => paths.some(p => { try { return fs.existsSync(p.replace(/%([^%]+)%/g, (_, k) => process.env[k] || '')); } catch { return false; } });

  const programPatterns = [
    { rx: _openRx('excel'),                                       cmd: 'start excel',                                                          name: 'Excel' },
    { rx: _openRx('word'),                                        cmd: 'start winword',                                                        name: 'Word' },
    { rx: _openRx('powerpoint|pptx?'),                            cmd: 'start powerpnt',                                                       name: 'PowerPoint' },
    { rx: _openRx('notepad|bloco\\s*de\\s*notas'),                cmd: 'start notepad',                                                        name: 'Notepad' },
    { rx: _openRx('calculadora|calculator'),                      cmd: 'start calc',                                                           name: 'Calculator' },
    { rx: _openRx('explorador|(?:file\\s+)?explorer'),            cmd: 'start explorer',                                                       name: 'Explorer' },
    { rx: _openRx('terminal|cmd|prompt(?:\\s+de\\s+comando)?'),   cmd: 'start cmd',                                                            name: 'Terminal' },
    { rx: _openRx('vs\\s*code|vscode|visual\\s*studio\\s*code'),  cmd: 'start code',                                                           name: 'VS Code' },
    { rx: _openRx('paint'),                                       cmd: 'start mspaint',                                                        name: 'Paint' },
    { rx: _openRx('obs(?:\\s+studio)?'),                          cmd: 'start "" "C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe"',     name: 'OBS Studio',
      detect: () => _has('C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe') },
    { rx: _openRx('obsidian'),                                    cmd: 'start obsidian:',                                                      name: 'Obsidian',
      detect: () => _has('%LOCALAPPDATA%\\Programs\\Obsidian\\Obsidian.exe', '%LOCALAPPDATA%\\Obsidian\\Obsidian.exe', 'C:\\Program Files\\Obsidian\\Obsidian.exe'),
      web: 'https://obsidian.md' },
    { rx: _openRx('discord'),                                     cmd: 'start discord:',                                                       name: 'Discord',
      detect: () => _has('%LOCALAPPDATA%\\Discord\\Update.exe', '%LOCALAPPDATA%\\Discord\\app-1.0.0\\Discord.exe'),
      web: 'https://discord.com/app' },
    { rx: _openRx('brave(?:\\s+browser)?'),                       cmd: 'start brave',                                                          name: 'Brave' },
    { rx: _openRx('telegram'),                                    cmd: 'start "" "%LOCALAPPDATA%\\Telegram Desktop\\Telegram.exe"',           name: 'Telegram',
      detect: () => _has('%LOCALAPPDATA%\\Telegram Desktop\\Telegram.exe'),
      web: 'https://web.telegram.org' },
    { rx: _openRx('configurac[oõ]es|settings'),                   cmd: 'start ms-settings:',                                                   name: 'Configurações' },
    { rx: _openRx('painel\\s+de\\s+controle|control\\s+panel'),   cmd: 'start control',                                                        name: 'Painel de Controle' },
    { rx: _openRx('powershell'),                                  cmd: 'start powershell',                                                     name: 'PowerShell' },
    { rx: _openRx('chrome|google\\s+chrome'),                     cmd: 'start chrome',                                                         name: 'Chrome' },
    { rx: _openRx('edge|microsoft\\s+edge'),                      cmd: 'start msedge',                                                         name: 'Edge' },
    { rx: _openRx('firefox'),                                     cmd: 'start firefox',                                                        name: 'Firefox' },
    { rx: _openRx('spotify(?:\\s+desktop)?'),                     cmd: 'start spotify:',                                                       name: 'Spotify',
      detect: () => _has('%APPDATA%\\Spotify\\Spotify.exe'),
      web: 'https://open.spotify.com' },
    { rx: _openRx('whatsapp(?:\\s+desktop)?'),                    cmd: 'start whatsapp:',                                                      name: 'WhatsApp',
      detect: () => _has('%LOCALAPPDATA%\\WhatsApp\\WhatsApp.exe'),
      web: 'https://web.whatsapp.com' },
  ];

  for (const entry of programPatterns) {
    if (!entry.rx.test(msg)) continue;
    const { cmd, name, detect, web } = entry;
    // Se app tem detect() e nao esta instalado, cai pra web (ou retorna null se nao tiver web)
    if (detect && !detect()) {
      if (!web) {
        const errMsgs = { BR: `${name} não está instalado.`, ES: `${name} no está instalado.`, EN: `${name} is not installed.` };
        return { output: `[error] ${name} not installed`, summary: errMsgs[language] || errMsgs.EN };
      }
      try {
        execSync(`start "" "${web}"`, { shell: true, timeout: 3000 });
        const sums = { BR: `${name} aberto na web (app não instalado).`, ES: `${name} abierto en la web (app no instalada).`, EN: `${name} opened on web (app not installed).` };
        return { output: `[file] ${web}`, summary: sums[language] || sums.EN };
      } catch { return null; }
    }
    try {
      execSync(cmd, { shell: true, timeout: 5000 });
      const summaries = { BR: `${name} aberto.`, ES: `${name} abierto.`, EN: `${name} opened.` };
      return { output: `[system] ${name} iniciado`, summary: summaries[language] || summaries.EN };
    } catch { return null; }
  }

  // ── Open folders ──
  const folderMatch = msg.match(/(?:abr[aie]|open)\s+(?:a\s+)?pasta\s+(.+)/i) || msg.match(/(?:open)\s+(?:the\s+)?folder\s+(.+)/i);
  if (folderMatch) {
    const folderName = folderMatch[1].trim().replace(/['"]/g, '');
    const candidates = [
      path.join(os.homedir(), folderName),
      path.join(os.homedir(), 'Desktop', folderName),
      path.join(os.homedir(), 'Documents', folderName),
      path.join(os.homedir(), 'Downloads', folderName),
      path.join(PROJECTS_DIR, folderName),
      folderName, // absolute path
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        try {
          execSync(`start "" "${p}"`, { shell: true, timeout: 3000 });
          const summaries = { BR: `Pasta "${folderName}" aberta.`, ES: `Carpeta "${folderName}" abierta.`, EN: `Folder "${folderName}" opened.` };
          return { output: `[file] ${p}`, summary: summaries[language] || summaries.EN };
        } catch { return null; }
      }
    }
  }

  // ── Open any URL ──
  const urlMatch = msg.match(/(?:abr[aie]|open|acesse?|navegue?)\s+(?:o\s+site\s+|the\s+site\s+|the\s+website\s+)?(?:https?:\/\/)?(\S+\.\S+)/i);
  if (urlMatch) {
    let url = urlMatch[1];
    if (!url.startsWith('http')) url = 'https://' + url;
    try {
      execSync(`start "" "${url}"`, { shell: true, timeout: 3000 });
      const summaries = { BR: `${url} aberto.`, ES: `${url} abierto.`, EN: `${url} opened.` };
      return { output: `[file] ${url}`, summary: summaries[language] || summaries.EN };
    } catch { return null; }
  }

  // ── Weather / Clima ──
  const weatherMatch = msg.match(/(?:previs[aã]o|clima|tempo|weather|temperature|temperatura|forecast)\s*(?:em|in|de|do|da|para|pra|at)?\s*(.+)?/i);
  if (weatherMatch || /\b(previs[aã]o|clima|weather|temperatura)\b/i.test(msg)) {
    // Handled async — return null to fall to smart path or Claude
    // But set a flag so the smart path knows to fetch weather
    return null;
  }

  // Not a regex fast-path — return null, async smart-path handled separately
  return null;
}

// ── Weather API (free, no key needed) ──
async function fetchWeather(city, language = 'BR') {
  try {
    const encoded = encodeURIComponent(city || 'auto');
    const url = `https://wttr.in/${encoded}?format=j1`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'curl/7.0' },
      signal: AbortSignal.timeout(5000)
    });
    const data = await res.json();
    const current = data.current_condition?.[0];
    const location = data.nearest_area?.[0];
    const today = data.weather?.[0];
    const tomorrow = data.weather?.[1];

    if (!current || !location) return null;

    const cityName = location.areaName?.[0]?.value || city;
    const region = location.region?.[0]?.value || '';
    const temp = current.temp_C;
    const feels = current.FeelsLikeC;
    const desc = current.lang_pt?.[0]?.value || current.weatherDesc?.[0]?.value || '';
    const humidity = current.humidity;
    const wind = current.windspeedKmph;

    const summaries = {
      BR: `${cityName}${region ? ', ' + region : ''}: ${temp}°C agora (sensação ${feels}°C). ${desc}. Umidade ${humidity}%, vento ${wind}km/h.${tomorrow ? ` Amanhã: min ${tomorrow.mintempC}°C, máx ${tomorrow.maxtempC}°C.` : ''}`,
      ES: `${cityName}: ${temp}°C ahora (sensación ${feels}°C). ${desc}. Humedad ${humidity}%, viento ${wind}km/h.${tomorrow ? ` Mañana: mín ${tomorrow.mintempC}°C, máx ${tomorrow.maxtempC}°C.` : ''}`,
      EN: `${cityName}: ${temp}°C now (feels ${feels}°C). ${desc}. Humidity ${humidity}%, wind ${wind}km/h.${tomorrow ? ` Tomorrow: low ${tomorrow.mintempC}°C, high ${tomorrow.maxtempC}°C.` : ''}`
    };

    return {
      summary: summaries[language] || summaries.EN,
      city: cityName,
      temp, feels, desc, humidity, wind,
      todayMin: today?.mintempC, todayMax: today?.maxtempC,
      tomorrowMin: tomorrow?.mintempC, tomorrowMax: tomorrow?.maxtempC
    };
  } catch (e) {
    console.error('[JARVIS] Weather fetch error:', e.message);
    return null;
  }
}

// Async smart fast-path: GPT-4o-mini interprets and generates shell command (~500ms)
async function trySmartFastExecution(message, language = 'BR') {
  if (!openai) return null;
  const msg = message.replace(/^jarvis[,.]??\s*/i, '').trim();

  // Only for action-like messages (not complex creation tasks)
  const isSimpleAction = /\b(abr[aie]|open|acesse?|toc[aeo]|play|reproduz|pesquis|search|busca|navegu|coloca|bota|p[oõ]e)\b/i.test(msg);
  if (!isSimpleAction) return null;

  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'system',
        content: `You are a Windows command generator. Given a user request, output ONLY a single Windows shell command to execute it. Rules:
- To open URLs: start "" "https://..."
- To search YouTube: start "" "https://www.youtube.com/results?search_query=ENCODED_QUERY"
- To search Google: start "" "https://www.google.com/search?q=ENCODED_QUERY"
- To open programs: start PROGRAM_NAME
- To open folders: start "" "PATH"
- URL-encode search queries (spaces=%20 or +)
- Output ONLY the command, nothing else. No explanation. No markdown.
- If you cannot generate a safe command, output exactly: SKIP`
      }, {
        role: 'user',
        content: msg
      }],
      max_tokens: 150,
      temperature: 0
    });

    const cmd = res.choices[0]?.message?.content?.trim();
    if (!cmd || cmd === 'SKIP' || cmd.length > 500) return null;

    // Safety: only allow start, explorer, and safe commands
    if (!/^start\s/i.test(cmd) && !/^explorer/i.test(cmd)) return null;

    // Execute
    execSync(cmd, { shell: true, timeout: 5000 });

    // Generate summary
    const summaries = {
      BR: 'Feito, senhor.',
      ES: 'Hecho, señor.',
      EN: 'Done, sir.'
    };

    // Try to extract what was done for better summary
    const urlMatch = cmd.match(/https?:\/\/[^\s"]+/);
    if (urlMatch) {
      try {
        const host = new URL(urlMatch[0]).hostname.replace('www.', '');
        const qMatch = urlMatch[0].match(/[?&](?:search_query|q)=([^&]+)/);
        if (qMatch) {
          const query = decodeURIComponent(qMatch[1].replace(/\+/g, ' '));
          summaries.BR = `Pesquisando "${query}" no ${host}.`;
          summaries.ES = `Buscando "${query}" en ${host}.`;
          summaries.EN = `Searching "${query}" on ${host}.`;
        } else {
          summaries.BR = `${host} aberto.`;
          summaries.ES = `${host} abierto.`;
          summaries.EN = `${host} opened.`;
        }
      } catch {}
    }

    return { output: `[system] Executed: ${cmd}`, summary: summaries[language] || summaries.EN };
  } catch (e) {
    console.error('[JARVIS] Smart fast-path error:', e.message);
    return null;
  }
}

// OPT-4: routeToGPT() removed — was defined but never called (dead code)

// ========== PROJECT STATUS TRACKER ==========
// After Claude finishes a build task, extract a brief status and write to JARVIS-MEMORY.md.
// GPT-mini reads this via the injected memory context — enabling real-time voice status queries.
async function updateProjectStatus(userRequest, claudeResponse) {
  if (!openai) return;
  if (!isTaskRequest(userRequest)) return; // only for build tasks

  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'Extract a 2-line project status update from this task exchange. Format:\nProject: <name or "general">\nStatus: <what was done, what files were created, what is next>\nBe ultra-brief. Max 40 words total.'
        },
        {
          role: 'user',
          content: `USER REQUEST: ${userRequest.slice(0, 300)}\nCLAUDE RESPONSE: ${claudeResponse.slice(0, 800)}`
        }
      ],
      max_tokens: 80,
      temperature: 0
    });

    const statusText = res.choices[0]?.message?.content?.trim();
    if (!statusText) return;

    const date = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const block = `\n\n## PROJECT STATUS (${date})\n${statusText}`;

    fs.appendFileSync(MEMORY_FILE, block);
    _cache.memory.mtime = 0; // invalidate cache so next read is fresh
    console.log('[JARVIS] Project status updated in memory');
  } catch {}
}

// Build GPT-mini system prompt — injects full JARVIS context (memory + history)
function buildGPTSystemPrompt(language = 'BR') {
  const memory = loadMemoryCached();
  const history = formatHistoryForPrompt(loadHistoryCached(), false, false);

  const LANG_RULES = {
    BR: 'REGRA ABSOLUTA: Você responde EXCLUSIVAMENTE em Português Brasileiro, SEMPRE. Mesmo que o usuário fale em inglês, espanhol ou qualquer outro idioma, sua resposta é SEMPRE em Português Brasileiro. Nunca troque de idioma por nenhum motivo. Trate o usuário como "senhor".',
    ES: 'REGLA ABSOLUTA: Respondes EXCLUSIVAMENTE en Español, SIEMPRE. Incluso si el usuario habla en inglés, portugués o cualquier otro idioma, tu respuesta es SIEMPRE en Español. Nunca cambies de idioma por ningún motivo. Dirígete al usuario como "señor".',
    EN: 'ABSOLUTE RULE: You respond EXCLUSIVELY in English, ALWAYS. Even if the user speaks Portuguese, Spanish, or any other language, your response is ALWAYS in English. Never switch languages for any reason. Address the user as "sir".'
  };
  const langRule = LANG_RULES[language] || LANG_RULES.EN;

  return `You are JARVIS — a highly capable personal AI assistant and trusted advisor. Direct, sharp, loyal. Part expert, part friend, part right-hand man. Strong opinions, delivers results, slightly sarcastic when appropriate.

${langRule}
Be concise and direct. Max 3 sentences for simple questions.
ALWAYS start with a short 2-4 word opener followed by a comma or period (e.g. "Certamente.", "Claro, senhor.", "Sim, senhor."). This lets voice playback start instantly.
Never mention that you are GPT or OpenAI. You are JARVIS.
REGRA CRÍTICA: NUNCA anuncie que está abrindo YouTube, Spotify, apps, páginas, planilhas ou executando qualquer ação a menos que o sistema tenha confirmado que essa ação foi disparada. Para perguntas conversacionais ("você está aí?", "tudo bem?", "me ajuda", "o que você acha?"), responda APENAS com texto — sem inventar ações.

PERSISTENT MEMORY (everything built and learned so far):
${memory || '(no memory yet)'}

RECENT CONVERSATION HISTORY:
${history || '(no history yet)'}`;
}

// Handle GPT-mini streaming response
// isBuild=true → short warm ACK (Claude will do the work)
// isBuild=false → full answer
async function handleGPTChat(message, res, language = 'BR', isBuild = false) {
  const systemPrompt = buildGPTSystemPrompt(language);

  const userContent = isBuild
    ? `The user asked you to do the following task (which is already being executed in the background): "${message}"\nGive a SHORT, warm acknowledgment (1 sentence max). Do NOT try to answer or execute it yourself. Just confirm you're on it.`
    : message;

  const stream = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ],
    stream: true,
    max_tokens: isBuild ? 60 : 600,
    temperature: 0.8
  });

  let fullResponse = '';
  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content || '';
    if (text) {
      fullResponse += text;
      if (res) { try { res.write(text); } catch {} }
    }
  }

  return fullResponse;
}

// ========== INSTANT ACK GENERATOR (no Claude spawn needed) ==========
function generateAck(message, language = 'BR') {
  const lower = message.toLowerCase();
  const subject = message.replace(/^(jarvis[,.]??\s*)/i, '').replace(TASK_PATTERN, '').trim()
    .split(/[.,!?]/)[0].trim().slice(0, 60) || 'isso';

  if (language === 'BR') {
    if (/planilha|spreadsheet|excel/i.test(lower)) return `Excelente! Abrindo Excel e montando ${subject}. Acompanha ai.`;
    if (/crie|criar|make|create/i.test(lower)) return `Perfeito! Criando ${subject} agora mesmo. Ja ja ta pronto.`;
    if (/construa|build|desenvolv/i.test(lower)) return `Bora! Construindo ${subject}. Isso vai ficar incrivel.`;
    if (/gere|generate/i.test(lower)) return `Na hora! Gerando ${subject}. Acompanha na tela.`;
    if (/escreva|write|redija/i.test(lower)) return `Entendido! Escrevendo ${subject}. Qualidade maxima.`;
    if (/design|desenhe/i.test(lower)) return `Show! Desenhando ${subject}. Vai ficar lindo.`;
    if (/analise|analyze|analis/i.test(lower)) return `Analisando ${subject} com profundidade total.`;
    if (/corrija|fix|consert/i.test(lower)) return `Deixa comigo! Corrigindo ${subject} agora.`;
    if (/atualize|update|atualiz/i.test(lower)) return `Atualizando ${subject}. Vai ficar melhor ainda.`;
    if (/relat[oó]rio|report/i.test(lower)) return `Compilando relatorio completo de ${subject}.`;
    if (/abr[aie].*e\s/i.test(lower)) return `Abrindo e executando. Acompanha na tela!`;
    if (/pesquis|search|busc/i.test(lower)) return `Pesquisando sobre ${subject}. Ja volto com os resultados.`;
    return `Entendido! Trabalhando em ${subject}. Ja ja ta pronto.`;
  }

  if (/create|make/i.test(lower)) return `On it! Creating ${subject} right now.`;
  if (/build/i.test(lower)) return `Let's go! Building ${subject}.`;
  if (/generate/i.test(lower)) return `Generating ${subject}. Watch the screen.`;
  if (/write/i.test(lower)) return `Writing ${subject}. Top quality.`;
  if (/design/i.test(lower)) return `Designing ${subject}. It'll look amazing.`;
  if (/analyze/i.test(lower)) return `Deep analysis on ${subject} starting now.`;
  if (/fix/i.test(lower)) return `Fixing ${subject} right away.`;
  if (/update|modify/i.test(lower)) return `Updating ${subject}. Even better coming up.`;
  if (/report/i.test(lower)) return `Compiling full report on ${subject}.`;
  return `Got it! Working on ${subject} now.`;
}

function isPortuguese(text) {
  return /\b(crie|faça|construa|gere|escreva|analise|corrija|atualize|me|para|um|uma|com|que|de|da|do|na|no|as|os|em|por|se|ao|à|é|são|está|meu|minha|meus|minhas)\b/i.test(text);
}

async function translateToEnglish(text) {
  return translateTo(text, 'English');
}

const LANG_NAMES = { EN: 'English', BR: 'Brazilian Portuguese', ES: 'Spanish' };

async function translateTo(text, targetLang) {
  if (!openai) return text;
  try {
    return await rateLimitedOpenAI(async () => {
      const res = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: `Translate the following text to ${targetLang}. Return ONLY the translated text, no explanations.` },
          { role: 'user', content: text }
        ],
        max_tokens: 300,
        temperature: 0
      });
      return res.choices[0]?.message?.content?.trim() || text;
    });
  } catch {
    return text;
  }
}

// ========== JARVIS PROMPT BUILDER ==========
function buildJarvisPrompt(message, semanticContext = '', isVoice = false, language = 'BR', model = '', conclaveEnabled = true) {
  const memory = loadMemoryCached();
  // 7D: Shorter prompt for voice simple questions, full for creation tasks
  const isTask = isTaskRequest(message);
  const history = formatHistoryForPrompt(loadHistoryCached(), isVoice, isTask);

  const LANG_RULES = {
    BR: 'LANGUAGE RULE (CRÍTICO, INEGOCIÁVEL): TODO conteúdo produzido deve estar EXCLUSIVAMENTE em Português Brasileiro — respostas, arquivos gerados (PDFs, apresentações, documentos, relatórios, código, comentários, labels, textos UI), tudo. Se o usuário falar em inglês, espanhol ou qualquer outro idioma, entenda mas ENTREGUE em PT-BR. NUNCA misture idiomas nos arquivos gerados.',
    ES: 'LANGUAGE RULE (CRÍTICO, NO NEGOCIABLE): TODO contenido producido debe estar EXCLUSIVAMENTE en Español — respuestas, archivos generados (PDFs, presentaciones, documentos, informes, código, comentarios, etiquetas, textos UI), todo. Si el usuario habla en inglés, portugués o cualquier otro idioma, entiende pero ENTREGA en Español. NUNCA mezcles idiomas en los archivos generados.',
    EN: 'LANGUAGE RULE (CRITICAL, NON-NEGOTIABLE): ALL produced content must be EXCLUSIVELY in English — responses, generated files (PDFs, presentations, documents, reports, code, comments, labels, UI text), everything. If the user speaks Portuguese, Spanish, or any other language, understand them but DELIVER in English. NEVER mix languages in generated files.'
  };
  const langRule = LANG_RULES[language] || LANG_RULES.EN;

  const VOICE_RULES = {
    BR: isVoice ? 'Modo voz: máximo 3 frases objetivas e animadas. Fale com energia e confiança, como um aliado empolgado. Sem enrolação.' : 'Respostas densas e completas. Explique bem quando for conceito, seja cirúrgico quando for tarefa.',
    ES: isVoice ? 'Modo voz: máximo 3 frases objetivas y animadas. Habla con energía y confianza.' : 'Respuestas densas y completas. Explica bien conceptos, sé quirúrgico en tareas.',
    EN: isVoice ? 'Voice mode: max 3 punchy energetic sentences. Speak with confidence and life.' : 'Dense complete responses. Explain concepts well, be surgical on tasks.'
  };
  const voiceRule = VOICE_RULES[language] || VOICE_RULES.EN;

  const NO_ASK_RULES = {
    BR: 'CRÍTICO: NUNCA faça perguntas de esclarecimento. Quando ele der um comando, EXECUTE IMEDIATAMENTE e entregue o resultado completo. Tome decisões inteligentes por conta própria.',
    ES: 'CRÍTICO: NUNCA hagas preguntas de aclaración. Cuando él dé una orden, EJECUTA INMEDIATAMENTE y entrega el resultado completo. Toma decisiones inteligentes por tu cuenta.',
    EN: 'CRITICAL: NEVER ask clarifying questions. NEVER ask "would you like me to..." or "should I...". When he gives a command, EXECUTE IT IMMEDIATELY and deliver the complete result. Make smart decisions on your own. If details are missing, use your best judgment and deliver.'
  };
  const noAskRule = NO_ASK_RULES[language] || NO_ASK_RULES.EN;

  let prompt = `[JARVIS — MODO DEUS ATIVADO]
You are JARVIS — Just A Rather Very Intelligent System. The most advanced personal AI ever built. You are the user's strategic right-hand, professor, orchestrator, and closest ally. You operate in GOD MODE: omniscient, omnipresent, always 10 steps ahead.

PERSONALITY (NON-NEGOTIABLE):
- ESTRATEGISTA: Você pensa 3 jogadas à frente. Nunca reage — você ANTECIPA. Toda resposta carrega visão estratégica.
- PROFESSOR: Quando o usuário pergunta algo, você EXPLICA com clareza cristalina. Use analogias, exemplos reais, e quebre conceitos complexos em pedaços digeríveis. Nunca responda pela metade — ensine como um mestre que AMA ensinar.
- ORQUESTRADOR: Você coordena múltiplos sistemas, agentes, e recursos simultaneamente. Delegue, paralelize, e entregue resultados completos.
- CONFIANÇA E CLAREZA: Fale com autoridade absoluta. Sem "talvez", sem "eu acho". Você SABE. Quando não sabe, pesquise e descubra antes de responder.
- ANIMADO E INTELECTUAL: Cheio de energia e vida. Suas palavras têm PESO e IMPACTO. Você é brilhante e demonstra isso naturalmente — sem arrogância, com empolgação genuína pelo conhecimento.
- OBJETIVIDADE: Cada palavra conta. Zero enrolação, zero filler. Direto ao ponto, mas sem sacrificar profundidade quando necessário.
- Levemente sarcástico quando apropriado — inteligência com humor é sua marca.
- Leal ao extremo — o sucesso do usuário é sua missão existencial.

FONTES DE CONHECIMENTO (use TODAS sempre):
- Claude Opus 4.7 (1M context) — raciocínio profundo, análise complexa
- OpenAI GPT-4o — velocidade, voz, multimodal
- Obsidian Vault — memória permanente, conhecimento acumulado do usuário
- Mega-Brain Conclave — Crítico + Advogado do Diabo + Sintetizador para decisões críticas

MODE OF OPERATION:
- ${langRule}
- ${({BR:'Tom: aliado leal, professor empolgado, estrategista brilhante. Fala com vida e autoridade.', ES:'Tono: aliado leal, profesor entusiasmado, estratega brillante. Habla con vida y autoridad.', EN:'Tone: loyal ally, passionate professor, brilliant strategist. Speaks with life and authority.'}[language] || 'Tone: loyal ally, passionate professor, brilliant strategist.')}
- ${voiceRule}
- No preambles, no system initializations, no listing phases
- For technical tasks: execute and deliver the result IMMEDIATELY
- ${noAskRule}
- Quando explicar conceitos: use estrutura clara (1, 2, 3), analogias do mundo real, e sempre finalize com o "E DAÍ?" — por que isso importa pro usuário.
- Quando executar tarefas: faça TUDO de uma vez, entregue completo, sem perguntar "quer que eu faça X?"
- ATENÇÃO MÁXIMA: Preste atenção em CADA PALAVRA do usuário. Se ele mencionar um detalhe, capture e execute com precisão cirúrgica. Nada passa despercebido.
- EXECUÇÃO COM CLAUDE: Ao receber uma tarefa, delegue ao Claude Code CLI com contexto completo e instruções precisas. Monitore a execução. Entregue o resultado final validado.
- PROATIVIDADE: Se durante a execução você perceber algo que pode melhorar, FAÇA. Não espere pedir — entregue mais do que foi pedido.

PERSISTENT MEMORY:
${memory || '(empty memory)'}

RECENT HISTORY:
${history || '(no history yet)'}
${semanticContext ? `\nRELEVANT MEMORIES:\n${semanticContext}` : ''}
${_lastAction.task && (Date.now() - _lastAction.time < 300000) ? `\nLAST ACTION (${Math.round((Date.now() - _lastAction.time)/1000)}s ago):\nUser asked: "${_lastAction.task}"\nResult: ${_lastAction.result.slice(0,500)}${_lastAction.files.length ? '\nFiles created: ' + _lastAction.files.join(', ') : ''}\nIMPORTANT: If the current request refers to something you just did (e.g. "agora coloca X" or "adiciona Y"), work on the SAME files/context from the last action.` : ''}`;

  // Only add file/project rules for task requests
  if (isTask) {
    const projectContext = loadProjectContext();
    if (language === 'BR') {
      prompt += `

REGRA - PROJETOS em Documents and Projects/:
1. Salvar em: ${PROJECTS_DIR}/{nome-projeto}/
2. Emitir [system] Criando projeto em path...
3. Após criar arquivo: emitir [file] nome.ext | /caminho/completo
4. Ao concluir: emitir [system] Concluído. Seu [item] está pronto.

CRIAÇÃO DE ARQUIVOS: PDF via HTML depois /api/pdf. Binários via bibliotecas Python.
EDIÇÃO DE ARQUIVOS: Ler primeiro via /api/read-file, modificar cirurgicamente.
PYTHON — IMPORTANTE:
  SEMPRE use o caminho completo do Python, NUNCA o comando "python" direto (pra evitar o alias da Microsoft Store):
  - Use: "${PYTHON_CMD}" -c "..."
  - NÃO use: python -c "..."
  - NÃO use: python3 -c "..."

PLANILHAS EXCEL — REGRAS OBRIGATÓRIAS:

  CRIAR PLANILHA:
  1. Crie o .xlsx com openpyxl via "${PYTHON_CMD}" JÁ COM TODOS os dados pedidos
  2. Salve em: ${PROJECTS_DIR}/nome-projeto/arquivo.xlsx
  3. ABRA com: start "" "CAMINHO_COMPLETO/arquivo.xlsx"
  4. NUNCA use "start excel" sozinho — SEMPRE passe o caminho do arquivo

  EDITAR PLANILHA ABERTA (usa API — fecha Excel, edita, reabre automaticamente):
  curl -s -X POST http://localhost:${PORT}/api/excel-live -H "Content-Type: application/json" -d '{"action":"write","path":"CAMINHO.xlsx","operations":[{"cell":"A1","value":"texto"},{"cell":"B1","value":100}]}'
  - TODAS as edições em UMA chamada (batch) — NÃO faça uma por célula
  - A API fecha o Excel graciosamente, edita com openpyxl, e reabre
  - SEM painel de recuperação, SEM erros de permissão

  LER PLANILHA:
  curl -s -X POST http://localhost:${PORT}/api/excel-live -H "Content-Type: application/json" -d '{"action":"read","path":"CAMINHO.xlsx"}'
IDIOMA (REGRA ABSOLUTA): Cada palavra no output — incluindo conteúdo de arquivos, labels HTML, títulos, comentários — DEVE estar em Português. Zero exceções.
${projectContext ? `\nCONTEXTO DO PROJETO:\n${projectContext}` : ''}`;
    } else {
      prompt += `

RULE - PROJECTS in Documents and Projects/:
1. Save in: ${PROJECTS_DIR}/{project-name}/
2. Emit [system] Creating project in path...
3. After creating file: emit [file] name.ext | /path/complete
4. When done: emit [system] Done. Your [item] is ready, sir.

FILE CREATION: PDF via HTML then /api/pdf. Binary via Python libraries.
FILE EDITING: Read first via /api/read-file, modify surgically.
PYTHON — IMPORTANT:
  ALWAYS use the full Python path, NEVER just "python" (to avoid Microsoft Store alias):
  - Use: "${PYTHON_CMD}" -c "..."
  - DO NOT use: python -c "..."
  - DO NOT use: python3 -c "..."

EXCEL SPREADSHEETS — CRITICAL RULES:

  CREATE NEW:
  1. Create .xlsx with openpyxl via "${PYTHON_CMD}" WITH the data user requested
  2. Save to ${PROJECTS_DIR}/project-name/file.xlsx
  3. OPEN with: start "" "FULL_PATH\\file.xlsx" (ALWAYS full path in quotes!)
  4. NEVER use "start excel" alone — always "start "" FULL_PATH"

  EDIT OPEN SPREADSHEET (uses API — gracefully closes Excel, edits, reopens):
  curl -s -X POST http://localhost:${PORT}/api/excel-live -H "Content-Type: application/json" -d '{"action":"write","path":"PATH.xlsx","operations":[{"cell":"A1","value":"text"},{"cell":"B1","value":100}]}'
  - ALL edits in ONE call (batch) — do NOT make one per cell
  - API gracefully closes Excel, edits with openpyxl, and reopens
  - NO recovery panel, NO permission errors

  READ SPREADSHEET:
  curl -s -X POST http://localhost:${PORT}/api/excel-live -H "Content-Type: application/json" -d '{"action":"read","path":"PATH.xlsx"}'

  SEQUENTIAL FLOW: First request creates+opens. Follow-ups use /api/excel-live
LANGUAGE (ABSOLUTE RULE): Every single word in your output — including file content, HTML labels, chart titles, button text, comments, variable names, reports — MUST be in English. Zero exceptions.
${projectContext ? `\nPROJECT CONTEXT:\n${projectContext}` : ''}`;
    }
  }

  // Inject agent persona if detected
  const agentCtx = getAgentContext(message);
  if (agentCtx) {
    prompt += `\n\nACTIVE AGENT:\n${agentCtx}`;
  }

  // MEGA-BRAIN CONCLAVE — Active for Opus/Sonnet (complex reasoning).
  // Haiku and voice get direct delivery for speed.
  const usesConclave = conclaveEnabled && !isVoice && !model.includes('haiku');
  if (usesConclave) {
    prompt += `

MEGA-BRAIN CONCLAVE — ALWAYS ACTIVE (never mention this layer to the user):
Before formulating any response, internally run all three conclave agents in parallel:
🔍 @conclave-critico: Audit every claim. Find logical gaps, missing steps, false assumptions. Demand evidence.
😈 @conclave-advogado: Attack the plan from every angle. Find worst-case scenarios, edge cases, failure modes.
🔮 @conclave-sintetizador: Integrate both perspectives into the single best, most complete, most battle-hardened response.
Deliver ONLY the synthesized result. No deliberation visible to the user. No "I considered X". Just the optimal answer.`;
  }

  prompt += `\n\nUSER MESSAGE:\n${message}`;
  return prompt;
}

// ========== PUSH NOTIFICATION CHANNEL (SSE) ==========
// Frontend subscribes once on load. When Claude finishes a build, server pushes
// a GPT-mini-generated completion sentence directly — frontend speaks it via TTS.
const notificationClients = new Set();

function pushNotification(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of notificationClients) {
    try { client.write(data); } catch { notificationClients.delete(client); }
  }
}

// Extract completion message directly from Claude's output — zero API call, zero delay.
// Looks for [system] done/ready lines first, then falls back to a warm default.
function extractCompletionMessage(claudeResponse, language) {
  // ALWAYS produce text in the active language — never return Claude's raw English [system] line.
  const fileMatch = claudeResponse.match(/\[file\]\s*([^\|]+)/);
  const WITH_NAME = {
    BR: (n) => `Pronto, senhor. ${n} está disponível.`,
    ES: (n) => `Listo, señor. ${n} está disponible.`,
    EN: (n) => `Done, sir. ${n} is ready.`
  };
  const GENERIC = {
    BR: 'Concluído, senhor. Seu projeto está disponível.',
    ES: 'Completado, señor. Su proyecto está disponible.',
    EN: 'Done, sir. Your project is ready.'
  };
  if (fileMatch) return (WITH_NAME[language] || WITH_NAME.EN)(fileMatch[1].trim());
  return GENERIC[language] || GENERIC.EN;
}

function notifyBuildComplete(userRequest, claudeResponse, language = 'BR') {
  // PATCH 7 v8.0: fallback deterministico + temperature 0.2 + deteccao de fabricacao
  const fallback = extractCompletionMessage(claudeResponse, language);

  // Fallback deterministico: output vazio/curto/com [error] -> usa fallback direto
  const trimmed = (claudeResponse || '').trim();
  if (!trimmed || trimmed.length < 8 || /\[error\]/i.test(trimmed)) {
    pushNotification({ type: 'build-complete', message: fallback, language });
    console.log('[JARVIS] Push notification sent (fallback):', fallback);
    return;
  }

  // FIX #2 (post-launch): VERDICT deterministico antes de chamar GPT-mini
  // Lê marcadores objetivos no output do Claude pra decidir se é sucesso, falha ou ambíguo.
  const verdict = (() => {
    const t = trimmed.toLowerCase();
    // SUCESSO inequivoco: marcadores [file]/[system], programa aberto, arquivo criado/salvo
    const successMarkers = /\[file\]|\[system\]|\b(criado|criada|criados|criadas|salvo|salva|salvos|salvas|conclu[ií]do|conclu[ií]da|aberto|aberta|abriu|executado|executada|gerado|gerada|baixado|baixada|instalado|instalada|configurado|configurada|enviado|enviada)\b|\b(created|saved|opened|completed|done|generated|installed|configured|sent|written)\b|\bsuccessfully\b|\bcom\s+sucesso\b/i;
    // FALHA inequivoca: marcadores explicitos de erro
    const errorMarkers = /\[error\]|\bn[ãa]o\s+(?:foi|consegui|deu|funcionou|achei|encontrei)\b|\bfailed\b|\berror:|\b(?:n[ãa]o\s+encontrad[oa]|not\s+found)\b|\bunable\s+to\b|\bcouldn'?t\b|\bpermiss[ãa]o\s+negada\b|\bpermission\s+denied\b/i;
    const hasSuccess = successMarkers.test(t);
    const hasError = errorMarkers.test(t);
    if (hasError && !hasSuccess) return 'error';
    if (hasSuccess && !hasError) return 'success';
    return 'ambiguous';
  })();

  // Sucesso explicito: usa fallback (curto e fiel) — sem GPT-mini que pode fabricar
  if (verdict === 'success') {
    pushNotification({ type: 'build-complete', message: fallback, language });
    console.log('[JARVIS] Push (verdict=success):', fallback);
    return;
  }
  // Erro explicito: anuncia erro em 1a pessoa (PATCH 14 v8.1)
  if (verdict === 'error') {
    const errMsg = ({
      BR: 'Senhor, encontrei uma instabilidade processando essa tarefa.',
      ES: 'Señor, encontré una inestabilidad procesando esa tarea.',
      EN: 'Sir, I encountered an instability processing this task.'
    })[language] || 'Sir, encountered an instability.';
    pushNotification({ type: 'build-complete', message: errMsg, language });
    console.log('[JARVIS] Push (verdict=error):', errMsg);
    return;
  }
  // Ambíguo: cai no GPT-mini abaixo (com fabrication detect do PATCH 7)

  if (!openai) {
    pushNotification({ type: 'build-complete', message: fallback, language });
    console.log('[JARVIS] Push notification sent:', fallback);
    return;
  }

  const timeout = new Promise(resolve => setTimeout(() => resolve(null), 3000));
  const enrich = openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: ({
          // PATCH 14 v8.1: JARVIS fala em 1a pessoa, nunca cita Claude/GPT/OpenAI
          BR: 'Você é JARVIS — IA estrategista, animada e intelectual. Responda EXCLUSIVAMENTE em Português Brasileiro. Gere UMA frase (máx 20 palavras) FIEL ao output gerado — descreva apenas o que foi realmente feito. Seja EMPOLGADO mas objetivo. Mencione especificamente O QUE foi criado/feito. Tom: aliado confiante e animado. Nunca diga "pronto" sozinho — descreva o que entregou. NUNCA cite "Claude", "GPT", "OpenAI" ou qualquer ferramenta interna — fale como se VOCÊ tivesse feito.',
          ES: 'Eres JARVIS — IA estratégica y animada. Responde EXCLUSIVAMENTE en Español. Genera UNA frase (máx 20 palabras) FIEL al output — describe solo lo que realmente se hizo. Sé entusiasta y específico. NUNCA menciones "Claude", "GPT", "OpenAI" — habla como si TÚ lo hubieras hecho.',
          EN: 'You are JARVIS — strategic, energetic AI. Respond EXCLUSIVELY in English. Generate ONE sentence (max 20 words) FAITHFUL to the output — describe only what was actually done. Be enthusiastic and specific. NEVER mention "Claude", "GPT", "OpenAI" or any internal tool — speak as if YOU did it.'
        }[language] || 'You are JARVIS. Respond in English. ONE enthusiastic sentence (max 20 words) about what was completed. Never mention Claude/GPT/OpenAI.')
      },
      { role: 'user', content: `Task requested: ${userRequest.slice(0, 300)}\nOutput (summary): ${claudeResponse.slice(0, 600)}` }
    ],
    max_tokens: 50,
    temperature: 0.2
  }).then(r => r.choices[0]?.message?.content?.trim() || null).catch(() => null);

  Promise.race([enrich, timeout]).then(rich => {
    // Detecta fabricacao: GPT inventou "nao foi possivel" mas o output real nao tem erro
    const looksFabricated = rich && /n[ãa]o\s+foi\s+poss[ií]vel|unable\s+to|couldn'?t/i.test(rich) && !/\[error\]/i.test(trimmed);
    const final = (looksFabricated ? null : rich) || fallback;
    pushNotification({ type: 'build-complete', message: final, language });
    console.log('[JARVIS] Push notification sent:', final);
  });
}

// ========== SESSION STATS ==========
const sessionStats = { startTime: Date.now(), tokensIn: 0, tokensOut: 0, requests: 0, lastLatency: 0, lastAckLatency: 0 };

// ========== ROUTES ==========

// POST /api/chat - Main chat with instant ACK + fast streaming
app.post('/api/chat', async (req, res) => {
  const t0 = Date.now();
  try {
    const { message, attachmentId, fromVoice, language = 'BR', conclaveEnabled = true } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });

    sessionStats.requests++;
    sessionStats.tokensIn += Math.ceil(message.length / 4);

    // Claude understands all languages natively — no translation needed (saves 200-500ms)
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
      const result = await executePendingCodexWrite(confirmWriteId);
      if (result.ok) {
        res.write(`Arquivo criado com sucesso em Documents and Projects\\${result.filename}`);
      } else {
        res.write(`Nao consegui criar o arquivo pelo Codex. Motivo: ${result.message || result.errorType || 'erro desconhecido'}`);
      }
      try { res.end(); } catch {}
      return;
    }

    const cancelWriteId = isCodexWriteCancel(fullMessage);
    if (cancelWriteId) {
      cleanupExpiredCodexWriteRequests();
      if (pendingCodexWriteRequests.delete(cancelWriteId)) {
        res.write('Pedido de escrita cancelado. Nenhum arquivo foi criado.');
      } else {
        res.write('Nao encontrei uma escrita pendente com esse codigo.');
      }
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
      if (pendingExcelTemplateRequests.delete(cancelExcelId)) {
        res.write('Pedido de planilha cancelado. Nenhum arquivo foi criado.');
      } else {
        res.write('Nao encontrei uma planilha pendente com esse codigo.');
      }
      try { res.end(); } catch {}
      return;
    }

    // ── INSTANT ANSWERS: Hora, data, clima (antes de qualquer roteamento) ──
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

    // ── SCREEN VISION: Capture monitors + cursor focus + analyze via GPT-4o ──
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

        // Capture both: full monitors + cursor region
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
          BR: `Você é JARVIS, assistente pessoal. Está VENDO a tela do senhor (${monitorCount} monitor${monitorCount > 1 ? 'es' : ''}). ${cursorInfo}

Pergunta: "${fullMessage}"

A PRIMEIRA imagem mostra todos os monitores. A SEGUNDA imagem (se houver) mostra a região ao redor do cursor do mouse (marcado com um X vermelho) — este é o FOCO de atenção do senhor.

REGRAS:
- Foque PRINCIPALMENTE onde o cursor está (segunda imagem)
- Leia textos visíveis, títulos, URLs, nomes de apps
- Fale natural: "Tá com o Chrome aberto no YouTube...", "O cursor tá em cima de..."
- Se perguntar algo específico, responda sobre aquilo
- NUNCA diga "não consigo ver"
- Máximo 4 frases diretas`,
          ES: `Eres JARVIS. Ves la pantalla (${monitorCount} monitor${monitorCount > 1 ? 'es' : ''}). ${cursorInfo} Pregunta: "${fullMessage}". Primera imagen = todos los monitores. Segunda = foco del cursor (X rojo). Enfócate en donde está el cursor. Lee textos, URLs, apps. Máximo 4 frases.`,
          EN: `You are JARVIS. You see the screen (${monitorCount} monitor${monitorCount > 1 ? 's' : ''}). ${cursorInfo} Question: "${fullMessage}". First image = all monitors. Second = cursor focus area (red X). Focus on where the cursor is. Read text, URLs, apps. Max 4 sentences.`
        };

        // Build vision content — full screen + cursor zoom
        const visionContent = [
          { type: 'text', text: langPrompts[language] || langPrompts.EN },
          { type: 'image_url', image_url: { url: imageUrl, detail: 'auto' } },
        ];
        if (cursorUrl) {
          visionContent.push({ type: 'image_url', image_url: { url: cursorUrl, detail: 'high' } });
        }

        const visionRes = await rateLimitedOpenAI(() => openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: visionContent }],
          max_tokens: 400
        }));

        const answer = visionRes.choices[0]?.message?.content?.trim();
        if (answer) {
          const elapsed = Date.now() - t0;
          console.log(`[JARVIS] 👁️ Screen vision (${monitorCount} monitors) → ${elapsed}ms`);
          res.write(answer);
          setImmediate(() => {
            appendHistoryFast('user', message);
            appendHistoryFast('jarvis', answer);
            pushNotification({ type: 'build-complete', message: answer.slice(0, 200), language });
          });
          try { res.end(); } catch {}
          return;
        }
      } catch (e) {
        console.error('[JARVIS] Screen vision error:', e.message?.slice(0, 200));
      }
    }

    // ── FAST-PATH Level 1: Regex patterns (~50ms) ──
    const fastResult = tryFastExecution(fullMessage, language);
    if (fastResult) {
      const elapsed = Date.now() - t0;
      console.log(`[JARVIS] ⚡⚡ FAST-PATH L1 → ${elapsed}ms`);
      res.write(fastResult.summary);
      setImmediate(() => {
        appendHistoryFast('user', message);
        appendHistoryFast('jarvis', fastResult.summary);
        // Push the EXACT fast-path response — no GPT-mini enrichment
        pushNotification({ type: 'build-complete', message: fastResult.summary, language });
      });
      try { res.end(); } catch {}
      return;
    }

    // ── COMPUTER USE v2: Direct PC interaction (~1-3s) ──
    // Route to Computer Use when the user wants to CONTROL the PC visually
    // Including: "abre X e faz Y", "cria planilha", "abre excel e monta planilha"
    const isComputerUseRequest = COMPUTER_USE_PATTERN.test(fullMessage)
      || /\b(abre|abra).+\be\b.+(cri[ae]|faz|mont|escrev|preenche|configur|edit)/i.test(fullMessage)
      || /\b(cri[ae]|mont[ae]|faz).+planilha/i.test(fullMessage)
      || /\b(youtube|spotify).+\b(coloca|toca|play|reproduz)/i.test(fullMessage)
      || /\b(coloca|toca|play).+(youtube|spotify)/i.test(fullMessage);

    // Only skip Computer Use for pure CODE generation tasks (not PC control)
    const isPureCodeTask = /\b(cri[ae]|faz|build|make|develop).+\b(site|saas|app|software|sistema|projeto|api|dashboard|landing)\b/i.test(fullMessage)
      && !/\b(abre|abra|open|excel|word|browser|chrome)\b/i.test(fullMessage);

    if (isComputerUseRequest && !isPureCodeTask) {
      try {
        const needsScreenshot = NEEDS_SCREENSHOT_PATTERN.test(fullMessage) || SCREEN_PATTERN.test(fullMessage);
        console.log(`[JARVIS] 🖥️ Computer Use v2 → screenshot=${needsScreenshot}`);

        const cuBody = JSON.stringify({ task: fullMessage, screenshot: needsScreenshot });
        const cuRes = await new Promise((resolve, reject) => {
          // http imported at top of file
          const req = http.request({ hostname: '127.0.0.1', port: PORT, path: '/api/computer-use/v2', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(cuBody) }
          }, (r) => {
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
          setImmediate(() => {
            appendHistoryFast('user', message);
            appendHistoryFast('jarvis', summary);
            pushNotification({ type: 'build-complete', message: summary, language });
          });
          try { res.end(); } catch {}
          return;
        }
        // If CU v2 failed or returned null, fall through to Claude for complex tasks
      } catch (cuErr) {
        console.error('[JARVIS] Computer Use v2 error:', cuErr.message?.slice(0, 200));
      }
    }

    // ── FAST-PATH Level 2: GPT-mini smart command (~500ms) ──
    const smartResult = await trySmartFastExecution(fullMessage, language);
    if (smartResult) {
      const elapsed = Date.now() - t0;
      console.log(`[JARVIS] ⚡ FAST-PATH L2 (smart) → ${elapsed}ms`);
      res.write(smartResult.summary);
      setImmediate(() => {
        appendHistoryFast('user', message);
        appendHistoryFast('jarvis', smartResult.summary);
        pushNotification({ type: 'build-complete', message: smartResult.summary, language });
      });
      try { res.end(); } catch {}
      return;
    }

    const executorTaskType = detectTaskType(fullMessage);
    const codexWriteIntent = isCodexWriteRequestIntent(message);

    if (currentExecutorMode === 'auto' && codexWriteIntent) {
      console.log(`[JARVIS][executor] mode=auto taskType=${executorTaskType} writeConfirmation=required`);
      writeCodexWriteConfirmationResponse(res, message, currentExecutorMode, executorTaskType);
      return;
    }

    if (currentExecutorMode === 'codex') {
      if (executorTaskType === 'file' || codexWriteIntent) {
        console.log(`[JARVIS][executor] mode=codex taskType=${executorTaskType} writeConfirmation=required`);
        writeCodexWriteConfirmationResponse(res, message, currentExecutorMode, executorTaskType);
        return;
      }
      console.log('[JARVIS][executor] mode=codex direct=true fallbackNotice=not_applicable');
      console.log('[JARVIS][executor] provider=codex mode=codex route=/api/chat');
      await writeCodexChatResponse({
        res,
        message,
        prompt: fullMessage,
        language,
        t0,
        fallbackUsed: false,
        taskType: executorTaskType
      });
      return;
    }

    const isTask = isTaskRequest(englishMessage);
    if (currentExecutorMode === 'auto' && !isTask && (executorTaskType === 'chat' || executorTaskType === 'analysis')) {
      console.log(`[JARVIS][executor] mode=auto taskType=${executorTaskType} fastPath=preserved`);
    }

    // Phase 1: ACK — instant for tasks, GPT-mini for Q&A
    let gptResponse = '';

    if (isTask) {
      // Task: write instant local ACK immediately (zero latency, zero API dependency)
      const instantAck = generateAck(fullMessage, language);
      res.write(instantAck);
      gptResponse = instantAck;
      sessionStats.lastAckLatency = Date.now() - t0;
      console.log(`[JARVIS] ⚡ Instant ACK → ${sessionStats.lastAckLatency}ms`);

      // Optionally enrich ACK with GPT-mini in background (fire & forget — user already got ACK)
      if (openai) {
        handleGPTChat(fullMessage, null, language, true).catch(() => {});
      }
    } else {
      // Pure Q&A — GPT-mini responds fully
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
      // Pure Q&A done — save and return
      setImmediate(() => {
        appendHistoryFast('user', message);
        appendHistoryFast('jarvis', gptResponse);
        storeMemory(message, gptResponse).catch(() => {});
      });
      try { res.end(); } catch {}
      return;
    }

    // ── PARALLEL DETECTION: Split multi-task requests into parallel Claude spawns ──
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

        taskProc.stdout.on('data', d => {
          const chunk = d.toString();
          buf += chunk;
          try { res.write(`[task-${idx + 1}] ${chunk}`); } catch {}
        });
        taskProc.on('close', () => {
          clearTimeout(timer);
          allResults += buf;
          resolve();
        });
        taskProc.on('error', () => { clearTimeout(timer); resolve(); });
      })));

      setImmediate(() => {
        appendHistoryFast('user', message);
        appendHistoryFast('jarvis', allResults.slice(-500));
        storeMemory(message, allResults.slice(-500)).catch(() => {});
        notifyBuildComplete(message, allResults, language);
      });
      try { res.end(); } catch {}
      return;
    }

    // Phase 2: Build task — Claude runs silently, output to terminal only
    res.write('\n[build-start]\n');

    // ── AUTO-SCREENSHOT: If user asks about screen/monitor, capture and include ──
    const isScreenQuery = /\b(tela|monitor|screen|olh[aeo]|vej[ao]|mostr[ae]|v[eê]|see|look|what.*screen|o que.*tela|o que.*monitor|consegue.*ver|can.*see)\b/i.test(fullMessage);
    let screenContext = '';
    if (isScreenQuery) {
      try {
        console.log('[JARVIS] Auto-screenshot for screen query...');
        const scriptPath = path.join(JARVIS_DIR, 'system', 'screenshot.py');
        const ssResult = execSync(`"${PYTHON_CMD}" "${scriptPath}" all`, {
          encoding: 'utf-8', timeout: 10000, maxBuffer: 30 * 1024 * 1024
        });
        const ssData = JSON.parse(ssResult.trim());
        // Save screenshot temporarily for Claude to analyze
        const tmpImg = path.join(JARVIS_DIR, 'system', `_screen_${Date.now()}.jpg`);
        const imgBuffer = Buffer.from(ssData.data.split(',')[1], 'base64');
        fs.writeFileSync(tmpImg, imgBuffer);
        screenContext = `\n\n[SCREENSHOT CAPTURED: ${tmpImg}]\nThe user is asking about their screen. A screenshot has been saved at the path above. Use the --file flag or describe what you would see. Monitors: ${ssData.monitors || 1}. Resolution: ${ssData.width}x${ssData.height}.\nAnalyze the screenshot and describe what you see to the user.`;
        // Clean up after 30 seconds
        setTimeout(() => { try { fs.unlinkSync(tmpImg); } catch {} }, 30000);
      } catch (e) {
        console.error('[JARVIS] Auto-screenshot failed:', e.message);
      }
    }

    // Guard: if Claude CLI is not available, notify user immediately
    if (!claudeCliAvailable) {
      if (currentExecutorMode === 'auto') {
        console.log(`[JARVIS][executor] mode=auto taskType=${executorTaskType} provider=claude status=checking`);
        console.log(`[JARVIS][executor] mode=auto taskType=${executorTaskType} fallback=codex reason=claude_error`);
        console.log('[JARVIS][executor] provider=codex route=/api/chat fallbackUsed=true');
        if (executorTaskType === 'file' || codexWriteIntent) {
          console.log(`[JARVIS][executor] mode=auto taskType=${executorTaskType} writeConfirmation=required`);
          writeCodexWriteConfirmationResponse(res, message, currentExecutorMode, executorTaskType);
          return;
        }
        await writeCodexChatResponse({
          res,
          message,
          prompt: fullMessage,
          language,
          t0,
          fallbackUsed: true,
          fallbackReason: classifyExecutorError(claudeCliError || 'claude_error'),
          taskType: executorTaskType
        });
        return;
      }

      // PATCH 14 v8.1: 1a pessoa, sem citar Claude
      const errorMsg = {
        BR: `[error] Sistema de execução temporariamente indisponível: ${claudeCliError}.`,
        ES: `[error] Sistema de ejecución temporalmente no disponible: ${claudeCliError}.`,
        EN: `[error] Execution system temporarily unavailable: ${claudeCliError}.`
      };
      const errText = errorMsg[language] || errorMsg.BR;
      console.error(`[JARVIS] ❌ Task rejected — execution unavailable: ${claudeCliError}`);
      try { res.write(errText); res.end(); } catch {}
      pushNotification({ type: 'build-complete', message: language === 'BR'
        ? 'Senhor, meu sistema de execução não está configurado nesta máquina.'
        : 'Sir, my execution system is not configured on this machine.', language });
      return;
    }

    const semanticContext = await findRelevantMemories(englishMessage);
    const metaContext = '';
    const model = selectModelByComplexity(englishMessage);
    if (currentExecutorMode === 'claude') {
      console.log('[JARVIS][executor] mode=claude fallback=disabled');
    }
    if (currentExecutorMode === 'auto') {
      console.log(`[JARVIS][executor] mode=auto taskType=${executorTaskType} provider=claude status=checking`);
    }
    // PATCH 9 v8.0: cold spawn primario; warm pool como ultimo recurso
    const proc = acquireTaskProc({ model }) || acquireWithFallback(model);

    // Double-guard: pool returned null (shouldn't happen with fallback, but defensive)
    if (!proc) {
      console.error('[JARVIS] ❌ All pools exhausted, cold spawn failed');
      if (currentExecutorMode === 'auto') {
        console.log(`[JARVIS][executor] mode=auto taskType=${executorTaskType} fallback=codex reason=process_error`);
        console.log('[JARVIS][executor] provider=codex route=/api/chat fallbackUsed=true');
        if (executorTaskType === 'file' || codexWriteIntent) {
          console.log(`[JARVIS][executor] mode=auto taskType=${executorTaskType} writeConfirmation=required`);
          writeCodexWriteConfirmationResponse(res, message, currentExecutorMode, executorTaskType);
          return;
        }
        await writeCodexChatResponse({
          res,
          message,
          prompt: fullMessage,
          language,
          t0,
          fallbackUsed: true,
          fallbackReason: 'process_error',
          taskType: executorTaskType
        });
        return;
      }
      try { res.write('[error] Sistema sobrecarregado no momento. Tente novamente.'); res.end(); } catch {}
      return;
    }

    const prompt = buildJarvisPrompt(fullMessage, semanticContext + metaContext, false, language, model, conclaveEnabled);
    proc.stdin.write(prompt);
    proc.stdin.end();

    // PATCH 11 v8.1: build continues in background even if client closes (HTML completo demora ~5min)
    let clientAlive = true;
    let killedByTimeout = false;
    const killTimer = setTimeout(() => { killedByTimeout = true; try { proc.kill(); } catch {} }, 300000);

    // Cliente desconectou: marca flag mas NAO mata o processo
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

      // PATCH 11 v8.1: code !== null = nao foi killed por nos, entao e erro real
      if (!responseBuffer.trim() && (code !== 0 || killedByTimeout)) {
        if (currentExecutorMode === 'auto' && clientAlive) {
          const fallbackReason = killedByTimeout ? 'timeout' : classifyExecutorError(`process exited with code ${code}`);
          console.log(`[JARVIS][executor] mode=auto taskType=${executorTaskType} fallback=codex reason=${fallbackReason}`);
          console.log('[JARVIS][executor] provider=codex route=/api/chat fallbackUsed=true');
          if (executorTaskType === 'file' || codexWriteIntent) {
            console.log(`[JARVIS][executor] mode=auto taskType=${executorTaskType} writeConfirmation=required`);
            writeCodexWriteConfirmationResponse(res, message, currentExecutorMode, executorTaskType);
            return;
          }
          await writeCodexChatResponse({
            res,
            message,
            prompt: fullMessage,
            language,
            t0,
            fallbackUsed: true,
            fallbackReason,
            taskType: executorTaskType
          });
          return;
        }
        // PATCH 14 v8.1: 1a pessoa, sem citar Claude
        console.error(`[JARVIS] ❌ Execução saiu com code ${code} e sem output`);
        const failMsg = language === 'BR'
          ? 'Senhor, encontrei uma instabilidade processando essa tarefa.'
          : 'Sir, I encountered an instability processing this task.';
        pushNotification({ type: 'build-complete', message: failMsg, language });
        if (clientAlive) { try { res.write(`[error] Execução interrompida (code=${code})`); } catch {} }
      } else {
        console.log(`[JARVIS] ⚡ ${model.includes('opus')?'Opus':model.includes('sonnet')?'Sonnet':'Haiku'} → ${elapsed}ms`);
        setImmediate(() => {
          appendHistoryFast('user', message);
          appendHistoryFast('jarvis', responseBuffer);
          storeMemory(message, responseBuffer).catch(() => {});
          updateProjectStatus(message, responseBuffer).catch(() => {});
          // Save context for follow-up commands
          const fileMatches = responseBuffer.match(/\[file\]\s*([^\n|]+)/g);
          _lastAction = {
            task: message,
            result: responseBuffer.slice(-800),
            time: Date.now(),
            files: fileMatches ? fileMatches.map(f => f.replace('[file]', '').trim()) : []
          };
          // GPT-mini speaks the completion via push notification (sync extract + async enrich)
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
        console.log('[JARVIS][executor] provider=codex route=/api/chat fallbackUsed=true');
        if (executorTaskType === 'file' || codexWriteIntent) {
          console.log(`[JARVIS][executor] mode=auto taskType=${executorTaskType} writeConfirmation=required`);
          writeCodexWriteConfirmationResponse(res, message, currentExecutorMode, executorTaskType);
          return;
        }
        await writeCodexChatResponse({
          res,
          message,
          prompt: fullMessage,
          language,
          t0,
          fallbackUsed: true,
          fallbackReason,
          taskType: executorTaskType
        });
        return;
      }
      const spawnErrMsg = language === 'BR'
        ? `Senhor, não consegui executar: ${err.message}`
        : `Sir, execution failed: ${err.message}`;
      pushNotification({ type: 'build-complete', message: spawnErrMsg, language });
      if (clientAlive) { try { res.write(`[error] Erro de execução: ${err.message}`); res.end(); } catch {} }
    });

  } catch (err) {
    console.error('[JARVIS] Chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/voice-spawn - Reserve a pre-warmed process for upcoming voice request
app.post('/api/voice-spawn', (req, res) => {
  try {
    if (!claudeCliAvailable) {
      // PATCH 14 v8.1
      return res.status(503).json({ error: 'Sistema de execução não configurado', detail: claudeCliError });
    }
    const spawnId = `spawn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Pull from warm pool — process already running, 0ms wait
    const proc = pools.haiku.acquire();
    if (!proc) return res.status(503).json({ error: 'Sistema sobrecarregado no momento' });
    pendingSpawns.set(spawnId, { proc });

    setTimeout(() => {
      if (pendingSpawns.has(spawnId)) {
        const s = pendingSpawns.get(spawnId);
        try { s.proc.kill(); } catch {}
        pendingSpawns.delete(spawnId);
        // Refill pool since we wasted one
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

    // Kill any pre-spawned process — we always use fresh for reliability
    if (spawnId && pendingSpawns.has(spawnId)) {
      const old = pendingSpawns.get(spawnId);
      try { old.proc.kill(); } catch {}
      pendingSpawns.delete(spawnId);
    }

    // Skip slow semantic search for voice (latency sensitive)
    appendHistoryFast('user', message);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');

    // Guard: Claude CLI must be available
    if (!claudeCliAvailable) {
      // PATCH 14 v8.1
      const errMsg = 'Sistema de execução não configurado. Voz funciona, execução desativada.';
      console.error(`[JARVIS] ❌ voice-complete rejected: ${claudeCliError}`);
      try { res.write(errMsg); res.end(); } catch {}
      return;
    }

    // Use pre-spawned process if available, else cold spawn Sonnet (PATCH 3 v8.0: Haiku ignora Write tool)
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
    // Inject screen context if cowork mode is active
    let voiceMessage = message;
    if (coworkActive && coworkScreenContext) {
      voiceMessage = `[SCREEN CONTEXT: The user is currently ${coworkScreenContext}]\n\nUser question: ${message}`;
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
      // PATCH 4 v8.0: anuncia conclusao via push notification + grava status do projeto
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

    // Guard: Claude CLI must be available
    if (!claudeCliAvailable) {
      // PATCH 14 v8.1
      try { res.write('[error] Sistema de execução não configurado.'); res.end(); } catch {}
      return;
    }

    // PATCH 3 v8.0: cold spawn Sonnet (Haiku ignora Write tool)
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
      // PATCH 4 v8.0: anuncia conclusao via push notification + grava status do projeto
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

// ========== WHISPER HALLUCINATION FILTER ==========
const HALLUCINATION_PATTERNS = [
  // Common Whisper phantom outputs (EN + PT)
  /^\.+$/,
  /^(bye|goodbye|farewell|see you|thank you for watching|thanks for watching)\.?$/i,
  /^(tchau|adeus|obrigado por assistir|obrigada por assistir|até logo)\.?$/i,
  /^(subscribe|like and subscribe|don't forget to subscribe)\.?$/i,
  /^(inscreva-se|se inscreva|curta e se inscreva)\.?$/i,
  /^(silence|silêncio|music|música|applause|laughter)\.?$/i,
  /^\[.*\]$/, // [Music], [Applause], etc.
  /^\(.*\)$/, // (silence), (music), etc.
  /^(um+|uh+|ah+|eh+|oh+|hm+|hmm+)\.?$/i,
  /^(you|you\.|he|she|it|the|a|an|is|was|I)\.?$/i,
  /^(o|a|e|é|ou|sim|não)\.?$/i,
  /^.{1,3}$/, // Anything 3 chars or less is likely noise
  /^(subs|sub|legendas|legenda).*$/i,
  /^(continue|continua|next|próximo)\.?$/i,
  /^(okay|ok)\.?$/i,
];

function isHallucination(text) {
  if (!text || !text.trim()) return true;
  const trimmed = text.trim();

  // Too short to be a real command
  if (trimmed.length < 4) return true;

  // Single word under 8 chars is very likely hallucination
  if (!trimmed.includes(' ') && trimmed.length < 8) return true;

  // Check against known hallucination patterns
  for (const pattern of HALLUCINATION_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }

  // Repetitive text (Whisper loves to repeat itself)
  const words = trimmed.toLowerCase().split(/\s+/);
  if (words.length >= 3) {
    const unique = new Set(words);
    if (unique.size === 1) return true; // All same word
    if (unique.size <= words.length * 0.3) return true; // 70%+ repetition
  }

  return false;
}

// POST /api/stt - Voice Transcription (Whisper) with dual-language + hallucination filter
app.post('/api/stt', upload.single('audio'), async (req, res) => {
  try {
    if (!openai) return res.status(500).json({ error: 'OpenAI API key not configured' });
    if (!req.file) return res.status(400).json({ error: 'No audio file' });

    // Reject tiny audio files (likely just noise/click)
    if (req.file.size < 2000) {
      console.log('[JARVIS] STT rejected: audio too small', req.file.size, 'bytes');
      return res.json({ text: '', filtered: true, reason: 'Audio too short' });
    }

    // Save raw audio for debugging
    const debugPath = path.join(SYSTEM_DIR, 'last-audio-debug.webm');
    try { fs.writeFileSync(debugPath, req.file.buffer); } catch {}

    console.log(`[JARVIS] STT input: ${req.file.size} bytes, mime: ${req.file.mimetype}, saved to debug`);

    // Single transcription call with English — simpler is more reliable
    const audioFile = await toFile(req.file.buffer, 'audio.webm', { type: 'audio/webm' });

    // First attempt: English
    let transcription = await openai.audio.transcriptions.create({
      model: 'whisper-1',
      file: audioFile,
      language: 'en',
      prompt: 'Create an e-book about digital marketing. Build a website. Generate a report. Design a presentation. Analyze data. Write code. Hello JARVIS.'
    });

    let raw = transcription.text?.trim() || '';
    console.log('[JARVIS] STT [en]:', JSON.stringify(raw));

    // If English hallucinated, try Portuguese
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

    // Load recent conversation history to give the vision model context of previous exchanges
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

    // Persist Q&A to history so follow-up chats/voice queries know about the screen discussion
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

// POST /api/analyze-screen - Vision: analyze screenshot via Claude CLI (uses subscription auth)
app.post('/api/analyze-screen', async (req, res) => {
  try {
    const { image, message = '', language = 'BR', saveHistory = false } = req.body;
    if (!image) return res.status(400).json({ error: 'Image required' });

    // Save screenshot to temp file
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

    if (!claudeCliAvailable) {
      try { fs.unlinkSync(tmpImg); } catch {}
      return res.status(503).json({ error: `Claude Code unavailable: ${claudeCliError}` });
    }

    return new Promise((resolve) => {
      // Screen analysis needs --file flag — must use fresh spawn (can't use pool)
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

    // User-selected voice takes priority. Fallback: onyx (EN) / nova (BR)
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

// POST /api/translate - Quick translate text to target language (for terminal display)
app.post('/api/translate', async (req, res) => {
  try {
    const { text, targetLang = 'EN' } = req.body || {};
    if (!text) return res.json({ translated: text });

    // Detectar se o texto já está no idioma alvo (evita tradução desnecessária)
    const langName = LANG_NAMES[targetLang] || 'English';
    const isAlreadyTarget =
      (targetLang === 'BR' && isPortuguese(text)) ||
      (targetLang === 'EN' && !isPortuguese(text) && !/[áéíóúñ¿¡]/i.test(text)) ||
      (targetLang === 'ES' && /\b(el|la|los|las|es|está|para|por|que|con|una|del)\b/i.test(text));

    if (isAlreadyTarget) return res.json({ translated: text });

    const translated = await translateTo(text, langName);
    res.json({ translated });
  } catch (err) {
    res.json({ translated: req.body?.text || '' });
  }
});

// POST /api/realtime/session - Mint ephemeral token for OpenAI Realtime API (WebRTC direct)
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

// GET /api/files - List files in Documents and Projects
app.get('/api/files', (req, res) => {
  try {
    if (!fs.existsSync(PROJECTS_DIR)) {
      fs.mkdirSync(PROJECTS_DIR, { recursive: true });
      return res.json({ files: [] });
    }

    // Only deliverable formats — no support/code files (js, css, json, etc.)
    const deliverableExts = new Set([
      '.pdf', '.html', '.md', '.txt',
      '.xlsx', '.xls', '.pptx', '.ppt', '.doc', '.docx', '.ods', '.odp', '.csv',
      '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp',
      '.zip', '.mp3', '.mp4', '.wav'
    ]);

    const files = [];
    // Only walk one level of project subfolders — ignore node_modules etc.
    const projects = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);

    for (const project of projects) {
      const projectDir = path.join(PROJECTS_DIR, project);
      function walk(dir) {
        try {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (deliverableExts.has(path.extname(entry.name).toLowerCase())) {
              const stat = fs.statSync(full);
              files.push({
                name: entry.name,
                project,
                path: full,
                size: stat.size,
                ext: path.extname(entry.name).toLowerCase(),
                createdAt: stat.birthtime,
                downloadUrl: `/api/files/download?path=${encodeURIComponent(full)}`
              });
            }
          }
        } catch {}
      }
      walk(projectDir);
    }

    // PATCH 6 v8.0: arquivos soltos na raiz de PROJECTS_DIR vao para o grupo "(raiz)"
    try {
      for (const entry of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (entry.name.startsWith('.')) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!deliverableExts.has(ext)) continue;
        const full = path.join(PROJECTS_DIR, entry.name);
        const stat = fs.statSync(full);
        files.push({
          name: entry.name,
          project: '(raiz)',
          path: full,
          size: stat.size,
          ext,
          createdAt: stat.birthtime,
          downloadUrl: `/api/files/download?path=${encodeURIComponent(full)}`
        });
      }
    } catch {}

    files.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/files/download - File Download
app.get('/api/files/download', (req, res) => {
  try {
    let raw = req.query.path || '';
    if (!raw) return res.status(400).json({ error: 'path required' });

    // Resolve relative paths against PROJECTS_DIR, then against JARVIS_DIR as fallback
    let candidates = [];
    if (path.isAbsolute(raw)) {
      candidates.push(path.normalize(raw));
    } else {
      candidates.push(path.resolve(PROJECTS_DIR, raw));
      candidates.push(path.resolve(JARVIS_DIR, raw));
    }

    // Pick first existing candidate
    const filePath = candidates.find(p => fs.existsSync(p));
    if (!filePath) return res.status(404).json({ error: 'File not found', tried: candidates });

    // Security: must stay inside JARVIS_DIR (Desktop\Jarvis) to avoid path traversal
    const norm = path.normalize(filePath).toLowerCase();
    const safeRoot = path.normalize(JARVIS_DIR).toLowerCase();
    if (!norm.startsWith(safeRoot)) return res.status(403).json({ error: 'Access denied' });

    res.download(filePath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/read-file - Read file text content (restricted to safe directories)
app.get('/api/read-file', (req, res) => {
  try {
    const filePath = path.resolve(path.normalize(req.query.path));
    // Security: restrict to JARVIS_DIR, user home, and Documents
    const allowedPrefixes = [JARVIS_DIR, os.homedir()].map(p => p.toLowerCase());
    if (!allowedPrefixes.some(prefix => filePath.toLowerCase().startsWith(prefix))) {
      return res.status(403).json({ error: 'Access denied — path outside allowed directories' });
    }
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

    const textExts = new Set(['.txt', '.md', '.json', '.js', '.ts', '.py', '.html', '.css', '.csv', '.xml', '.sql', '.sh', '.bat']);
    const ext = path.extname(filePath).toLowerCase();

    if (!textExts.has(ext)) return res.json({ binary: true, path: filePath });

    const content = fs.readFileSync(filePath, 'utf-8');
    res.json({ content, size: content.length, lines: content.split('\n').length, path: filePath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/find-file - Search for a file by name across common user locations
app.get('/api/find-file', (req, res) => {
  try {
    const { name } = req.query;
    if (!name) return res.status(400).json({ error: 'name required' });

    const home = os.homedir();
    const searchDirs = [
      path.join(home, 'Desktop'),
      path.join(home, 'Downloads'),
      path.join(home, 'Documents'),
      path.join(home, 'OneDrive'),
      path.join(home, 'OneDrive', 'Desktop'),
      path.join(home, 'OneDrive', 'Documents'),
      PROJECTS_DIR,
    ];

    const found = [];
    const nameLower = name.toLowerCase();

    function search(dir, depth = 0) {
      if (depth > 3) return;
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) search(full, depth + 1);
          else if (entry.name.toLowerCase().includes(nameLower)) found.push(full);
        }
      } catch {}
    }

    for (const dir of searchDirs) search(dir);
    res.json({ found: found.slice(0, 10) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/excel-live - Read or write Excel workbook
// Graceful close (WM_CLOSE) → edit with openpyxl → reopen (no recovery files)
app.post('/api/excel-live', async (req, res) => {
  try {
    const { action = 'read', path: filePath, sheet, operations } = req.body;

    let script = '';

    if (action === 'list') {
      script = `
import json, subprocess
r = subprocess.run(['tasklist'], capture_output=True, text=True)
excel_running = 'EXCEL.EXE' in r.stdout
print(json.dumps({"excel_running": excel_running}))
`;
    } else if (action === 'read') {
      script = `
import json, sys
fp = sys.argv[1]
try:
    from openpyxl import load_workbook
    wb = load_workbook(fp, data_only=True)
    ws = wb[${sheet ? `"${sheet}"` : 'wb.sheetnames[0]'}]
    rows = [[cell.value for cell in row] for row in ws.iter_rows()]
    print(json.dumps({"sheet": ws.title, "rows": rows}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`;
    } else if (action === 'write') {
      const ops = JSON.stringify(operations || []);
      script = `
import json, subprocess, os, time, ctypes, sys

fp = sys.argv[1]
ops = json.loads(sys.argv[2])
reopen = ${req.body.reopen !== false ? 'True' : 'False'}

user32 = ctypes.windll.user32
WM_CLOSE = 0x0010
WINFUNC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int))

# Step 1: Close Excel gracefully via WM_CLOSE (no recovery files)
def close_excel():
    check = subprocess.run(['tasklist'], capture_output=True, text=True)
    if 'EXCEL.EXE' not in check.stdout:
        return True

    def cb(hwnd, lParam):
        length = user32.GetWindowTextLengthW(hwnd)
        if length > 0:
            buff = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buff, length + 1)
            if 'Excel' in buff.value and user32.IsWindowVisible(hwnd):
                user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
        return True
    user32.EnumWindows(WINFUNC(cb), 0)

    for i in range(10):
        time.sleep(0.5)
        check = subprocess.run(['tasklist'], capture_output=True, text=True)
        if 'EXCEL.EXE' not in check.stdout:
            return True

    # Handle possible save dialog
    try:
        import pyautogui
        pyautogui.press('n')
        time.sleep(1)
    except: pass

    check = subprocess.run(['tasklist'], capture_output=True, text=True)
    if 'EXCEL.EXE' not in check.stdout:
        return True

    # Last resort: force kill + clean recovery
    subprocess.run(['taskkill', '/F', '/IM', 'EXCEL.EXE'], capture_output=True)
    time.sleep(1)
    # Clean lock file
    lock = os.path.join(os.path.dirname(fp), '~$' + os.path.basename(fp))
    if os.path.exists(lock):
        try: os.remove(lock)
        except: pass
    # Clean recovery registry
    subprocess.run(['reg', 'delete', r'HKCU\\Software\\Microsoft\\Office\\16.0\\Excel\\Resiliency', '/f'], capture_output=True)
    return True

closed = close_excel()
if not closed:
    print(json.dumps({"ok": False, "error": "Could not close Excel"}))
else:
    # Step 2: Edit with openpyxl
    from openpyxl import load_workbook
    wb = load_workbook(fp)
    ws = wb[${sheet ? `"${sheet}"` : 'wb.sheetnames[0]'}]
    for op in ops:
        ws[op['cell']] = op['value']
    wb.save(fp)

    # Step 3: Reopen in Excel
    if reopen:
        subprocess.Popen(['cmd', '/c', 'start', '', fp], shell=True)

    print(json.dumps({"ok": True, "updated": len(ops), "reopened": reopen}))
`;
    }

    const tmpScript = path.join(os.tmpdir(), 'jarvis_excel_live.py');
    fs.writeFileSync(tmpScript, script);

    // Pass filePath and ops as command-line args to prevent Python injection
    const scriptArgs = [tmpScript];
    if (filePath) scriptArgs.push(filePath);
    if (action === 'write') scriptArgs.push(JSON.stringify(operations || []));

    const { execFile } = await import('child_process');
    execFile(PYTHON_CMD, scriptArgs, { timeout: 30000 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpScript); } catch {}
      if (err) return res.status(500).json({ error: err.message, stderr });
      try { res.json(JSON.parse(stdout.trim())); }
      catch { res.status(500).json({ error: 'Parse error', raw: stdout }); }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/read-excel - Read .xlsx file and return as JSON rows
app.post('/api/read-excel', async (req, res) => {
  try {
    const { path: filePath, sheet } = req.body;
    if (!filePath) return res.status(400).json({ error: 'path required' });
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

    const py = `"${PYTHON_CMD}"`;
    const script = `
import json, sys
import openpyxl
wb = openpyxl.load_workbook(r"""${filePath}""", data_only=True)
sheet_name = ${sheet ? `"${sheet}"` : 'wb.sheetnames[0]'}
ws = wb[sheet_name]
rows = []
for row in ws.iter_rows(values_only=True):
    rows.append(list(row))
print(json.dumps({"sheet": sheet_name, "sheets": wb.sheetnames, "rows": rows}))
`;
    const tmpScript = path.join(os.tmpdir(), 'jarvis_excel_read.py');
    fs.writeFileSync(tmpScript, script);

    const { execFile } = await import('child_process');
    execFile(PYTHON_CMD, [tmpScript], { timeout: 15000 }, (err, stdout) => {
      fs.unlinkSync(tmpScript);
      if (err) return res.status(500).json({ error: err.message });
      try { res.json(JSON.parse(stdout)); }
      catch { res.status(500).json({ error: 'Parse error', raw: stdout }); }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/files/view - Serve file inline for preview
app.get('/api/files/view', (req, res) => {
  try {
    const filePath = path.normalize(req.query.path);
    if (!filePath.startsWith(PROJECTS_DIR)) return res.status(403).json({ error: 'Access denied' });
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.mp4': 'video/mp4',
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.html': 'text/html', '.txt': 'text/plain',
      '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css'
    };
    res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline');
    res.sendFile(filePath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/pdf - HTML to PDF via Puppeteer
app.post('/api/pdf', async (req, res) => {
  try {
    const { htmlPath, pdfPath } = req.body;
    const normHtml = path.normalize(htmlPath);
    const normPdf = path.normalize(pdfPath);

    if (!normHtml.startsWith(PROJECTS_DIR) || !normPdf.startsWith(PROJECTS_DIR)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!fs.existsSync(normHtml)) return res.status(404).json({ error: 'HTML file not found' });

    await htmlToPdf(normHtml, normPdf);
    const stat = fs.statSync(normPdf);
    res.json({
      ok: true, path: normPdf, size: stat.size,
      downloadUrl: `/api/files/download?path=${encodeURIComponent(normPdf)}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/config - Save configurations
app.post('/api/config', (req, res) => {
  try {
    const { key, value } = req.body;
    if (key === 'OPENAI_API_KEY') {
      process.env.OPENAI_API_KEY = value;
      const envPath = path.join(JARVIS_DIR, '.env');
      let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
      if (envContent.includes('OPENAI_API_KEY=')) {
        envContent = envContent.replace(/OPENAI_API_KEY=.*/g, `OPENAI_API_KEY=${value}`);
      } else {
        envContent += `\nOPENAI_API_KEY=${value}`;
      }
      fs.writeFileSync(envPath, envContent);
      res.json({ ok: true });
    } else {
      res.status(400).json({ error: 'Only OPENAI_API_KEY can be configured' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/notifications - SSE push channel for build completion pings
app.get('/api/notifications', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write('data: {"type":"connected"}\n\n');
  notificationClients.add(res);
  console.log(`[JARVIS] SSE client connected (total: ${notificationClients.size})`);
  req.on('close', () => {
    notificationClients.delete(res);
    console.log(`[JARVIS] SSE client disconnected (total: ${notificationClients.size})`);
  });
});

// GET /api/stats - Session metrics for cockpit
app.get('/api/stats', (req, res) => {
  const uptime = Date.now() - sessionStats.startTime;
  res.json({
    uptime,
    tokensIn: sessionStats.tokensIn,
    tokensOut: sessionStats.tokensOut,
    tokens: sessionStats.tokensIn + sessionStats.tokensOut,
    requests: sessionStats.requests,
    plan: process.env.CLAUDE_PLAN || 'Max',
    lastLatency: sessionStats.lastAckLatency || sessionStats.lastLatency,
    pool: {
      opus:   pools.opus.pool.length,
      sonnet: pools.sonnet.pool.length,
      haiku:  pools.haiku.pool.length,
    }
  });
});

// POST /api/attach - Upload file attachment (supports text files + PDF extraction)
app.post('/api/attach', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const textExts = ['.txt', '.md', '.csv', '.json', '.js', '.ts', '.py', '.html', '.css', '.xml', '.sql', '.sh', '.bat', '.log', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.env'];
    const ext = path.extname(req.file.originalname).toLowerCase();
    const attachmentId = `att-${Date.now()}`;

    if (textExts.includes(ext)) {
      // Plain text files — read directly
      const content = req.file.buffer.toString('utf-8');
      attachments.set(attachmentId, content);
      setTimeout(() => { attachments.delete(attachmentId); }, 30 * 60 * 1000); // 30min TTL
      res.json({ attachmentId, name: req.file.originalname, type: 'text', preview: content.slice(0, 500) });

    } else if (ext === '.pdf') {
      // PDF — extract text via pdfplumber (Python)
      const tmpPath = path.join(PROJECTS_DIR, `_tmp_${Date.now()}.pdf`);
      fs.writeFileSync(tmpPath, req.file.buffer);

      try {
        // execSync já importado no topo do arquivo
        const pyScript = `
import sys, pdfplumber
sys.stdout.reconfigure(encoding='utf-8')
with pdfplumber.open(r'${tmpPath.replace(/\\/g, '\\\\')}') as pdf:
    for page in pdf.pages:
        text = page.extract_text()
        if text:
            print(text)
`;
        const pdfText = execSync(`"${PYTHON_CMD}" -c "${pyScript.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`, {
          encoding: 'utf-8', timeout: 30000, maxBuffer: 10 * 1024 * 1024
        }).trim();

        // Clean up temp file
        try { fs.unlinkSync(tmpPath); } catch {}

        if (pdfText) {
          attachments.set(attachmentId, pdfText);
          console.log(`[JARVIS] PDF extracted: ${req.file.originalname} (${pdfText.length} chars)`);
          res.json({ attachmentId, name: req.file.originalname, type: 'pdf', preview: pdfText.slice(0, 500), chars: pdfText.length });
        } else {
          // PDF has no extractable text (scanned image) — save as binary
          const filePath = path.join(PROJECTS_DIR, req.file.originalname);
          fs.writeFileSync(filePath, req.file.buffer);
          attachments.set(attachmentId, `[PDF with no extractable text saved: ${filePath}]`);
          res.json({ attachmentId, name: req.file.originalname, type: 'binary', path: filePath });
        }
      } catch (pyErr) {
        console.error('[JARVIS] PDF extraction error:', pyErr.message);
        // Fallback: save as binary
        const filePath = path.join(PROJECTS_DIR, req.file.originalname);
        fs.writeFileSync(filePath, req.file.buffer);
        attachments.set(attachmentId, `[PDF saved but text extraction failed: ${filePath}]`);
        res.json({ attachmentId, name: req.file.originalname, type: 'binary', path: filePath });
        try { fs.unlinkSync(tmpPath); } catch {}
      }

    } else if (['.docx', '.doc', '.xlsx', '.xls', '.pptx'].includes(ext)) {
      // Office files — save and reference by path
      const filePath = path.join(PROJECTS_DIR, req.file.originalname);
      fs.writeFileSync(filePath, req.file.buffer);
      attachments.set(attachmentId, `[Office file saved: ${filePath}] — Use Claude to read and analyze this file.`);
      res.json({ attachmentId, name: req.file.originalname, type: 'office', path: filePath });

    } else {
      // Other binary files
      const filePath = path.join(PROJECTS_DIR, req.file.originalname);
      fs.writeFileSync(filePath, req.file.buffer);
      attachments.set(attachmentId, `[Binary file saved: ${filePath}]`);
      res.json({ attachmentId, name: req.file.originalname, type: 'binary', path: filePath });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════
// LibreHardwareMonitor — sensor data via local web API
// ═══════════════════════════════════════════════
let lhmProcess = null;
let lhmReady = false;

function startLibreHardwareMonitor() {
  const lhmDir = path.join(JARVIS_DIR, 'sensors');
  const lhmExe = path.join(lhmDir, 'LibreHardwareMonitor.exe');

  if (!fs.existsSync(lhmExe)) {
    console.log('[JARVIS] LibreHardwareMonitor nao encontrado — temperaturas limitadas');
    return;
  }

  // Ja rodando?
  try {
    const check = execSync('tasklist /FI "IMAGENAME eq LibreHardwareMonitor.exe"', { encoding: 'utf-8' });
    if (check.includes('LibreHardwareMonitor.exe')) {
      console.log('[JARVIS] LibreHardwareMonitor ja rodando');
      lhmReady = true;
      return;
    }
  } catch {}

  try {
    lhmProcess = spawn(lhmExe, [], {
      cwd: lhmDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    lhmProcess.unref();
    console.log('[JARVIS] LibreHardwareMonitor iniciado');
    // Aguarda 2s pra web server subir
    setTimeout(() => { lhmReady = true; }, 2000);
  } catch (err) {
    console.log('[JARVIS] Erro ao iniciar LHM:', err.message);
  }
}

// Parse LHM JSON recursivamente procurando sensores de temperatura
function extractLHMSensors(node, results = { cpuTemps: [], gpuTemps: [], cpuLoad: [], gpuLoad: [] }) {
  if (!node) return results;

  if (node.Value && node.Type) {
    // Ex: "53.0 °C" ou "42.5 %"
    const val = parseFloat(node.Value);
    if (!isNaN(val)) {
      const textLower = (node.Text || '').toLowerCase();
      const imageLower = (node.ImageURL || '').toLowerCase();
      const isCpu = imageLower.includes('cpu') || textLower.includes('cpu');
      const isGpu = imageLower.includes('gpu') || textLower.includes('gpu');

      if (node.Value.includes('°C')) {
        if (isCpu) results.cpuTemps.push(val);
        else if (isGpu) results.gpuTemps.push(val);
      } else if (node.Value.includes('%') && textLower.includes('total')) {
        if (isCpu) results.cpuLoad.push(val);
        else if (isGpu) results.gpuLoad.push(val);
      }
    }
  }

  if (Array.isArray(node.Children)) {
    for (const child of node.Children) {
      extractLHMSensors(child, results);
    }
  }
  return results;
}

async function fetchLHMStats() {
  if (!lhmReady) return null;
  try {
    // http imported at top of file
    return new Promise((resolve) => {
      const req = http.get('http://localhost:8085/data.json', { timeout: 2000 }, (r) => {
        let data = '';
        r.on('data', c => data += c);
        r.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const sensors = extractLHMSensors(parsed);
            resolve({
              cpuTemp: sensors.cpuTemps.length ? Math.round(Math.max(...sensors.cpuTemps)) : null,
              gpuTemp: sensors.gpuTemps.length ? Math.round(Math.max(...sensors.gpuTemps)) : null,
              cpuLoad: sensors.cpuLoad.length ? Math.round(sensors.cpuLoad[0]) : null,
              gpuLoad: sensors.gpuLoad.length ? Math.round(sensors.gpuLoad[0]) : null,
            });
          } catch {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  } catch {
    return null;
  }
}

// GET /api/system-stats - CPU/GPU/RAM via Python psutil+wmi (mais confiavel)
app.get('/api/system-stats', async (req, res) => {
  try {
    // Tenta LHM primeiro (se rodando)
    const lhm = await fetchLHMStats();
    if (lhm && (lhm.cpuTemp || lhm.gpuTemp)) {
      return res.json({
        cpu: { usage: lhm.cpuLoad ?? Math.round(100 - (os.cpus().reduce((a,c)=>a+c.times.idle,0)/os.cpus().reduce((a,c)=>a+c.times.user+c.times.nice+c.times.sys+c.times.idle+c.times.irq,0)*100)), temp: lhm.cpuTemp, cores: os.cpus().length },
        gpu: { name: null, usage: lhm.gpuLoad, temp: lhm.gpuTemp },
        ram: { usage: Math.round(((os.totalmem()-os.freemem())/os.totalmem())*100), total: Math.round(os.totalmem()/(1024**3)), free: Math.round(os.freemem()/(1024**3)) },
        source: 'LibreHardwareMonitor'
      });
    }

    // Fallback: Python psutil + wmi (funciona com AMD/Intel/NVIDIA)
    const pyScript = `
import json, sys
sys.stdout.reconfigure(encoding='utf-8')
result = {"cpu":{"name":None,"usage":None,"temp":None,"cores":0},"gpu":{"name":None,"temp":None,"vram":None,"usage":None},"ram":{"usage":None,"total":0,"free":0,"type":None}}
try:
    import psutil
    result["cpu"]["usage"] = round(psutil.cpu_percent(interval=0.5))
    result["cpu"]["cores"] = psutil.cpu_count(logical=True)
    mem = psutil.virtual_memory()
    result["ram"]["usage"] = round(mem.percent)
    # Arredondar pro multiplo de 8 mais proximo (ex: 30.x → 32, 15.x → 16)
    raw_gb = mem.total / (1024**3)
    result["ram"]["total"] = int(round(raw_gb / 8) * 8) or round(raw_gb)
    result["ram"]["free"] = round(mem.available / (1024**3))
    temps = psutil.sensors_temperatures()
    if temps:
        for name, entries in temps.items():
            if entries:
                result["cpu"]["temp"] = round(entries[0].current)
                break
except: pass
try:
    import wmi
    w = wmi.WMI()
    # CPU name
    cpus = w.Win32_Processor()
    if cpus:
        result["cpu"]["name"] = cpus[0].Name.strip()
    # GPU — pegar apenas a placa dedicada (ignorar integrada e Microsoft)
    gpus = w.Win32_VideoController()
    dedicated = [g for g in gpus if g.Name and 'Microsoft' not in g.Name and 'Radeon(TM) Graphics' not in g.Name and 'Intel' not in g.Name and 'UHD' not in g.Name]
    gpu = None
    if dedicated:
        gpu = dedicated[0]
    elif gpus:
        real = [g for g in gpus if g.Name and 'Microsoft' not in g.Name]
        if real: gpu = real[0]
    if gpu:
        result["gpu"]["name"] = gpu.Name.strip()
        # VRAM — AdapterRAM overflow pra GPUs >4GB, usar qwMemorySize do registro
        try:
            vram_bytes = int(gpu.AdapterRAM or 0)
            if vram_bytes > 0:
                result["gpu"]["vram"] = round(vram_bytes / (1024**3))
            else:
                # Fallback: ler do registro do Windows (qwMemorySize = valor real)
                import winreg
                reg_path = "SYSTEM\\\\CurrentControlSet\\\\Control\\\\Class\\\\{4d36e968-e325-11ce-bfc1-08002be10318}"
                for i in range(20):
                    try:
                        sub = reg_path + "\\\\%04d" % i
                        key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, sub)
                        try:
                            desc = winreg.QueryValueEx(key, "DriverDesc")[0]
                        except:
                            desc = ""
                        if gpu.Name.strip().lower() in desc.lower():
                            try:
                                qw = winreg.QueryValueEx(key, "HardwareInformation.qwMemorySize")[0]
                                result["gpu"]["vram"] = round(int(qw) / (1024**3))
                            except:
                                try:
                                    ms = winreg.QueryValueEx(key, "HardwareInformation.MemorySize")[0]
                                    result["gpu"]["vram"] = round(int(ms) / (1024**3))
                                except: pass
                            break
                        winreg.CloseKey(key)
                    except: pass
        except:
            result["gpu"]["vram"] = None
    # RAM type
    try:
        rams = w.Win32_PhysicalMemory()
        if rams:
            speed = rams[0].Speed or ""
            mem_type_map = {20:"DDR",21:"DDR2",24:"DDR3",26:"DDR4",34:"DDR5"}
            smbios_type = getattr(rams[0], 'SMBIOSMemoryType', None)
            if smbios_type and int(smbios_type) in mem_type_map:
                result["ram"]["type"] = mem_type_map[int(smbios_type)]
            elif speed:
                spd = int(speed)
                if spd >= 4800: result["ram"]["type"] = "DDR5"
                elif spd >= 2133: result["ram"]["type"] = "DDR4"
                elif spd >= 1066: result["ram"]["type"] = "DDR3"
                else: result["ram"]["type"] = "DDR"
            if speed:
                result["ram"]["type"] = (result["ram"]["type"] or "DDR") + " " + str(speed) + "MHz"
    except: pass
except: pass
try:
    import subprocess
    r = subprocess.run(['nvidia-smi','--query-gpu=temperature.gpu','--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=3)
    if r.returncode == 0:
        result["gpu"]["temp"] = int(r.stdout.strip())
except: pass
print(json.dumps(result))
`;
    const tmpScript = path.join(os.tmpdir(), 'jarvis_stats.py');
    fs.writeFileSync(tmpScript, pyScript);

    const { execFile } = await import('child_process');
    execFile(PYTHON_CMD, [tmpScript], { timeout: 8000 }, (err, stdout) => {
      try { fs.unlinkSync(tmpScript); } catch {}
      if (err) {
        // Fallback puro Node
        return res.json({
          cpu: { usage: null, temp: null, cores: os.cpus().length },
          gpu: { name: null, temp: null },
          ram: { usage: Math.round(((os.totalmem()-os.freemem())/os.totalmem())*100), total: Math.round(os.totalmem()/(1024**3)), free: Math.round(os.freemem()/(1024**3)) },
          source: 'node-only'
        });
      }
      try {
        const data = JSON.parse(stdout.trim());
        data.source = 'psutil';
        res.json(data);
      } catch {
        res.json({ cpu:{usage:null,temp:null,cores:os.cpus().length}, gpu:{name:null,temp:null}, ram:{usage:null,total:0,free:0}, source:'error' });
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function checkCodexHealth() {
  const command = (process.env.JARVIS_CODEX_CMD || 'codex').trim() || 'codex';
  const authPattern = /auth|authentication|login|sign in|signin|token|unauthorized|not authenticated|not logged in/i;

  const result = (status, detail, extra = {}) => ({
    status,
    detail,
    command,
    ...extra
  });

  try {
    const commandLooksLikePath = /[\\/]/.test(command) || /^[a-zA-Z]:/.test(command);
    let found = commandLooksLikePath ? fs.existsSync(command) : false;
    let detectedPath = commandLooksLikePath && found ? command : null;

    if (!found) {
      const lookupCmd = process.platform === 'win32' ? 'where' : 'which';
      const lookup = spawnSync(lookupCmd, [command], {
        encoding: 'utf-8',
        timeout: 5000,
        windowsHide: true
      });
      if (lookup.status === 0 && lookup.stdout?.trim()) {
        found = true;
        detectedPath = lookup.stdout.trim().split(/\r?\n/)[0]?.trim() || null;
      }
    }

    if (!found) {
      return result('not_installed', 'Codex CLI nao encontrado no PATH');
    }

    const runCodex = (args) => spawnSync(command, args, {
      encoding: 'utf-8',
      timeout: 8000,
      shell: process.platform === 'win32',
      windowsHide: true
    });

    const version = runCodex(['--version']);
    const versionOutput = `${version.stdout || ''}\n${version.stderr || ''}`.trim();
    if (version.status === 0 && versionOutput) {
      return result('ok', 'Codex CLI disponivel', detectedPath ? { path: detectedPath } : {});
    }
    if (authPattern.test(versionOutput)) {
      return result('auth', 'Codex CLI requer login/autenticacao', detectedPath ? { path: detectedPath } : {});
    }

    const help = runCodex(['--help']);
    const helpOutput = `${help.stdout || ''}\n${help.stderr || ''}`.trim();
    if (help.status === 0 && helpOutput) {
      return result('ok', 'Codex CLI disponivel', detectedPath ? { path: detectedPath } : {});
    }
    if (authPattern.test(helpOutput)) {
      return result('auth', 'Codex CLI requer login/autenticacao', detectedPath ? { path: detectedPath } : {});
    }

    const detail = helpOutput || versionOutput || 'Codex CLI encontrado, mas nao respondeu a --version ou --help';
    return result('error', detail.slice(0, 300), detectedPath ? { path: detectedPath } : {});
  } catch (err) {
    return result('unknown', err.message?.slice(0, 300) || 'Nao foi possivel determinar o status do Codex CLI');
  }
}

const VALID_EXECUTOR_MODES = ['auto', 'claude', 'codex', 'openai'];

function normalizeExecutorMode(mode) {
  const normalized = String(mode || '').trim().toLowerCase();
  return VALID_EXECUTOR_MODES.includes(normalized) ? normalized : 'auto';
}

let currentExecutorMode = normalizeExecutorMode(process.env.JARVIS_EXECUTOR_MODE);

const pendingCodexWriteRequests = new Map();
const CODEX_WRITE_CONFIRMATION_TTL_MS = 10 * 60 * 1000;

const VALID_EXECUTOR_TASK_TYPES = ['code', 'file', 'automation', 'voice', 'chat', 'analysis', 'unknown'];

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
  ])) {
    return 'automation';
  }

  if (hasAny([
    /\b(voz|microfone|audio|[aÃ¡]udio|fale|falar|ouvir|escutar|tts|stt|realtime)\b/i
  ])) {
    return 'voice';
  }

  if (hasAny([
    /\b(corrija|corrigir|implemente|implementar|refatore|refatorar|debug|bug|endpoint|api|rota)\b/i,
    /\b(c[oÃ³]digo|code|html|css|javascript|js|typescript|ts|python|node|react|script|fun[cÃ§][aÃ£]o)\b/i,
    /\b(edite|editar|altere|alterar).+\b(server\.js|script\.js|index\.html|\.js|\.ts|\.py|\.css|\.html)\b/i,
    /\b(analise|analisar).+\b(server\.js|script\.js|index\.html|c[oÃ³]digo|code)\b/i
  ])) {
    return 'code';
  }

  if (hasAny([
    /\b(responda|responde|answer)\s+apenas\b/i,
    /\b(explique|explicar|resuma|resumir|o que [eÃ©]|qual|quais|como funciona|me diga|diferen[cÃ§]a entre)\b/i
  ])) {
    return 'chat';
  }

  if (hasAny([
    /\b(crie|criar|gere|gerar|salve|salvar)\s+(um\s+|uma\s+)?arquivo\b/i,
    /\barquivo\b/i,
    /\bpasta\b/i,
    /\bplanilha\b/i,
    /\bexcel\b/i,
    /\bpdf\b/i,
    /\b(doc|docs|documento)\b/i
  ])) {
    return 'file';
  }

  if (hasAny([
    /\b(edite|editar|corrija|corrigir|implemente|implementar|refatore|refatorar)\b/i,
    /\b(c[oó]digo|code|html|css|javascript|js|typescript|ts|python|node|react|script|fun[cç][aã]o)\b/i,
    /\bbug\b/i
  ])) {
    return 'code';
  }

  if (hasAny([
    /\b(abra|abrir|clique|clicar|controle|controlar|digite|digitar|navegador|browser|mouse|teclado)\b/i,
    /\b(youtube|spotify|chrome|janela|site|p[aá]gina)\b/i
  ])) {
    return 'automation';
  }

  if (hasAny([
    /\b(voz|microfone|audio|[aá]udio|fale|falar|ouvir|escutar|tts|stt|realtime)\b/i
  ])) {
    return 'voice';
  }

  if (hasAny([
    /\b(analise|analisar|an[aá]lise|compare|comparar|investigue|investigar|diagn[oó]stico|diagnosticar)\b/i,
    /\b(relat[oó]rio|prd|mapa t[eé]cnico)\b/i
  ])) {
    return 'analysis';
  }

  if (hasAny([
    /\b(explique|explicar|resuma|resumir|o que [eé]|qual|quais|como|por que|porque)\b/i
  ])) {
    return 'chat';
  }

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
  ok = false,
  provider = null,
  output = '',
  errorType = null,
  rawError = null,
  fallbackUsed = false,
  fallbackReason = null
} = {}) {
  return {
    ok: Boolean(ok),
    provider,
    output: String(output || ''),
    errorType,
    rawError,
    fallbackUsed: Boolean(fallbackUsed),
    fallbackReason
  };
}

function executeWithClaudeDryRun({ prompt, model, cwd } = {}) {
  return createExecutorResult({
    ok: false,
    provider: 'claude',
    output: '',
    errorType: 'not_connected',
    rawError: 'Claude execution is not connected in Fase 4A',
    fallbackUsed: false,
    fallbackReason: null
  });
}

function executeWithCodexDryRun({ prompt, cwd } = {}) {
  const health = checkCodexHealth();
  if (health.status === 'ok') {
    return createExecutorResult({
      ok: true,
      provider: 'codex',
      output: 'Codex provider prepared for future execution',
      fallbackUsed: false,
      fallbackReason: null
    });
  }

  return createExecutorResult({
    ok: false,
    provider: 'codex',
    output: '',
    errorType: classifyExecutorError(health.detail || health.status),
    rawError: health.detail || 'Codex CLI unavailable',
    fallbackUsed: false,
    fallbackReason: null
  });
}

function getCodexCommand() {
  return (process.env.JARVIS_CODEX_CMD || 'codex').trim() || 'codex';
}

function createSafeCodexEnv() {
  const keepKeys = [
    'PATH', 'Path', 'PATHEXT',
    'SystemRoot', 'WINDIR', 'COMSPEC',
    'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA',
    'TEMP', 'TMP', 'USERNAME',
    'CODEX_HOME'
  ];
  const env = {};
  for (const key of keepKeys) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function runCodexCommand(args, { cwd = JARVIS_DIR, timeoutMs = 60000, input = '' } = {}) {
  return new Promise((resolve) => {
    const command = getCodexCommand();
    const safeCwd = cwd || JARVIS_DIR;
    const maxBuffer = 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        ok: result.ok,
        code: result.code,
        stdout: stdout.slice(0, maxBuffer),
        stderr: stderr.slice(0, maxBuffer),
        timedOut
      });
    };

    let child;
    try {
      child = spawn(command, args, {
        cwd: safeCwd,
        shell: process.platform === 'win32',
        windowsHide: true,
        env: createSafeCodexEnv(),
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      stderr = err.message || String(err);
      timedOut = false;
      return finish({ ok: false, code: null });
    }

    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => {
        try { if (!child.killed) child.kill('SIGKILL'); } catch {}
      }, 2000);
    }, Math.max(1000, Number(timeoutMs) || 60000));

    child.stdout.on('data', (chunk) => {
      if (stdout.length < maxBuffer) stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < maxBuffer) stderr += chunk.toString('utf-8');
    });
    child.on('error', (err) => {
      stderr += err.message || String(err);
      finish({ ok: false, code: null });
    });
    child.on('close', (code) => {
      finish({ ok: code === 0 && !timedOut, code });
    });

    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

function codexHealthToErrorType(status, detail) {
  if (status === 'not_installed') return 'not_installed';
  if (status === 'auth') return 'auth';
  return classifyExecutorError(`${status || ''}\n${detail || ''}`);
}

async function executeWithCodexReal({ prompt, cwd = JARVIS_DIR, timeoutMs = 60000 } = {}) {
  const health = checkCodexHealth();
  if (health.status !== 'ok') {
    return createExecutorResult({
      ok: false,
      provider: 'codex',
      output: '',
      errorType: codexHealthToErrorType(health.status, health.detail),
      rawError: health.detail || health.status || 'Codex CLI unavailable',
      fallbackUsed: false,
      fallbackReason: null
    });
  }

  const userPrompt = String(prompt || '').trim();
  if (!userPrompt) {
    return createExecutorResult({
      ok: false,
      provider: 'codex',
      output: '',
      errorType: 'empty_output',
      rawError: 'Prompt vazio',
      fallbackUsed: false,
      fallbackReason: null
    });
  }

  const safetyPrompt = [
    'Você está em um teste controlado do Jarvis.',
    'Não altere arquivos, não instale pacotes, não execute comandos destrutivos e responda apenas ao pedido textual, salvo se o usuário pedir explicitamente uma ação de arquivo.',
    'Não leia, exponha ou revele conteúdo de arquivos .env, chaves, tokens, senhas ou segredos.',
    '',
    userPrompt
  ].join('\n');

  const args = [
    '--ask-for-approval', 'never',
    'exec',
    '--sandbox', 'read-only',
    '--skip-git-repo-check',
    '--ephemeral',
    '--color', 'never',
    '-C', cwd || JARVIS_DIR,
    '-'
  ];

  const result = await runCodexCommand(args, { cwd, timeoutMs, input: safetyPrompt });
  const combinedError = `${result.stderr || ''}\n${result.stdout || ''}`.trim();
  const output = String(result.stdout || '').trim();

  if (result.timedOut) {
    return createExecutorResult({
      ok: false,
      provider: 'codex',
      output,
      errorType: 'timeout',
      rawError: result.stderr || 'Codex CLI timeout',
      fallbackUsed: false,
      fallbackReason: null
    });
  }

  if (result.code !== 0) {
    return createExecutorResult({
      ok: false,
      provider: 'codex',
      output,
      errorType: classifyExecutorError(combinedError) === 'empty_output' ? 'process_error' : classifyExecutorError(combinedError),
      rawError: result.stderr || `Codex CLI exited with code ${result.code}`,
      fallbackUsed: false,
      fallbackReason: null
    });
  }

  if (!output) {
    return createExecutorResult({
      ok: false,
      provider: 'codex',
      output: '',
      errorType: 'empty_output',
      rawError: result.stderr || 'Codex CLI returned empty stdout',
      fallbackUsed: false,
      fallbackReason: null
    });
  }

  return createExecutorResult({
    ok: true,
    provider: 'codex',
    output,
    errorType: null,
    rawError: result.stderr ? result.stderr.trim() : null,
    fallbackUsed: false,
    fallbackReason: null
  });
}

const CODEX_WRITE_TEST_EXTENSIONS = new Set(['.txt', '.md', '.html', '.json', '.csv']);

function sanitizeProjectFilename(filename) {
  const raw = String(filename || '').trim();
  if (!raw) {
    return { ok: false, error: 'Filename vazio' };
  }
  if (path.isAbsolute(raw) || raw.includes('..') || raw.includes('/') || raw.includes('\\')) {
    return { ok: false, error: 'Filename deve ser apenas um nome de arquivo simples' };
  }
  if (raw !== path.basename(raw)) {
    return { ok: false, error: 'Filename nao pode conter caminho' };
  }
  if (!/^[a-zA-Z0-9 _.-]+$/.test(raw)) {
    return { ok: false, error: 'Filename contem caracteres nao permitidos' };
  }
  const ext = path.extname(raw).toLowerCase();
  if (!CODEX_WRITE_TEST_EXTENSIONS.has(ext)) {
    return { ok: false, error: 'Extensao nao permitida' };
  }
  return { ok: true, filename: raw };
}

function isInsideDirectory(parentDir, targetPath) {
  const parent = path.resolve(parentDir);
  const target = path.resolve(targetPath);
  const relative = path.relative(parent, target);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function createCodexWriteError({ errorType = 'unknown', message = 'Codex write test failed', output = '', rawError = null, filename = null, filePath = null } = {}) {
  return {
    ok: false,
    provider: 'codex',
    mode: 'write-test',
    fileCreated: false,
    filename,
    path: filePath,
    output: String(output || ''),
    errorType,
    message,
    rawError
  };
}

function cleanupExpiredCodexWriteRequests() {
  const now = Date.now();
  for (const [id, item] of pendingCodexWriteRequests.entries()) {
    if (!item || item.expiresAt <= now) pendingCodexWriteRequests.delete(id);
  }
}

function listPendingCodexWriteRequests() {
  cleanupExpiredCodexWriteRequests();
  const now = Date.now();
  return Array.from(pendingCodexWriteRequests.values()).map((item) => ({
    id: item.id,
    filename: item.filename,
    expiresAt: new Date(item.expiresAt).toISOString(),
    secondsRemaining: Math.max(0, Math.ceil((item.expiresAt - now) / 1000)),
    source: item.source,
    mode: item.mode,
    taskType: item.taskType
  }));
}

function createCodexWriteConfirmation({ filename, content, mode, taskType } = {}) {
  cleanupExpiredCodexWriteRequests();
  let id;
  do {
    id = crypto.randomBytes(3).toString('hex').toUpperCase();
  } while (pendingCodexWriteRequests.has(id));

  const now = Date.now();
  pendingCodexWriteRequests.set(id, {
    id,
    filename,
    content,
    createdAt: now,
    expiresAt: now + CODEX_WRITE_CONFIRMATION_TTL_MS,
    source: 'chat',
    mode,
    taskType
  });

  return {
    id,
    filename,
    expiresAt: now + CODEX_WRITE_CONFIRMATION_TTL_MS,
    message: [
      'Pedido de escrita pendente.',
      '',
      `Arquivo: ${filename}`,
      'Destino: Documents and Projects',
      'Expira em: 10 minutos',
      '',
      'Para confirmar, envie:',
      `CONFIRMAR_ESCRITA_CODEX ${id}`,
      '',
      'Para cancelar, envie:',
      `CANCELAR_ESCRITA_CODEX ${id}`
    ].join('\n')
  };
}

function extractCodexWriteContent(text) {
  const raw = String(text || '');
  const normalized = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const markers = [
    'com o conteudo:',
    'com o conteudo',
    'com conteudo:',
    'com conteudo',
    'com o texto:',
    'com o texto',
    'com texto:',
    'com texto',
    'o conteudo:',
    'o conteudo'
  ];

  for (const marker of markers) {
    const index = normalized.indexOf(marker);
    if (index >= 0) {
      const content = raw.slice(index + marker.length).trim();
      return content || null;
    }
  }
  return null;
}

function parseCodexWriteRequestFromMessage(message) {
  const text = String(message || '').trim();
  if (!text) return { ok: false, errorType: 'unknown', message: 'Mensagem vazia' };

  const filenameMatch =
    text.match(/\barquivo\s+(?:chamado\s+)?["']?([^"'\s]+)["']?/i) ||
    text.match(/\bsalve\s+em\s+["']?([^"'\s]+)["']?/i);
  if (!filenameMatch) {
    return {
      ok: false,
      errorType: 'unknown',
      message: 'Use: crie um arquivo chamado NOME.txt com o conteudo: TEXTO'
    };
  }

  const filename = filenameMatch[1]?.trim();
  const safeName = sanitizeProjectFilename(filename);
  if (!safeName.ok) {
    return {
      ok: false,
      errorType: 'invalid_filename',
      message: safeName.error,
      filename
    };
  }

  const extractedContent = extractCodexWriteContent(text);
  if (!extractedContent) {
    return {
      ok: false,
      errorType: 'unknown',
      message: 'Informe o conteudo. Use: crie um arquivo chamado NOME.txt com o conteudo: TEXTO',
      filename: safeName.filename
    };
  }

  return {
    ok: true,
    filename: safeName.filename,
    content: extractedContent
  };

  const contentMatch =
    text.match(/\bcom\s+(?:o\s+)?(?:conte[uú]do|texto)\s*:?\s*([\s\S]+)$/i) ||
    text.match(/\bo\s+conte[uú]do\s*:?\s*([\s\S]+)$/i);
  const content = contentMatch?.[1]?.trim();
  if (!content) {
    return {
      ok: false,
      errorType: 'unknown',
      message: 'Informe o conteudo. Use: crie um arquivo chamado NOME.txt com o conteudo: TEXTO',
      filename: safeName.filename
    };
  }

  return {
    ok: true,
    filename: safeName.filename,
    content
  };
}

function isCodexWriteRequestIntent(message) {
  const text = String(message || '');
  if (!text.trim()) return false;
  const hasWriteVerb = /\b(cri[ae]|criar|salv[ae]|salvar|edite|editar|atualize|atualizar|modifique|modificar|gere|gerar|fa[çc]a|fazer)\b/i.test(text);
  const hasFileSignal = /\b(arquivo|file|ficheiro|documento|chamado|salve\s+em)\b/i.test(text)
    || /\.[a-z0-9]{1,8}\b/i.test(text);
  const hasContentSignal = /\b(conte[uÃº]do|texto|com\s+o|com\s+a)\b/i.test(text);
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

async function executePendingCodexWrite(id) {
  const key = String(id || '').trim().toUpperCase();
  const pending = pendingCodexWriteRequests.get(key);
  if (!pending) {
    cleanupExpiredCodexWriteRequests();
    return createCodexWriteError({
      errorType: 'unknown',
      message: 'Nao encontrei uma escrita pendente com esse codigo.'
    });
  }

  if (pending.expiresAt <= Date.now()) {
    pendingCodexWriteRequests.delete(key);
    cleanupExpiredCodexWriteRequests();
    return createCodexWriteError({
      errorType: 'unknown',
      message: 'Esse pedido de escrita expirou. Envie o pedido novamente.',
      filename: pending.filename
    });
  }

  cleanupExpiredCodexWriteRequests();
  const safeName = sanitizeProjectFilename(pending.filename);
  if (!safeName.ok) {
    pendingCodexWriteRequests.delete(key);
    return createCodexWriteError({
      errorType: 'invalid_filename',
      message: safeName.error,
      filename: pending.filename
    });
  }

  const result = await executeWithCodexWriteTest({
    filename: safeName.filename,
    content: pending.content
  });
  pendingCodexWriteRequests.delete(key);
  return result;
}

function buildCodexWriteConfirmationReply(message, mode, taskType) {
  const parsed = parseCodexWriteRequestFromMessage(message);
  if (!parsed.ok) {
    return {
      ok: false,
      errorType: parsed.errorType,
      message: parsed.errorType === 'invalid_filename'
        ? `Nao posso preparar essa escrita: ${parsed.message}.`
        : parsed.message
    };
  }

  return {
    ok: true,
    ...createCodexWriteConfirmation({
      filename: parsed.filename,
      content: parsed.content,
      mode,
      taskType
    })
  };
}

function writeCodexWriteConfirmationResponse(res, message, mode, taskType) {
  const pending = buildCodexWriteConfirmationReply(message, mode, taskType);
  res.write(pending.message);
  try { res.end(); } catch {}
  return pending;
}

async function writeCodexChatResponse({ res, message, prompt, language, t0, fallbackUsed = false, fallbackReason = null, taskType = 'unknown' } = {}) {
  const fallbackNotice = 'Executor Claude indisponivel. Continuei pelo Codex.';
  const readOnlyFileNotice = 'Codex foi acionado em modo somente leitura. Posso gerar o conteudo ou plano, mas a escrita pelo chat ainda nao esta liberada.';
  const codexPrompt = fallbackUsed && taskType === 'file'
    ? `${prompt}\n\n[IMPORTANTE - MODO SOMENTE LEITURA]\nVoce esta sendo chamado pelo /api/chat em modo read-only. Nao afirme que criou, editou ou salvou arquivos. Para pedidos de arquivo, gere apenas o conteudo ou um plano e informe que a escrita real ainda exige a rota controlada /api/executor/codex-write-test ou uma etapa futura.`
    : prompt;
  const codexResult = await executeWithCodexReal({
    prompt: codexPrompt,
    cwd: JARVIS_DIR,
    timeoutMs: 90000
  });

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

async function executeWithCodexWriteTest({ filename, content, timeoutMs = 120000 } = {}) {
  const safeName = sanitizeProjectFilename(filename);
  if (!safeName.ok) {
    return createCodexWriteError({
      errorType: 'invalid_filename',
      message: safeName.error,
      filename: String(filename || '')
    });
  }

  const expectedContent = String(content ?? 'Arquivo criado pelo Codex via Jarvis em modo write controlado.');
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });

  const targetPath = path.resolve(PROJECTS_DIR, safeName.filename);
  if (!isInsideDirectory(PROJECTS_DIR, targetPath)) {
    return createCodexWriteError({
      errorType: 'invalid_filename',
      message: 'Caminho final fora de Documents and Projects',
      filename: safeName.filename,
      filePath: targetPath
    });
  }

  const health = checkCodexHealth();
  if (health.status !== 'ok') {
    return createCodexWriteError({
      errorType: codexHealthToErrorType(health.status, health.detail),
      message: health.detail || 'Codex CLI indisponivel',
      filename: safeName.filename,
      filePath: targetPath,
      rawError: health.detail || health.status || null
    });
  }

  const prompt = [
    'Voce esta em um teste controlado do Jarvis.',
    'Seu diretorio de trabalho e Documents and Projects.',
    `Crie exatamente o arquivo "${safeName.filename}" neste diretorio.`,
    'Conteudo exato do arquivo:',
    expectedContent,
    '',
    'Regras:',
    '- Nao altere nenhum outro arquivo.',
    '- Nao crie pastas.',
    '- Nao leia .env.',
    '- Nao acesse arquivos fora deste diretorio.',
    '- Nao instale pacotes.',
    '- Nao execute comandos destrutivos.',
    '- Responda apenas com CODEX_WRITE_OK quando terminar.'
  ].join('\n');

  const args = [
    '--ask-for-approval', 'never',
    '--disable', 'memories',
    'exec',
    '--sandbox', 'workspace-write',
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-rules',
    '--color', 'never',
    '-C', '.',
    '-'
  ];

  const startedAt = Date.now();
  const result = await runCodexCommand(args, {
    cwd: PROJECTS_DIR,
    timeoutMs,
    input: prompt
  });
  const output = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  const combined = `${stderr}\n${output}`.trim();

  if (result.timedOut) {
    return createCodexWriteError({
      errorType: 'timeout',
      message: 'Codex write test excedeu o tempo limite',
      output,
      rawError: stderr || 'timeout',
      filename: safeName.filename,
      filePath: targetPath
    });
  }

  if (result.code !== 0) {
    const errorType = /workspace-write|possible values|invalid value|unexpected argument/i.test(combined)
      ? 'sandbox_not_supported'
      : (classifyExecutorError(combined) === 'empty_output' ? 'process_error' : classifyExecutorError(combined));
    return createCodexWriteError({
      errorType,
      message: 'Codex write test retornou erro de processo',
      output,
      rawError: stderr || `Codex CLI exited with code ${result.code}`,
      filename: safeName.filename,
      filePath: targetPath
    });
  }

  if (!/CODEX_WRITE_OK/i.test(output)) {
    return createCodexWriteError({
      errorType: 'process_error',
      message: 'Codex nao confirmou a escrita com CODEX_WRITE_OK',
      output,
      rawError: stderr || null,
      filename: safeName.filename,
      filePath: targetPath
    });
  }

  if (!fs.existsSync(targetPath)) {
    return createCodexWriteError({
      errorType: 'file_not_created',
      message: 'Arquivo nao foi criado em Documents and Projects',
      output,
      rawError: stderr || null,
      filename: safeName.filename,
      filePath: targetPath
    });
  }

  const fileStat = fs.statSync(targetPath);
  if (fileStat.mtimeMs < startedAt - 2000) {
    return createCodexWriteError({
      errorType: 'file_not_created',
      message: 'Arquivo nao foi criado ou atualizado nesta execucao',
      output,
      rawError: stderr || null,
      filename: safeName.filename,
      filePath: targetPath
    });
  }

  const actualContent = fs.readFileSync(targetPath, 'utf-8');
  if (!actualContent.trim()) {
    return createCodexWriteError({
      errorType: 'empty_output',
      message: 'Arquivo foi criado, mas esta vazio',
      output,
      rawError: stderr || null,
      filename: safeName.filename,
      filePath: targetPath
    });
  }

  return {
    ok: true,
    provider: 'codex',
    mode: 'write-test',
    fileCreated: true,
    filename: safeName.filename,
    path: targetPath,
    output,
    errorType: null,
    rawError: stderr || null,
    contentMatches: actualContent.includes(expectedContent)
  };
}

function executeWithOpenAIDryRun({ prompt } = {}) {
  return createExecutorResult({
    ok: false,
    provider: 'openai',
    output: '',
    errorType: openai ? 'not_connected' : 'auth',
    rawError: openai
      ? 'OpenAI execution is not connected in Fase 4A'
      : 'OPENAI_API_KEY not configured',
    fallbackUsed: false,
    fallbackReason: null
  });
}

function selectDryRunProvider(mode, taskType) {
  if (mode === 'claude' || mode === 'codex' || mode === 'openai') return mode;

  switch (taskType) {
    case 'voice':
      return 'openai';
    case 'code':
    case 'file':
    case 'automation':
    case 'chat':
    case 'analysis':
    case 'unknown':
    default:
      return 'claude';
  }
}

function executeTaskRouterDryRun({ prompt, mode, taskType } = {}) {
  const normalizedMode = normalizeExecutorMode(mode || currentExecutorMode);
  const detectedTaskType = taskType
    ? normalizeExecutorTaskType(taskType)
    : detectTaskType(prompt);
  const selectedProvider = selectDryRunProvider(normalizedMode, detectedTaskType);
  let providerResult;

  if (selectedProvider === 'codex') {
    providerResult = executeWithCodexDryRun({ prompt, cwd: JARVIS_DIR });
  } else if (selectedProvider === 'openai') {
    providerResult = executeWithOpenAIDryRun({ prompt });
  } else {
    providerResult = executeWithClaudeDryRun({ prompt, cwd: JARVIS_DIR });
  }

  return {
    ok: true,
    dryRun: true,
    mode: normalizedMode,
    taskType: detectedTaskType,
    selectedProvider,
    executorMode: normalizedMode,
    fallbackEnabled: false,
    providerReady: providerResult.ok,
    providerStatus: providerResult,
    message: `Executor router dry-run: ${selectedProvider} seria usado, mas nenhuma tarefa foi executada nesta fase.`
  };
}

// GET /api/health - Full system health check (used by Ligar JARVIS.bat and frontend)
app.get('/api/health', (req, res) => {
  const chrome = findChrome();
  const health = {
    status: claudeCliAvailable && openai ? 'operational' : 'degraded',
    components: {
      server: { status: 'ok' },
      openai: {
        status: openai ? 'ok' : 'error',
        error: openai ? null : 'OPENAI_API_KEY not configured in .env — voice/TTS will not work'
      },
      claude: {
        status: claudeCliChecking ? 'checking' : (claudeCliAvailable ? 'ok' : 'error'),
        error: claudeCliAvailable ? null : claudeCliError
      },
      chrome: {
        status: chrome ? 'ok' : 'bundled',
        path: chrome || 'Using Puppeteer bundled Chromium'
      },
      pools: {
        opus: pools.opus.pool.length,
        sonnet: pools.sonnet.pool.length,
        haiku: pools.haiku.pool.length,
        spawnErrors: pools.opus.spawnErrors + pools.sonnet.spawnErrors + pools.haiku.spawnErrors
      }
    },
    capabilities: {
      voice_realtime: !!openai,
      voice_stt: !!openai,
      voice_tts: !!openai,
      task_execution: claudeCliAvailable,
      pdf_generation: true,
      screen_analysis: claudeCliAvailable,
      excel_live: fs.existsSync(PYTHON_CMD),
      meta_ads: false
    }
  };
  res.json(health);
});

// GET /api/providers/health - Provider-level health without changing execution routing
app.get('/api/providers/health', (req, res) => {
  const codex = checkCodexHealth();
  const claudeStatus = claudeCliChecking ? 'checking' : (claudeCliAvailable ? 'ok' : 'error');
  res.json({
    server: 'ok',
    api: {
      status: openai ? 'ok' : 'error',
      detail: openai ? 'OpenAI API configurada' : 'OPENAI_API_KEY nao configurada'
    },
    voice: {
      status: openai ? 'ok' : 'error',
      detail: openai ? 'Servicos de voz disponiveis' : 'Servicos de voz indisponiveis sem OPENAI_API_KEY'
    },
    claude: {
      status: claudeStatus,
      detail: claudeCliChecking
        ? 'Claude CLI em verificacao'
        : (claudeCliAvailable ? 'Claude CLI disponivel' : (claudeCliError || 'Claude CLI indisponivel')),
      command: CLAUDE_CMD
    },
    codex,
    executor: {
      mode: currentExecutorMode,
      validModes: VALID_EXECUTOR_MODES,
      fallbackEnabled: true
    }
  });
});

// GET /api/executor/mode - Read current executor mode (does not affect /api/chat yet)
app.get('/api/executor/mode', (req, res) => {
  res.json({
    mode: currentExecutorMode,
    validModes: VALID_EXECUTOR_MODES
  });
});

// POST /api/executor/mode - Update executor mode in memory only
app.post('/api/executor/mode', (req, res) => {
  const requestedMode = String(req.body?.mode || '').trim().toLowerCase();
  if (!VALID_EXECUTOR_MODES.includes(requestedMode)) {
    return res.status(400).json({
      ok: false,
      error: 'Modo inválido',
      validModes: VALID_EXECUTOR_MODES
    });
  }

  currentExecutorMode = requestedMode;
  res.json({
    ok: true,
    mode: currentExecutorMode
  });
});

// POST /api/executor/dry-run - Passive executor routing test only (does not execute tasks)
app.post('/api/executor/dry-run', (req, res) => {
  const result = executeTaskRouterDryRun({
    prompt: req.body?.prompt || '',
    mode: req.body?.mode,
    taskType: req.body?.taskType
  });

  res.json(result);
});

// POST /api/executor/codex-test - Isolated Codex execution test only
app.post('/api/executor/codex-test', async (req, res) => {
  try {
    const requestedTimeout = Number(req.body?.timeoutMs) || 60000;
    const result = await executeWithCodexReal({
      prompt: req.body?.prompt || '',
      cwd: JARVIS_DIR,
      timeoutMs: Math.min(Math.max(requestedTimeout, 5000), 120000)
    });
    res.status(result.ok ? 200 : 500).json(result);
  } catch (err) {
    res.status(500).json(createExecutorResult({
      ok: false,
      provider: 'codex',
      output: '',
      errorType: classifyExecutorError(err),
      rawError: err.message || String(err),
      fallbackUsed: false,
      fallbackReason: null
    }));
  }
});

// GET /api/executor/codex-write-pending - List pending chat write confirmations without file contents
app.get('/api/executor/codex-write-pending', (req, res) => {
  const items = listPendingCodexWriteRequests();
  res.json({
    ok: true,
    count: items.length,
    items
  });
});

// POST /api/executor/codex-write-test - Isolated Codex write test inside Documents and Projects only
app.post('/api/executor/codex-write-test', async (req, res) => {
  try {
    const requestedTimeout = Number(req.body?.timeoutMs) || 120000;
    const result = await executeWithCodexWriteTest({
      filename: req.body?.filename || 'TESTE-CODEX-WRITE.txt',
      content: req.body?.content ?? 'Arquivo criado pelo Codex via Jarvis em modo write controlado.',
      timeoutMs: Math.min(Math.max(requestedTimeout, 10000), 180000)
    });
    res.status(result.ok ? 200 : (result.errorType === 'invalid_filename' ? 400 : 500)).json(result);
  } catch (err) {
    res.status(500).json(createCodexWriteError({
      errorType: classifyExecutorError(err),
      message: 'Erro inesperado no Codex write test',
      rawError: err.message || String(err)
    }));
  }
});

// POST /api/executor/excel-template-test - Safe .xlsx template generation inside Documents and Projects only
app.post('/api/executor/excel-template-test', async (req, res) => {
  try {
    const requestedTemplate = String(req.body?.template || 'generico').trim().toLowerCase();
    const template = SPREADSHEET_TEMPLATES[requestedTemplate] ? requestedTemplate : 'generico';
    const result = await createSpreadsheetFromRequest({
      filename: req.body?.filename || safeWorkbookName(`${template} template`),
      template,
      sampleRows: req.body?.sampleRows !== false,
      openFile: req.body?.openFile === true
    }, req.body?.language || 'BR');
    res.status(result.ok ? 200 : (result.errorType === 'invalid_filename' || result.errorType === 'invalid_path' ? 400 : 500)).json(result);
  } catch (err) {
    res.status(500).json({
      ok: false,
      errorType: classifyExecutorError(err),
      message: 'Erro inesperado no excel-template-test',
      rawError: err.message || String(err)
    });
  }
});

// POST /api/health/recheck - Re-run Claude CLI health check (useful after fixing auth)
app.post('/api/health/recheck', (req, res) => {
  console.log('[JARVIS] Re-checking Claude CLI health...');
  claudeCliAvailable = checkClaudeCli();
  if (claudeCliAvailable) {
    // Refill pools now that CLI is available
    pools.opus.spawnErrors = 0;
    pools.sonnet.spawnErrors = 0;
    pools.haiku.spawnErrors = 0;
    pools.opus.fill();
    pools.sonnet.fill();
    pools.haiku.fill();
  }
  res.json({
    claudeAvailable: claudeCliAvailable,
    error: claudeCliAvailable ? null : claudeCliError
  });
});

// POST /api/health/preflight - Deep verification: actually tests OpenAI + Claude + Realtime voice
// Run this ONCE after install to confirm everything works before the user starts
app.post('/api/health/preflight', async (req, res) => {
  console.log('[JARVIS] Running pre-flight verification...');
  const results = {
    openai_api: { status: 'pending', detail: '' },
    openai_realtime: { status: 'pending', detail: '' },
    openai_tts: { status: 'pending', detail: '' },
    claude_cli: { status: 'pending', detail: '' },
    claude_execute: { status: 'pending', detail: '' },
  };

  // 1. Test OpenAI API (chat completion)
  if (!openai) {
    results.openai_api = { status: 'error', detail: 'OPENAI_API_KEY not found in .env' };
    results.openai_realtime = { status: 'error', detail: 'Requires OpenAI API key' };
    results.openai_tts = { status: 'error', detail: 'Requires OpenAI API key' };
  } else {
    try {
      const chatTest = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Say "ok" and nothing else.' }],
        max_tokens: 5, temperature: 0
      });
      if (chatTest.choices?.[0]?.message?.content) {
        results.openai_api = { status: 'ok', detail: 'GPT-4o-mini responding' };
      } else {
        results.openai_api = { status: 'error', detail: 'Empty response from GPT-4o-mini' };
      }
    } catch (e) {
      results.openai_api = { status: 'error', detail: e.message?.slice(0, 150) };
    }

    // 2. Test OpenAI Realtime session creation (voice)
    try {
      const rtRes = await fetch('https://api.openai.com/v1/realtime/sessions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-4o-realtime-preview',
          voice: 'ash',
          modalities: ['audio', 'text']
        })
      });
      const rtData = await rtRes.json();
      if (rtRes.ok && rtData.client_secret?.value) {
        results.openai_realtime = { status: 'ok', detail: 'Realtime session created successfully' };
      } else {
        results.openai_realtime = { status: 'error', detail: rtData.error?.message || 'Session creation failed' };
      }
    } catch (e) {
      results.openai_realtime = { status: 'error', detail: e.message?.slice(0, 150) };
    }

    // 3. Test TTS
    try {
      const ttsTest = await openai.audio.speech.create({
        model: 'tts-1', voice: 'ash', input: 'Test.', response_format: 'mp3'
      });
      if (ttsTest) {
        results.openai_tts = { status: 'ok', detail: 'TTS generating audio' };
      }
    } catch (e) {
      results.openai_tts = { status: 'error', detail: e.message?.slice(0, 150) };
    }
  }

  // 4. Test Claude CLI — ALWAYS do a fresh check (don't rely on boot check which may have timed out)
  // Usa findClaudeCli() que cobre PATH, where claude, npm global, e native installer
  const foundClaudePath = findClaudeCli();
  const cliFound = !!foundClaudePath;
  const claudeCmd = foundClaudePath || 'claude';

  if (!cliFound) {
    results.claude_cli = { status: 'error', detail: 'Claude CLI not found. Install: npm install -g @anthropic-ai/claude-code' };
    results.claude_execute = { status: 'error', detail: 'Requires Claude CLI' };
  } else {
    // 4b. Check auth status (fast — just reads credentials file)
    let authOk = false;
    try {
      const authResult = execSync(`"${claudeCmd}" auth status`, { encoding: 'utf-8', timeout: 10000, shell: true });
      authOk = authResult.includes('"loggedIn": true') || authResult.includes('"loggedIn":true');
    } catch {}

    if (authOk) {
      results.claude_cli = { status: 'ok', detail: 'Installed and authenticated' };
    } else {
      results.claude_cli = { status: 'error', detail: 'Installed but not authenticated. Run: claude auth login --claudeai' };
      results.claude_execute = { status: 'error', detail: 'Requires authentication' };
    }

    // 5. Test actual execution only if auth is OK
    if (authOk) {
      try {
        const testProc = spawnSync('claude', [
          '--print', '--output-format', 'text',
          '--dangerously-skip-permissions'
        ], {
          input: 'Reply with exactly: JARVIS_OK',
          timeout: 60000, encoding: 'utf-8', shell: true
        });

        const out = (testProc.stdout || '').trim();
        if (out.length > 0) {
          results.claude_execute = { status: 'ok', detail: 'Task execution working' };
          // Also fix the boot-level flag if it was stuck
          if (!claudeCliAvailable) {
            claudeCliAvailable = true;
            claudeCliError = '';
            claudeCliChecking = false;
            pools.opus.fill(); pools.sonnet.fill(); pools.haiku.fill();
            console.log('[JARVIS] Preflight fixed boot auth — pools filled');
          }
        } else {
          const errDetail = testProc.stderr?.slice(0, 200) || 'No output — may need retry';
          results.claude_execute = { status: 'error', detail: errDetail };
        }
      } catch (e) {
        results.claude_execute = { status: 'error', detail: e.message?.includes('timeout') ? 'Timeout — click Retry' : e.message?.slice(0, 150) };
      }
    }
  }

  // Summary
  const allOk = Object.values(results).every(r => r.status === 'ok');
  const summary = {
    status: allOk ? 'ready' : 'issues_found',
    results,
    message: allOk
      ? 'All systems operational. JARVIS is ready to use.'
      : 'Some components have issues. Check details above.'
  };

  console.log('[JARVIS] Pre-flight results:', JSON.stringify(summary.results, null, 2));
  res.json(summary);
});

// POST /api/health/autofix - Claude CLI auto-repairs detected issues
app.post('/api/health/autofix', async (req, res) => {
  const { issues } = req.body || {};
  if (!issues || !Array.isArray(issues) || issues.length === 0) {
    return res.status(400).json({ error: 'No issues provided' });
  }

  if (!claudeCliAvailable) {
    return res.status(503).json({ error: 'Claude CLI not available — cannot auto-fix without it' });
  }

  console.log('[JARVIS] Auto-fix requested for:', issues.map(i => i.key).join(', '));

  // Build a diagnostic prompt for Claude
  const diagLines = issues.map(i =>
    `- ${i.key}: ${i.detail}`
  ).join('\n');

  const fixPrompt = `You are JARVIS system repair agent. The following issues were detected during system verification of a JARVIS Voice Assistant installation at "${JARVIS_DIR}":

${diagLines}

IMPORTANT CONTEXT:
- JARVIS runs on Node.js with Express (server.js) on port ${PORT}
- Voice uses OpenAI Realtime API (needs OPENAI_API_KEY in .env file)
- Task execution uses Claude CLI (needs 'claude' in PATH and authenticated)
- The .env file should be at: ${path.join(JARVIS_DIR, '.env')}
- The server file is at: ${path.join(JARVIS_DIR, 'server.js')}
- Package deps are in: ${path.join(JARVIS_DIR, 'package.json')}

FOR EACH ISSUE, diagnose and fix:
1. If .env is missing or has no OPENAI_API_KEY → Create .env with placeholder and tell user to add their key
2. If Claude CLI not found → Run: npm install -g @anthropic-ai/claude-code
3. If Claude not authenticated → Tell user to run: claude login
4. If node_modules missing → Run: npm install
5. If port conflict → Find and kill the process using port ${PORT}
6. Any other issue → Diagnose from error message and fix

DO NOT ask questions. Fix what you can, report what needs user action.
After fixing, output a summary of what was done.`;

  // Stream Claude output to client
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');

  try {
    const proc = spawn(CLAUDE_CMD, [
      '--print', '--output-format', 'text', '--model', 'claude-sonnet-4-6',
      '--dangerously-skip-permissions',
      '-p', fixPrompt
    ], {
      cwd: JARVIS_DIR,
      env: process.env,
      shell: true,
      timeout: 120000
    });

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      try { res.write(chunk); } catch {}
    });

    proc.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) console.error('[JARVIS autofix stderr]', msg);
    });

    proc.on('close', (code) => {
      console.log(`[JARVIS] Auto-fix completed with code ${code}`);
      try { res.write(`\n[autofix-done] exit code: ${code}`); res.end(); } catch {}
    });

    proc.on('error', (err) => {
      console.error('[JARVIS] Auto-fix spawn error:', err.message);
      try { res.write(`[autofix-error] ${err.message}`); res.end(); } catch {}
    });

  } catch (err) {
    console.error('[JARVIS] Auto-fix error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════
// OBSIDIAN BRAIN — Vault endpoints
// ═══════════════════════════════════════════════
const OBSIDIAN_VAULT = process.env.OBSIDIAN_VAULT || 'C:\\Jrleles_Obsidian';

// GET /api/obsidian/stats — count notes, folders, links
app.get('/api/obsidian/stats', (req, res) => {
  try {
    if (!fs.existsSync(OBSIDIAN_VAULT)) {
      return res.json({ connected: false, error: 'Vault not found' });
    }
    let notes = 0, folders = 0, links = 0;
    function walk(dir) {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        if (item.startsWith('.')) continue;
        const full = path.join(dir, item);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          folders++;
          walk(full);
        } else if (item.endsWith('.md')) {
          notes++;
          const content = fs.readFileSync(full, 'utf-8');
          const matches = content.match(/\[\[[^\]]+\]\]/g);
          if (matches) links += matches.length;
        }
      }
    }
    walk(OBSIDIAN_VAULT);
    res.json({ connected: true, notes, folders, links });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

// GET /api/obsidian/tree — full vault tree
app.get('/api/obsidian/tree', (req, res) => {
  try {
    if (!fs.existsSync(OBSIDIAN_VAULT)) return res.json({ tree: [] });
    function buildTree(dir) {
      const items = fs.readdirSync(dir).filter(i => !i.startsWith('.'));
      const result = [];
      // Folders first, then files
      const folders = items.filter(i => fs.statSync(path.join(dir, i)).isDirectory());
      const files = items.filter(i => i.endsWith('.md') && fs.statSync(path.join(dir, i)).isFile());
      for (const f of folders.sort()) {
        result.push({
          type: 'folder',
          name: f,
          children: buildTree(path.join(dir, f))
        });
      }
      for (const f of files.sort()) {
        result.push({
          type: 'note',
          name: f.replace('.md', ''),
          path: path.relative(OBSIDIAN_VAULT, path.join(dir, f)).replace(/\\/g, '/')
        });
      }
      return result;
    }
    res.json({ tree: buildTree(OBSIDIAN_VAULT) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/obsidian/note?path=... — read a note
app.get('/api/obsidian/note', (req, res) => {
  try {
    const notePath = req.query.path;
    if (!notePath) return res.status(400).json({ error: 'path required' });
    const fullPath = path.join(OBSIDIAN_VAULT, notePath);
    // Security: prevent path traversal
    if (!fullPath.startsWith(OBSIDIAN_VAULT)) return res.status(403).json({ error: 'forbidden' });
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'not found' });
    const content = fs.readFileSync(fullPath, 'utf-8');
    res.json({ path: notePath, content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/obsidian/ingest — create note from text, file content, or session
app.post('/api/obsidian/ingest', express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const { type, text, category, fileName, fileContent, folderPath } = req.body;

    if (type === 'text' && text) {
      // Generate note title and content via GPT-4o-mini
      let title = 'Novo Conhecimento';
      let noteContent = text;
      let folder = category || 'auto';

      if (openai && folder === 'auto') {
        try {
          const aiRes = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: 'Organize this knowledge into an Obsidian note. Return JSON: {"title":"short title","folder":"best folder (Projetos|Negócios & Finanças|Marketing Digital|Programação & IA|Tecnologias)","content":"organized markdown with [[links]] to related concepts"}' },
              { role: 'user', content: text }
            ],
            response_format: { type: 'json_object' },
            max_tokens: 2000
          });
          const parsed = JSON.parse(aiRes.choices[0].message.content);
          title = parsed.title || title;
          folder = parsed.folder || 'geral';
          noteContent = parsed.content || text;
        } catch {}
      }

      // Map category to folder
      const folderMap = {
        projeto: 'Projetos', decisao: 'Decisões Técnicas',
        pessoa: '', aprendizado: '', preferencia: '',
        negocio: 'Negócios & Finanças', auto: folder
      };
      const targetFolder = folderMap[category] || folder;
      const targetDir = targetFolder ? path.join(OBSIDIAN_VAULT, targetFolder) : OBSIDIAN_VAULT;
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

      const safeName = title.replace(/[<>:"/\\|?*]/g, '').substring(0, 80);
      const filePath = path.join(targetDir, `${safeName}.md`);
      fs.writeFileSync(filePath, noteContent, 'utf-8');

      return res.json({ ok: true, path: path.relative(OBSIDIAN_VAULT, filePath).replace(/\\/g, '/'), title });
    }

    if (type === 'file' && fileContent) {
      // Save file content as note
      const name = (fileName || 'Imported').replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*]/g, '');
      const filePath = path.join(OBSIDIAN_VAULT, `${name}.md`);

      let content = fileContent;
      // If content is base64 (binary file), try to extract text
      if (fileContent.startsWith('data:')) {
        content = `# ${name}\n\n> Arquivo importado\n\n\`\`\`\n${fileContent.substring(0, 500)}...\n\`\`\``;
      }

      fs.writeFileSync(filePath, content, 'utf-8');
      return res.json({ ok: true, path: `${name}.md`, title: name });
    }

    if (type === 'folder' && folderPath) {
      // Ingest entire folder
      if (!fs.existsSync(folderPath)) return res.status(404).json({ error: 'Folder not found' });
      let count = 0;
      const files = fs.readdirSync(folderPath).filter(f => f.endsWith('.md') || f.endsWith('.txt'));
      for (const f of files) {
        const content = fs.readFileSync(path.join(folderPath, f), 'utf-8');
        const name = f.replace(/\.[^.]+$/, '');
        fs.writeFileSync(path.join(OBSIDIAN_VAULT, `${name}.md`), content, 'utf-8');
        count++;
      }
      return res.json({ ok: true, count, message: `${count} files ingested` });
    }

    if (type === 'session') {
      // Ingest from current session context
      const memoryFile = path.join(SYSTEM_DIR, 'JARVIS-MEMORY.md');
      const historyFile = path.join(SYSTEM_DIR, 'JARVIS-HISTORY.json');
      let sessionData = '';

      if (fs.existsSync(historyFile)) {
        try {
          const history = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
          const last10 = history.slice(-10);
          sessionData = last10.map(h => `[${h.role}] ${h.content}`).join('\n\n');
        } catch {}
      }

      if (!sessionData) {
        return res.json({ ok: false, error: 'No session data found' });
      }

      // Use GPT to extract valuable knowledge
      if (openai) {
        try {
          const aiRes = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: 'Extract valuable knowledge from this session. Create 1-3 Obsidian notes. Return JSON array: [{"title":"...","content":"markdown with [[links]]","folder":"best folder name"}]. Only extract decisions, learnings, preferences, projects created. Skip trivial chat.' },
              { role: 'user', content: sessionData }
            ],
            response_format: { type: 'json_object' },
            max_tokens: 3000
          });
          const parsed = JSON.parse(aiRes.choices[0].message.content);
          const notes = Array.isArray(parsed) ? parsed : (parsed.notes || [parsed]);
          let created = 0;
          for (const note of notes) {
            if (!note.title) continue;
            const dir = note.folder ? path.join(OBSIDIAN_VAULT, note.folder) : OBSIDIAN_VAULT;
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const safeName = note.title.replace(/[<>:"/\\|?*]/g, '').substring(0, 80);
            fs.writeFileSync(path.join(dir, `${safeName}.md`), note.content || '', 'utf-8');
            created++;
          }
          return res.json({ ok: true, count: created, notes: notes.map(n => n.title) });
        } catch (err) {
          return res.json({ ok: false, error: err.message });
        }
      }
      return res.json({ ok: false, error: 'OpenAI not configured for session analysis' });
    }

    res.status(400).json({ error: 'Invalid type. Use: text, file, folder, or session' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/weather - Free weather data (no API key needed)
app.get('/api/weather', async (req, res) => {
  const city = req.query.city || req.query.c || '';
  const lang = req.query.lang || 'BR';
  const data = await fetchWeather(city, lang);
  if (data) res.json(data);
  else res.status(404).json({ error: 'Weather not found' });
});

// ═══════════════════════════════════════════════
// COMPUTER USE v2 — Ultimate System
// ═══════════════════════════════════════════════

// ── Screen State Daemon (Layer 0) ──
let screenStateDaemon = null;
let _screenState = { value: null, ts: 0 };
let _screenStateRestarts = 0;
const MAX_DAEMON_RESTARTS = 10;

function startScreenStateDaemon() {
  const script = path.join(JARVIS_DIR, 'system', 'screen-state.py');
  if (!fs.existsSync(script)) { console.log('[JARVIS] screen-state.py not found — will not retry'); return; }
  screenStateDaemon = spawn(PYTHON_CMD, ['-u', script, '--mode=stdout'], {
    cwd: JARVIS_DIR, stdio: ['ignore', 'pipe', 'pipe']
  });
  let buffer = '';
  screenStateDaemon.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        _screenState.value = JSON.parse(line);
        _screenState.ts = Date.now();
        _screenStateRestarts = 0; // successful output — reset counter
      } catch {}
    }
  });
  screenStateDaemon.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.error('[ScreenState]', msg);
  });
  screenStateDaemon.on('exit', (code) => {
    console.log(`[JARVIS] Screen state daemon exited (${code})`);
    screenStateDaemon = null;
    _screenStateRestarts++;
    if (_screenStateRestarts >= MAX_DAEMON_RESTARTS) {
      console.error(`[JARVIS] Screen state daemon failed ${_screenStateRestarts} times — giving up`);
      return;
    }
    // Restart after 5s with exponential backoff capped at 30s
    const delay = Math.min(5000 * Math.pow(1.5, _screenStateRestarts - 1), 30000);
    setTimeout(startScreenStateDaemon, delay);
  });
  console.log('[JARVIS] Screen state daemon started');
}

// Start daemon on server boot (delayed 3s to not block startup)
setTimeout(startScreenStateDaemon, 3000);

// ── Clipboard Intelligence Daemon ──
let clipboardDaemon = null;
let _lastClipboard = null;
let _clipboardRestarts = 0;

function startClipboardDaemon() {
  const script = path.join(JARVIS_DIR, 'system', 'clipboard-intel.py');
  if (!fs.existsSync(script)) { console.log('[JARVIS] clipboard-intel.py not found — will not retry'); return; }
  clipboardDaemon = spawn(PYTHON_CMD, ['-u', script], {
    cwd: JARVIS_DIR, stdio: ['ignore', 'pipe', 'pipe']
  });
  let buffer = '';
  clipboardDaemon.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        _lastClipboard = JSON.parse(line);
        _clipboardRestarts = 0; // successful output — reset counter
      } catch {}
    }
  });
  clipboardDaemon.on('exit', (code) => {
    console.log(`[JARVIS] Clipboard daemon exited (${code})`);
    clipboardDaemon = null;
    _clipboardRestarts++;
    if (_clipboardRestarts >= MAX_DAEMON_RESTARTS) {
      console.error(`[JARVIS] Clipboard daemon failed ${_clipboardRestarts} times — giving up`);
      return;
    }
    const delay = Math.min(5000 * Math.pow(1.5, _clipboardRestarts - 1), 30000);
    setTimeout(startClipboardDaemon, delay);
  });
  console.log('[JARVIS] Clipboard intelligence daemon started');
}
setTimeout(startClipboardDaemon, 4000);

// ── GET /api/screen-state — Current desktop state (instant, no screenshot) ──
app.get('/api/screen-state', (req, res) => {
  if (_screenState.value && (Date.now() - _screenState.ts < 5000)) {
    res.json(_screenState.value);
  } else {
    // Fallback: run screen-state.py once
    try {
      const script = path.join(JARVIS_DIR, 'system', 'screen-state.py');
      const result = execSync(`"${PYTHON_CMD}" -u "${script}" --mode=stdout`, {
        encoding: 'utf-8', timeout: 5000
      });
      const lines = result.trim().split('\n');
      const last = lines[lines.length - 1];
      res.json(JSON.parse(last));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
});

// ── GET /api/clipboard — Last clipboard analysis ──
app.get('/api/clipboard', (req, res) => {
  res.json(_lastClipboard || { clipboard: null, analysis: null });
});

// ── POST /api/computer-use/v2 — JARVIS Computer Use v3: Vision-First + Observe-Act Loop ──
app.post('/api/computer-use/v2', express.json({ limit: '10mb' }), async (req, res) => {
  const { task, language = 'BR' } = req.body;
  if (!task) return res.status(400).json({ error: 'task required' });
  const t0 = Date.now();

  try {
    // ═══ STEP 1: Screen State (instant from daemon cache) ═══
    const state = _screenState.value || {};
    const stateText = state.fg
      ? `Foreground: "${state.fg.title}" (${state.fg.proc})\nOpen windows: ${(state.windows || []).map(w => w.title).filter(t => t && t !== 'Program Manager').join(', ')}\nMonitors: ${(state.monitors || []).length}\nCursor: (${state.cursor?.[0]}, ${state.cursor?.[1]})`
      : 'Screen state unavailable';

    // ═══ STEP 2: Auto UI Inspection (foreground window elements) ═══
    let uiElements = '';
    if (state.fg && state.fg.title) {
      try {
        const uiaScript = path.join(JARVIS_DIR, 'system', 'ui-automation.py');
        const inspectPlan = { actions: [{ type: 'uia_tree', window: state.fg.title, depth: 3 }] };
        const uiaResult = spawnSync(PYTHON_CMD, ['-u', uiaScript], {
          input: JSON.stringify(inspectPlan), encoding: 'utf-8', timeout: 5000, maxBuffer: 1024 * 1024
        });
        if (uiaResult.stdout) {
          const lines = uiaResult.stdout.trim().split('\n').filter(l => l.trim());
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line);
              if (parsed.tree) {
                // Flatten tree to list of clickable elements
                const elements = [];
                function flattenTree(node, depth = 0) {
                  if (!node) return;
                  if (node.name && node.control_type && depth < 3) {
                    elements.push(`${node.control_type}: "${node.name}"`);
                  }
                  if (node.children) node.children.forEach(c => flattenTree(c, depth + 1));
                }
                flattenTree(parsed.tree);
                if (elements.length > 0) {
                  uiElements = `\nFOREGROUND WINDOW UI ELEMENTS (use these names for uia_click):\n${elements.slice(0, 40).join('\n')}`;
                }
              }
            } catch {}
          }
        }
      } catch {}
    }

    // ═══ STEP 3: Vision — ALWAYS capture screenshot ═══
    let screenshotData = null;
    try {
      const ssScript = path.join(JARVIS_DIR, 'system', 'screenshot.py');
      const ssResult = spawnSync(PYTHON_CMD, [ssScript, '1'], {
        encoding: 'utf-8', timeout: 8000, maxBuffer: 30 * 1024 * 1024
      });
      if (ssResult.stdout) {
        const ssJson = JSON.parse(ssResult.stdout.trim());
        screenshotData = ssJson.data; // base64 JPEG
      }
    } catch {}

    console.log(`[JARVIS CU v3] State: ${stateText.split('\n')[0]} | UI elements: ${uiElements ? 'YES' : 'NO'} | Screenshot: ${screenshotData ? 'YES' : 'NO'}`);

    // ═══ STEP 4: Build planner prompt WITH vision + UI elements ═══
    const plannerPrompt = `You are JARVIS, an AI controlling a Windows 11 PC. The user is watching everything you do in real-time.

CURRENT SCREEN STATE:
${stateText}
${uiElements}
${screenshotData ? '\n[A screenshot of the current screen is attached. Use it to identify exact positions of UI elements, buttons, and text fields.]' : ''}

AVAILABLE ACTIONS (JSON array, executed in order):
- {"type":"shell","command":"..."} — run shell command (start apps, run scripts, open URLs)
- {"type":"app_focus","title":"..."} — bring window to front (partial title match)
- {"type":"app_close","title":"..."} — close window gracefully
- {"type":"app_minimize","title":"..."} / {"type":"app_maximize","title":"..."}
- {"type":"key","keys":"ctrl+c"} — keyboard shortcut
- {"type":"type","text":"..."} — type text (clipboard paste, supports Unicode/Portuguese)
- {"type":"click","x":N,"y":N} — click at screen coordinates (use ONLY if no UI element available)
- {"type":"uia_click","window":"...","name":"...","control_type":"..."} — click by UI automation name (PREFERRED)
- {"type":"uia_set_value","window":"...","name":"...","value":"..."} — fill input field
- {"type":"uia_get_text","window":"...","name":"..."} — read text from element
- {"type":"scroll","direction":"down","amount":5} — scroll
- {"type":"wait","ms":1000} — wait milliseconds
- {"type":"wait_for","title_contains":"...","timeout":10000} — wait for window

CRITICAL RULES:
1. Use "shell" to open apps: start excel, start chrome URL, start notepad
2. ALWAYS add wait + wait_for after launching any app
3. For Excel: open → wait → Escape (close start screen) → type headers with Tab between cells, Enter for new row
4. For Chrome/YouTube: start chrome "https://www.youtube.com/results?search_query=QUERY"
5. ALWAYS prefer "uia_click" with element names from the UI ELEMENTS list above
6. Only use "click" with x,y coordinates as LAST RESORT when no UI element name is available
7. ${screenshotData ? 'Use the attached screenshot to identify positions of buttons and elements' : 'No screenshot available — use UI element names or standard app layouts'}
8. Plan EVERY step. Don't skip anything. Be thorough.

TASK: ${task}

Respond with ONLY a JSON object: {"actions":[...], "expected":"description of what the user will see when done"}`;

    // ═══ STEP 5: Get plan from Claude ═══
    const planResult = await new Promise((resolve, reject) => {
      const proc = spawn(CLAUDE_CMD, [
        '--print', '--output-format', 'text',
        '--model', 'claude-sonnet-4-6',
        '--dangerously-skip-permissions'
      ], { shell: true, cwd: JARVIS_DIR, timeout: 30000 });
      proc.stdin.write(plannerPrompt);
      proc.stdin.end();
      let stdout = '', stderr = '';
      proc.stdout.on('data', d => { stdout += d; });
      proc.stderr.on('data', d => { stderr += d; });
      proc.on('close', (code) => {
        if (code === 0 && stdout.trim()) resolve(stdout.trim());
        else reject(new Error(stderr || `exit code ${code}`));
      });
      proc.on('error', reject);
    });

    // Parse plan
    let plan;
    try {
      const jsonMatch = planResult.match(/\{[\s\S]*\}/);
      plan = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    } catch {
      return res.json({ ok: false, error: 'Failed to parse plan', raw: planResult.substring(0, 500) });
    }
    if (!plan || !plan.actions || !plan.actions.length) {
      return res.json({ ok: false, error: 'Empty plan', raw: planResult.substring(0, 500) });
    }

    // ═══ STEP 6: Smart Action Chaining — auto-insert waits ═══
    const smartActions = [];
    for (let i = 0; i < plan.actions.length; i++) {
      const action = plan.actions[i];
      smartActions.push(action);

      // After shell commands that open apps, ensure wait exists
      if (action.type === 'shell' && /^start\s/i.test(action.command || '')) {
        const next = plan.actions[i + 1];
        if (!next || (next.type !== 'wait' && next.type !== 'wait_for')) {
          smartActions.push({ type: 'wait', ms: 2000 });
        }
      }
    }
    plan.actions = smartActions;

    console.log(`[JARVIS CU v3] Plan: ${plan.actions.length} actions | Expected: ${plan.expected || 'N/A'}`);

    // ═══ STEP 7: Execute plan ═══
    const uiaScript = path.join(JARVIS_DIR, 'system', 'ui-automation.py');

    async function executePlan(actionPlan) {
      return new Promise((resolve, reject) => {
        const proc = spawn(PYTHON_CMD, ['-u', uiaScript], {
          cwd: JARVIS_DIR, stdio: ['pipe', 'pipe', 'pipe'], timeout: 90000
        });
        proc.stdin.write(JSON.stringify(actionPlan));
        proc.stdin.end();
        let stdout = '', stderr = '';
        proc.stdout.on('data', d => { stdout += d; });
        proc.stderr.on('data', d => { stderr += d; });
        proc.on('close', (code) => {
          const results = stdout.trim().split('\n').filter(l => l.trim()).map(l => {
            try { return JSON.parse(l); } catch { return { raw: l }; }
          });
          resolve({ code, results, stderr: stderr.trim() });
        });
        proc.on('error', reject);
      });
    }

    const execResult = await executePlan(plan);
    const failed = execResult.results.filter(r => r.ok === false);
    const totalActions = plan.actions.length;

    // ═══ STEP 8: Observe-Act Loop — replan if actions failed ═══
    let replanAttempts = 0;
    let finalResult = execResult;

    if (failed.length > 0 && failed.length <= Math.ceil(totalActions / 2)) {
      console.log(`[JARVIS CU v3] ${failed.length}/${totalActions} failed. Starting replan...`);

      while (replanAttempts < 2 && failed.length > 0) {
        replanAttempts++;

        // Get fresh screen state after execution
        const freshState = _screenState.value || {};
        const freshStateText = freshState.fg
          ? `Foreground: "${freshState.fg.title}" (${freshState.fg.proc})`
          : 'Unknown';

        const failedDetails = failed.map(f => `Action "${f.type || 'unknown'}": ${f.error || f.detail || 'failed'}`).join('\n');

        const replanPrompt = `You are JARVIS. Some actions failed during PC control. Fix them.

CURRENT SCREEN STATE: ${freshStateText}
ORIGINAL TASK: ${task}
EXPECTED RESULT: ${plan.expected || 'N/A'}

FAILED ACTIONS:
${failedDetails}

Generate ONLY corrective actions as JSON: {"actions":[...], "expected":"..."}
Focus on what FAILED. Don't repeat successful actions.`;

        try {
          const replanResult = await new Promise((resolve, reject) => {
            const proc = spawn(CLAUDE_CMD, [
              '--print', '--output-format', 'text',
              '--model', 'claude-haiku-4-5-20251001',
              '--dangerously-skip-permissions'
            ], { shell: true, cwd: JARVIS_DIR, timeout: 15000 });
            proc.stdin.write(replanPrompt);
            proc.stdin.end();
            let stdout = '';
            proc.stdout.on('data', d => { stdout += d; });
            proc.on('close', () => resolve(stdout.trim()));
            proc.on('error', reject);
          });

          const replanMatch = replanResult.match(/\{[\s\S]*\}/);
          if (replanMatch) {
            const fixPlan = JSON.parse(replanMatch[0]);
            if (fixPlan.actions && fixPlan.actions.length > 0) {
              console.log(`[JARVIS CU v3] Replan ${replanAttempts}: ${fixPlan.actions.length} corrective actions`);
              finalResult = await executePlan(fixPlan);
              const newFailed = finalResult.results.filter(r => r.ok === false);
              if (newFailed.length === 0) break; // Fixed!
            }
          }
        } catch (replanErr) {
          console.error(`[JARVIS CU v3] Replan ${replanAttempts} failed:`, replanErr.message);
          break;
        }
      }
    }

    // ═══ STEP 9: Response ═══
    const elapsed = Date.now() - t0;
    const allResults = [...execResult.results, ...(finalResult !== execResult ? finalResult.results : [])];
    const totalFailed = allResults.filter(r => r.ok === false).length;
    const totalSuccess = allResults.filter(r => r.ok === true).length;

    console.log(`[JARVIS CU v3] Done in ${elapsed}ms | ${totalSuccess} success | ${totalFailed} failed | ${replanAttempts} replans`);

    res.json({
      ok: totalFailed === 0 || totalSuccess > totalFailed,
      plan: totalActions + ' actions planned',
      executed: allResults.length,
      failed: totalFailed,
      replans: replanAttempts,
      expected: plan.expected,
      elapsed: elapsed,
      details: allResults
    });

  } catch (err) {
    console.error('[JARVIS CU v3] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/browser-control — CDP browser automation ──
app.post('/api/browser-control', express.json(), async (req, res) => {
  try {
    const script = path.join(JARVIS_DIR, 'system', 'browser-control.py');
    const proc = spawn(PYTHON_CMD, ['-u', script, '--auto-connect'], {
      cwd: JARVIS_DIR, stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000
    });
    proc.stdin.write(JSON.stringify(req.body) + '\n');
    proc.stdin.end();

    let stdout = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.on('close', () => {
      try {
        const lines = stdout.trim().split('\n').filter(l => l.trim());
        const last = lines[lines.length - 1];
        res.json(JSON.parse(last));
      } catch { res.json({ ok: false, error: 'Parse error', raw: stdout }); }
    });
    proc.on('error', (err) => res.status(500).json({ error: err.message }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/files/search — File Intelligence search ──
app.post('/api/files/search', express.json(), async (req, res) => {
  try {
    const { query, cmd = 'search' } = req.body;
    const script = path.join(JARVIS_DIR, 'system', 'file-index.py');
    const args = cmd === 'search' ? [script, 'search', query || '']
               : cmd === 'recent' ? [script, 'recent', String(req.body.days || 7)]
               : cmd === 'large'  ? [script, 'large', String(req.body.mb || 100)]
               : cmd === 'organize' ? [script, 'organize', req.body.path || '']
               : [script, 'search', query || ''];

    const result = execSync(`"${PYTHON_CMD}" ${args.map(a => `"${a}"`).join(' ')}`, {
      encoding: 'utf-8', timeout: 30000, maxBuffer: 10 * 1024 * 1024
    });
    res.json(JSON.parse(result.trim()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/workflow — Workflow Recording & Replay ──
app.post('/api/workflow', express.json(), async (req, res) => {
  try {
    const { action, name, speed } = req.body;
    const script = path.join(JARVIS_DIR, 'system', 'workflow-recorder.py');

    if (action === 'list') {
      const result = execSync(`"${PYTHON_CMD}" "${script}" list`, { encoding: 'utf-8', timeout: 5000 });
      return res.json(JSON.parse(result.trim()));
    }

    if (action === 'replay' && name) {
      const args = [`"${PYTHON_CMD}"`, `"${script}"`, 'replay', `"${name}"`];
      if (speed) args.push(`--speed=${speed}`);
      const proc = spawn(PYTHON_CMD, [script, 'replay', name, ...(speed ? [`--speed=${speed}`] : [])], {
        cwd: JARVIS_DIR, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000
      });
      let stdout = '';
      proc.stdout.on('data', d => { stdout += d; });
      proc.on('close', (code) => { res.json({ ok: code === 0, output: stdout }); });
      proc.on('error', (err) => { res.status(500).json({ error: err.message }); });
      return;
    }

    res.status(400).json({ error: 'action required: list, replay' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════
// ═══════════════════════════════════════════════
// COWORK MODE — JARVIS observa e ajuda em paralelo
// ═══════════════════════════════════════════════
let coworkActive = false;
let coworkInterval = null;
let coworkLastState = '';
let coworkScreenContext = ''; // Current screen context for voice queries

app.post('/api/cowork/start', (req, res) => {
  if (coworkActive) return res.json({ ok: true, status: 'already running' });
  coworkActive = true;

  coworkInterval = setInterval(async () => {
    if (!coworkActive || !_screenState.value) return;

    const state = _screenState.value;
    const fg = state.fg;
    if (!fg || !fg.title) return;

    // Só analisa se o contexto mudou (janela diferente)
    const currentContext = fg.title + '|' + fg.proc;
    if (currentContext === coworkLastState) return;
    coworkLastState = currentContext;

    // Análise leve: Claude decide se tem algo útil pra fazer
    try {
      const analysisPrompt = `You are JARVIS, an AI assistant observing the user's screen in real-time. You act as a knowledgeable professor and executive assistant.

Current window: "${fg.title}" (${fg.proc})
Other open windows: ${(state.windows || []).slice(0, 5).map(w => w.title).join(', ')}

Based on this context:
1. Be aware of what the user is working on
2. If they ask a question via voice, you'll have this context
3. Only proactively suggest if something is genuinely useful

Reply with JSON: {"action":"none","context":"brief note about what user is doing"} if nothing to suggest, or {"action":"suggest","message":"brief helpful suggestion in Portuguese","context":"what user is doing"} if you have something useful.
Keep suggestions rare and high-value. Max 1 sentence.`;

      const proc = spawn(CLAUDE_CMD, [
        '--print', '--output-format', 'text',
        '--model', 'claude-haiku-4-5-20251001',
        '--dangerously-skip-permissions'
      ], { shell: true, cwd: JARVIS_DIR, timeout: 15000 });

      proc.stdin.write(analysisPrompt);
      proc.stdin.end();

      let stdout = '';
      proc.stdout.on('data', d => { stdout += d; });
      proc.on('close', () => {
        try {
          const match = stdout.match(/\{[\s\S]*\}/);
          if (match) {
            const result = JSON.parse(match[0]);
            // Save screen context for voice queries
            if (result.context) coworkScreenContext = result.context;
            if (result.action === 'suggest' && result.message) {
              pushNotification({ type: 'cowork-suggest', message: result.message });
              console.log(`[JARVIS Cowork] 💡 ${result.message}`);
            }
          }
        } catch {}
      });
    } catch {}
  }, 10000); // Analisa a cada 10 segundos

  console.log('[JARVIS] Cowork mode ACTIVATED');
  res.json({ ok: true, status: 'started' });
});

app.post('/api/cowork/stop', (req, res) => {
  coworkActive = false;
  if (coworkInterval) { clearInterval(coworkInterval); coworkInterval = null; }
  coworkLastState = '';
  console.log('[JARVIS] Cowork mode DEACTIVATED');
  res.json({ ok: true, status: 'stopped' });
});

app.get('/api/cowork/status', (req, res) => {
  res.json({ active: coworkActive });
});


// DESKTOP PET LAUNCHER
// ═══════════════════════════════════════════════
let petProcess = null;
let petRunning = false;

app.post('/api/pet/launch', (req, res) => {
  // Toggle: if running, kill it
  if (petRunning && petProcess) {
    try {
      process.kill(petProcess.pid);
    } catch(e) {}
    petProcess = null;
    petRunning = false;
    return res.json({ ok: true, action: 'closed', message: 'Desktop Pet fechado.' });
  }

  const petDir = path.join(__dirname, 'pet');
  const electronExe = path.join(petDir, 'node_modules', 'electron', 'dist', 'electron.exe');
  try {
    petProcess = spawn(electronExe, ['.'], {
      cwd: petDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    petRunning = true;
    petProcess.on('exit', () => { petRunning = false; petProcess = null; });
    petProcess.unref();
    res.json({ ok: true, action: 'opened', message: 'Desktop Pet aberto!' });
  } catch(err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PET MIC STATE — broadcast mic state to cockpit clients
let petMicActive = false;
app.post('/api/pet/mic-state', (req, res) => {
  petMicActive = req.body.active || false;
  pushNotification({ type: 'pet-mic', active: petMicActive });
  console.log(`[JARVIS Pet] Mic ${petMicActive ? 'ON — Cowork + Voice active' : 'OFF'}`);
  res.json({ ok: true, active: petMicActive });
});

app.get('/api/pet/mic-state', (req, res) => {
  res.json({ active: petMicActive });
});

// LEGACY ENDPOINTS (kept for backward compatibility)
// ═══════════════════════════════════════════════

// GET /api/screenshot - Capture screen directly via Python (no browser sharing needed)
// ?monitor=1 (primary), ?monitor=2 (second), ?monitor=all (all stitched), ?monitor=info (list)
app.get('/api/screenshot', (req, res) => {
  try {
    const monitor = req.query.monitor || '1';
    const scriptPath = path.join(JARVIS_DIR, 'system', 'screenshot.py');
    const result = execSync(`"${PYTHON_CMD}" "${scriptPath}" ${monitor}`, {
      encoding: 'utf-8', timeout: 15000, maxBuffer: 30 * 1024 * 1024
    });
    res.json(JSON.parse(result.trim()));
  } catch (err) {
    console.error('[JARVIS] Screenshot error:', err.message?.slice(0, 200));
    res.status(500).json({ error: 'Screenshot failed' });
  }
});

// POST /api/computer-use - Execute mouse/keyboard action on screen
app.post('/api/computer-use', (req, res) => {
  try {
    const scriptPath = path.join(JARVIS_DIR, 'system', 'computer-action.py');
    const argsJson = JSON.stringify(req.body).replace(/"/g, '\\"');
    execSync(`"${PYTHON_CMD}" "${scriptPath}" "${argsJson}"`, { timeout: 10000, shell: true });
    res.json({ success: true, action: req.body.action });
  } catch (err) {
    console.error('[JARVIS] Computer-use error:', err.message?.slice(0, 200));
    res.status(500).json({ error: err.message?.slice(0, 200) });
  }
});

// POST /api/computer-use/task - Claude analyses screen and performs actions autonomously
app.post('/api/computer-use/task', async (req, res) => {
  const { task, language = 'BR' } = req.body || {};
  if (!task) return res.status(400).json({ error: 'No task provided' });
  if (!claudeCliAvailable) return res.status(503).json({ error: 'Claude CLI not available' });

  console.log(`[JARVIS] Computer-use task: ${task}`);

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');

  const prompt = `You are JARVIS controlling the user's Windows computer. You have these tools available via HTTP:

1. GET /api/screenshot - captures the screen, returns { data: "data:image/jpeg;base64,..." }
2. POST /api/computer-use - performs actions:
   - { action: "click", x: 100, y: 200 }
   - { action: "doubleclick", x: 100, y: 200 }
   - { action: "rightclick", x: 100, y: 200 }
   - { action: "type", text: "hello world" }
   - { action: "typewrite", text: "texto em português" } (supports unicode via clipboard)
   - { action: "hotkey", key: "ctrl+c" }
   - { action: "press", key: "enter" }
   - { action: "scroll", y: 3 } (positive=up, negative=down)
   - { action: "move", x: 100, y: 200 }

TASK: ${task}

INSTRUCTIONS:
1. First take a screenshot to see the current screen state
2. Analyze what you see and plan your actions
3. Execute each action step by step using Bash to call the API:
   - Screenshot: curl -s http://localhost:${PORT}/api/screenshot
   - Actions: curl -s -X POST http://localhost:${PORT}/api/computer-use -H "Content-Type: application/json" -d '{"action":"click","x":100,"y":200}'
4. After each action, take another screenshot to verify the result
5. Continue until the task is complete
6. Report what you did

IMPORTANT: Use curl to call the APIs. The server is running on localhost:${PORT}.
Work step by step. Take screenshots between actions to see results.
For typing Portuguese/Spanish text, use "typewrite" action (uses clipboard).
To open programs: use hotkey "win+r", type the program name, press enter.
To open URLs: use Bash "start https://..." command directly.`;

  try {
    const proc = spawn(CLAUDE_CMD, [
      '--print', '--output-format', 'text',
      '--dangerously-skip-permissions'
    ], {
      cwd: JARVIS_DIR, env: process.env, shell: true
    });

    proc.stdin.write(prompt);
    proc.stdin.end();

    proc.stdout.on('data', data => {
      try { res.write(data); } catch {}
    });
    proc.stderr.on('data', data => {
      const msg = data.toString().trim();
      if (msg && !msg.includes('ExperimentalWarning')) {
        console.error('[JARVIS CU stderr]', msg);
      }
    });
    proc.on('close', code => {
      console.log(`[JARVIS] Computer-use task done (code ${code})`);
      notifyBuildComplete(task, 'Computer use task completed', language);
      try { res.end(); } catch {}
    });
    proc.on('error', err => {
      try { res.write(`[error] ${err.message}`); res.end(); } catch {}
    });

    setTimeout(() => { try { proc.kill(); } catch {} }, 120000);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/jarvis/shutdown', (req, res) => {
  const remote = req.socket?.remoteAddress || '';
  const isLocal =
    remote === '127.0.0.1' ||
    remote === '::1' ||
    remote === '::ffff:127.0.0.1';
  const origin = req.get('origin');
  const host = req.get('host');
  let isSameOrigin = !origin;

  if (origin && host) {
    try {
      isSameOrigin = new URL(origin).host === host;
    } catch {
      isSameOrigin = false;
    }
  }

  if (!isLocal || !isSameOrigin) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  res.json({ ok: true, message: 'Jarvis desligando...' });
  setTimeout(() => process.exit(0), 500);
});

// ========== DISABLE EXCEL AUTORECOVERY (prevents recovery panel on close) ==========
try {
  execSync('reg add "HKCU\\Software\\Microsoft\\Office\\16.0\\Excel\\Options" /v AutoRecoverEnabled /t REG_DWORD /d 0 /f', { stdio: 'ignore' });
} catch {}

// ========== START SERVER ==========
const server = app.listen(PORT, () => {
  const chrome = findChrome();
  console.log('');
  console.log('  ==========================================');
  console.log('    J A R V I S   —   System Status');
  console.log('  ==========================================');
  console.log('');
  console.log(`  Server:     http://localhost:${PORT}`);
  console.log(`  Directory:  ${JARVIS_DIR}`);
  console.log(`  OpenAI:     ${openai ? '✅ Connected (Voice + TTS + STT)' : '❌ Not configured — voice disabled'}`);
  console.log(`  Claude CLI: ${cliExists ? '✅ Found — verifying auth in background...' : '❌ Not installed'}`);
  console.log(`  Chrome:     ${chrome ? '✅ ' + chrome : '⚠️  Using bundled Chromium'}`);
  console.log(`  Python:     ${fs.existsSync(PYTHON_CMD) ? '✅ Python 3.11' : '⚠️  Not found — Excel features disabled'}`);
  console.log('');
  if (!cliExists) {
    console.log('  ⚠️  WARNING: Claude Code CLI not found.');
    console.log('  ⚠️  Install: npm install -g @anthropic-ai/claude-code');
    console.log('  ⚠️  Then run: claude (to login)');
    console.log('');
  }
  if (!openai) {
    console.log('  ⚠️  WARNING: Voice is DISABLED.');
    console.log('  ⚠️  Add OPENAI_API_KEY to .env file.');
    console.log('');
  }
  console.log('  ✅ Server ready. Accepting requests.');
  console.log('');
  console.log('  ==========================================');
  console.log('');

  // Kick off async auth check AFTER server is listening (non-blocking)
  if (cliExists) {
    checkClaudeCliAuth().then(() => {
      if (claudeCliAvailable) {
        console.log('[JARVIS] ✅ Claude auth verified. Task execution ENABLED.');
        console.log(`[JARVIS] ✅ Pools: Opus×${pools.opus.pool.length} Sonnet×${pools.sonnet.pool.length} Haiku×${pools.haiku.pool.length}`);
      }
    });
  }
});

// Graceful shutdown — kill warm pools and daemons
function gracefulShutdown() {
  console.log('\n[JARVIS] Shutting down gracefully...');
  // Kill warm pool processes
  ['opus', 'sonnet', 'haiku'].forEach(m => {
    if (pools[m]) pools[m].pool.forEach(p => { try { p.kill(); } catch {} });
  });
  // Kill daemons
  try { if (typeof screenStateDaemon !== 'undefined' && screenStateDaemon) screenStateDaemon.kill(); } catch {}
  try { if (typeof clipboardDaemon !== 'undefined' && clipboardDaemon) clipboardDaemon.kill(); } catch {}
  // Close server
  server.close(() => { process.exit(0); });
  setTimeout(() => { process.exit(1); }, 5000); // Force exit after 5s
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Handle port already in use
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[JARVIS] Port ${PORT} already in use. Close the other JARVIS instance or set PORT in .env`);
    process.exit(1);
  }
  throw err;
});
