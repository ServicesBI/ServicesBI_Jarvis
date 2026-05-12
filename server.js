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

import { registerMetricsQuickModule } from './server/modules/metrics-quick.module.js';
import { registerObsidianModule } from './server/modules/obsidian.module.js';
import { registerMegaBrainModule } from './server/modules/mega-brain.module.js';
import { registerAgentsModule } from './server/modules/agents.module.js';
import { registerServerOnlineModule } from './server/modules/server-online.module.js';
import { registerAiModelsModule } from './server/modules/ai-models.module.js';
import { registerMenuModule } from './server/modules/menu.module.js';
import { registerInterfaceModule } from './server/modules/interface.module.js';

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

// ========== DEPS OBJECT ==========

// Cross-module mutable state
const coworkState = { active: false, screenContext: '' };
const executorState = { currentExecutorMode: 'auto', VALID_EXECUTOR_MODES: [] };
const daemonRefs = {};

const deps = {
  // Constants
  JARVIS_DIR, PROJECTS_DIR, SYSTEM_DIR, PORT,
  MEMORY_FILE, HISTORY_FILE, EMBEDDINGS_FILE,
  MAX_HISTORY, MAX_EMBEDDINGS,
  // Clients
  openai, CLAUDE_CMD, PYTHON_CMD,
  // Middleware
  upload, htmlToPdf, findChrome,
  // CLI state (mutable via getter/setter)
  get claudeCliAvailable() { return claudeCliAvailable; },
  set claudeCliAvailable(v) { claudeCliAvailable = v; },
  get claudeCliError() { return claudeCliError; },
  set claudeCliError(v) { claudeCliError = v; },
  get claudeCliChecking() { return claudeCliChecking; },
  set claudeCliChecking(v) { claudeCliChecking = v; },
  // Pools
  pools, acquireWithFallback, acquireTaskProc, getPool,
  // Shared state
  pendingSpawns, attachments,
  get _lastAction() { return _lastAction; },
  set _lastAction(v) { _lastAction = v; },
  // Notifications
  notificationClients, pushNotification, notifyBuildComplete, sessionStats,
  // Memory functions
  loadMemory, loadHistory, saveHistory, formatHistoryForPrompt,
  loadMemoryCached, loadHistoryCached, appendHistoryFast, compactMemoryIfNeeded,
  findRelevantMemories, storeMemory, embed, loadProjectContext,
  // Routing/task
  detectAgent, selectModelByComplexity, getAgentContext,
  isTaskRequest, detectParallelTasks,
  // Fast path
  tryFastExecution, trySmartFastExecution, handleMediaCommand, isMediaCommand, parseMediaRequest,
  isSpreadsheetRequest, pendingExcelTemplateRequests,
  isExcelTemplateConfirmation, isExcelTemplateCancel, cleanupExpiredExcelTemplateRequests,
  createExcelTemplateConfirmation, executePendingExcelTemplate,
  createSpreadsheetFromRequest, SPREADSHEET_TEMPLATES, safeWorkbookName,
  // Chat helpers
  buildJarvisPrompt, handleGPTChat, generateAck, buildGPTSystemPrompt,
  updateProjectStatus, isPortuguese, translateTo, translateToEnglish, LANG_NAMES,
  // Patterns
  SCREEN_PATTERN, COMPUTER_USE_PATTERN, NEEDS_SCREENSHOT_PATTERN,
  // Rate limiter
  rateLimitedOpenAI,
  // Weather
  fetchWeather,
  // CLI health functions
  checkClaudeCli, checkClaudeCliAuth, findClaudeCli,
  // Cross-module mutable state
  coworkState, executorState, daemonRefs,
  // Populated by agents module after registration
  checkCodexHealth: null,
};

// Register modules — agents must come before server-online (exposes checkCodexHealth)
registerMetricsQuickModule(app, deps);
registerObsidianModule(app, deps);
registerMegaBrainModule(app, deps);
registerAgentsModule(app, deps);
registerServerOnlineModule(app, deps);
registerAiModelsModule(app, deps);
registerMenuModule(app, deps);
registerInterfaceModule(app, deps);

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
  try { if (deps.daemonRefs.screenStateDaemon) deps.daemonRefs.screenStateDaemon.kill(); } catch {}
  try { if (deps.daemonRefs.clipboardDaemon) deps.daemonRefs.clipboardDaemon.kill(); } catch {}
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
