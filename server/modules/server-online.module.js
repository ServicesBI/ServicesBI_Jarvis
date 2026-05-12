import { spawn, spawnSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export function registerServerOnlineModule(app, deps) {
  const {
    JARVIS_DIR, PORT, PYTHON_CMD,
    openai, CLAUDE_CMD,
    pools, findChrome, findClaudeCli, checkClaudeCli, checkClaudeCliAuth,
    executorState
  } = deps;

  // GET /api/health - Full system health check
  app.get('/api/health', (req, res) => {
    const chrome = findChrome();
    const health = {
      status: deps.claudeCliAvailable && openai ? 'operational' : 'degraded',
      components: {
        server: { status: 'ok' },
        openai: {
          status: openai ? 'ok' : 'error',
          error: openai ? null : 'OPENAI_API_KEY not configured in .env — voice/TTS will not work'
        },
        claude: {
          status: deps.claudeCliChecking ? 'checking' : (deps.claudeCliAvailable ? 'ok' : 'error'),
          error: deps.claudeCliAvailable ? null : deps.claudeCliError
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
        task_execution: deps.claudeCliAvailable,
        pdf_generation: true,
        screen_analysis: deps.claudeCliAvailable,
        excel_live: fs.existsSync(PYTHON_CMD),
        meta_ads: false
      }
    };
    res.json(health);
  });

  // GET /api/providers/health - Provider-level health without changing execution routing
  app.get('/api/providers/health', (req, res) => {
    const codex = deps.checkCodexHealth ? deps.checkCodexHealth() : { status: 'unknown', detail: 'Not loaded' };
    const claudeStatus = deps.claudeCliChecking ? 'checking' : (deps.claudeCliAvailable ? 'ok' : 'error');
    const VALID_EXECUTOR_MODES = executorState ? executorState.VALID_EXECUTOR_MODES : ['auto', 'claude', 'codex', 'openai'];
    const currentExecutorMode = executorState ? executorState.currentExecutorMode : 'auto';
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
        detail: deps.claudeCliChecking
          ? 'Claude CLI em verificacao'
          : (deps.claudeCliAvailable ? 'Claude CLI disponivel' : (deps.claudeCliError || 'Claude CLI indisponivel')),
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

  // POST /api/health/recheck - Re-run Claude CLI health check
  app.post('/api/health/recheck', (req, res) => {
    console.log('[JARVIS] Re-checking Claude CLI health...');
    const available = checkClaudeCli();
    deps.claudeCliAvailable = available;
    if (available) {
      pools.opus.spawnErrors = 0;
      pools.sonnet.spawnErrors = 0;
      pools.haiku.spawnErrors = 0;
      pools.opus.fill();
      pools.sonnet.fill();
      pools.haiku.fill();
    }
    res.json({
      claudeAvailable: deps.claudeCliAvailable,
      error: deps.claudeCliAvailable ? null : deps.claudeCliError
    });
  });

  // POST /api/health/preflight - Deep verification
  app.post('/api/health/preflight', async (req, res) => {
    console.log('[JARVIS] Running pre-flight verification...');
    const results = {
      openai_api: { status: 'pending', detail: '' },
      openai_realtime: { status: 'pending', detail: '' },
      openai_tts: { status: 'pending', detail: '' },
      claude_cli: { status: 'pending', detail: '' },
      claude_execute: { status: 'pending', detail: '' },
    };

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

    const foundClaudePath = findClaudeCli();
    const cliFound = !!foundClaudePath;
    const claudeCmd = foundClaudePath || 'claude';

    if (!cliFound) {
      results.claude_cli = { status: 'error', detail: 'Claude CLI not found. Install: npm install -g @anthropic-ai/claude-code' };
      results.claude_execute = { status: 'error', detail: 'Requires Claude CLI' };
    } else {
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
            if (!deps.claudeCliAvailable) {
              deps.claudeCliAvailable = true;
              deps.claudeCliError = '';
              deps.claudeCliChecking = false;
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

    if (!deps.claudeCliAvailable) {
      return res.status(503).json({ error: 'Claude CLI not available — cannot auto-fix without it' });
    }

    console.log('[JARVIS] Auto-fix requested for:', issues.map(i => i.key).join(', '));

    const diagLines = issues.map(i => `- ${i.key}: ${i.detail}`).join('\n');

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

  // POST /api/jarvis/shutdown
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
}
