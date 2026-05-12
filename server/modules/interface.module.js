import { spawn, spawnSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';

let screenStateDaemon = null;
let _screenState = { value: null, ts: 0 };
let _screenStateRestarts = 0;
const MAX_DAEMON_RESTARTS = 10;

let clipboardDaemon = null;
let _lastClipboard = null;
let _clipboardRestarts = 0;

let coworkActive = false;
let coworkInterval = null;
let coworkLastState = '';

let petProcess = null;
let petRunning = false;
let petMicActive = false;

function startScreenStateDaemon(JARVIS_DIR, PYTHON_CMD) {
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
        _screenStateRestarts = 0;
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
    const delay = Math.min(5000 * Math.pow(1.5, _screenStateRestarts - 1), 30000);
    setTimeout(() => startScreenStateDaemon(JARVIS_DIR, PYTHON_CMD), delay);
  });
  console.log('[JARVIS] Screen state daemon started');
}

function startClipboardDaemon(JARVIS_DIR, PYTHON_CMD) {
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
        _clipboardRestarts = 0;
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
    setTimeout(() => startClipboardDaemon(JARVIS_DIR, PYTHON_CMD), delay);
  });
  console.log('[JARVIS] Clipboard intelligence daemon started');
}

export function registerInterfaceModule(app, deps) {
  const {
    JARVIS_DIR, PYTHON_CMD, CLAUDE_CMD, PORT,
    pushNotification, notifyBuildComplete,
    daemonRefs, coworkState
  } = deps;

  // Start daemons on boot (delayed to not block startup)
  setTimeout(() => startScreenStateDaemon(JARVIS_DIR, PYTHON_CMD), 3000);
  setTimeout(() => startClipboardDaemon(JARVIS_DIR, PYTHON_CMD), 4000);

  // Expose daemon refs for gracefulShutdown
  Object.defineProperty(daemonRefs, 'screenStateDaemon', { get: () => screenStateDaemon, configurable: true });
  Object.defineProperty(daemonRefs, 'clipboardDaemon', { get: () => clipboardDaemon, configurable: true });

  // GET /api/screen-state — Current desktop state (instant, no screenshot)
  app.get('/api/screen-state', (req, res) => {
    if (_screenState.value && (Date.now() - _screenState.ts < 5000)) {
      res.json(_screenState.value);
    } else {
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

  // GET /api/clipboard — Last clipboard analysis
  app.get('/api/clipboard', (req, res) => {
    res.json(_lastClipboard || { clipboard: null, analysis: null });
  });

  // POST /api/computer-use/v2 — JARVIS Computer Use v3: Vision-First + Observe-Act Loop
  app.post('/api/computer-use/v2', (req, res) => {
    (async () => {
      const { task, language = 'BR' } = req.body;
      if (!task) return res.status(400).json({ error: 'task required' });
      const t0 = Date.now();

      try {
        const state = _screenState.value || {};
        const stateText = state.fg
          ? `Foreground: "${state.fg.title}" (${state.fg.proc})\nOpen windows: ${(state.windows || []).map(w => w.title).filter(t => t && t !== 'Program Manager').join(', ')}\nMonitors: ${(state.monitors || []).length}\nCursor: (${state.cursor?.[0]}, ${state.cursor?.[1]})`
          : 'Screen state unavailable';

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

        let screenshotData = null;
        try {
          const ssScript = path.join(JARVIS_DIR, 'system', 'screenshot.py');
          const ssResult = spawnSync(PYTHON_CMD, [ssScript, '1'], {
            encoding: 'utf-8', timeout: 8000, maxBuffer: 30 * 1024 * 1024
          });
          if (ssResult.stdout) {
            const ssJson = JSON.parse(ssResult.stdout.trim());
            screenshotData = ssJson.data;
          }
        } catch {}

        console.log(`[JARVIS CU v3] State: ${stateText.split('\n')[0]} | UI elements: ${uiElements ? 'YES' : 'NO'} | Screenshot: ${screenshotData ? 'YES' : 'NO'}`);

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

        const smartActions = [];
        for (let i = 0; i < plan.actions.length; i++) {
          const action = plan.actions[i];
          smartActions.push(action);
          if (action.type === 'shell' && /^start\s/i.test(action.command || '')) {
            const next = plan.actions[i + 1];
            if (!next || (next.type !== 'wait' && next.type !== 'wait_for')) {
              smartActions.push({ type: 'wait', ms: 2000 });
            }
          }
        }
        plan.actions = smartActions;

        console.log(`[JARVIS CU v3] Plan: ${plan.actions.length} actions | Expected: ${plan.expected || 'N/A'}`);

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

        let replanAttempts = 0;
        let finalResult = execResult;

        if (failed.length > 0 && failed.length <= Math.ceil(totalActions / 2)) {
          console.log(`[JARVIS CU v3] ${failed.length}/${totalActions} failed. Starting replan...`);

          while (replanAttempts < 2 && failed.length > 0) {
            replanAttempts++;

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
                  if (newFailed.length === 0) break;
                }
              }
            } catch (replanErr) {
              console.error(`[JARVIS CU v3] Replan ${replanAttempts} failed:`, replanErr.message);
              break;
            }
          }
        }

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
    })();
  });

  // POST /api/browser-control — CDP browser automation
  app.post('/api/browser-control', (req, res) => {
    (async () => {
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
    })();
  });

  // POST /api/workflow — Workflow Recording & Replay
  app.post('/api/workflow', (req, res) => {
    (async () => {
      try {
        const { action, name, speed } = req.body;
        const script = path.join(JARVIS_DIR, 'system', 'workflow-recorder.py');

        if (action === 'list') {
          const result = execSync(`"${PYTHON_CMD}" "${script}" list`, { encoding: 'utf-8', timeout: 5000 });
          return res.json(JSON.parse(result.trim()));
        }

        if (action === 'replay' && name) {
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
    })();
  });

  // COWORK MODE — JARVIS observa e ajuda em paralelo
  app.post('/api/cowork/start', (req, res) => {
    if (coworkActive) return res.json({ ok: true, status: 'already running' });
    coworkActive = true;
    coworkState.active = true;

    coworkInterval = setInterval(async () => {
      if (!coworkActive || !_screenState.value) return;

      const state = _screenState.value;
      const fg = state.fg;
      if (!fg || !fg.title) return;

      const currentContext = fg.title + '|' + fg.proc;
      if (currentContext === coworkLastState) return;
      coworkLastState = currentContext;

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
              if (result.context) {
                coworkState.screenContext = result.context;
              }
              if (result.action === 'suggest' && result.message) {
                pushNotification({ type: 'cowork-suggest', message: result.message });
                console.log(`[JARVIS Cowork] 💡 ${result.message}`);
              }
            }
          } catch {}
        });
      } catch {}
    }, 10000);

    console.log('[JARVIS] Cowork mode ACTIVATED');
    res.json({ ok: true, status: 'started' });
  });

  app.post('/api/cowork/stop', (req, res) => {
    coworkActive = false;
    coworkState.active = false;
    coworkState.screenContext = '';
    if (coworkInterval) { clearInterval(coworkInterval); coworkInterval = null; }
    coworkLastState = '';
    console.log('[JARVIS] Cowork mode DEACTIVATED');
    res.json({ ok: true, status: 'stopped' });
  });

  app.get('/api/cowork/status', (req, res) => {
    res.json({ active: coworkActive });
  });

  // DESKTOP PET LAUNCHER
  app.post('/api/pet/launch', (req, res) => {
    if (petRunning && petProcess) {
      try {
        process.kill(petProcess.pid);
      } catch(e) {}
      petProcess = null;
      petRunning = false;
      return res.json({ ok: true, action: 'closed', message: 'Desktop Pet fechado.' });
    }

    const petDir = path.join(JARVIS_DIR, 'pet');
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

  app.post('/api/pet/mic-state', (req, res) => {
    petMicActive = req.body.active || false;
    pushNotification({ type: 'pet-mic', active: petMicActive });
    console.log(`[JARVIS Pet] Mic ${petMicActive ? 'ON — Cowork + Voice active' : 'OFF'}`);
    res.json({ ok: true, active: petMicActive });
  });

  app.get('/api/pet/mic-state', (req, res) => {
    res.json({ active: petMicActive });
  });

  // GET /api/screenshot - Capture screen directly via Python
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
    if (!deps.claudeCliAvailable) return res.status(503).json({ error: 'Claude CLI not available' });

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
}
