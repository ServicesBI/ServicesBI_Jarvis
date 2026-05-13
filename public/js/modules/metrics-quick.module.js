// ═══ METRICS QUICK ACCESS MODULE ═══
// Setor 8: Métricas, Tasks, Uptime, Quick Access, Pet, Data/Hora

export function initMetricsQuickModule(deps) {

  // ── Stat Card Polling ──
  async function updateStats() {
    try {
      const res = await fetch('/api/stats');
      const data = await res.json();

      const h = Math.floor(data.uptime / 3600000);
      const m = Math.floor((data.uptime % 3600000) / 60000);
      const s = Math.floor((data.uptime % 60000) / 1000);
      const sessionEl = document.getElementById('stat-session');
      if (sessionEl) sessionEl.textContent = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;

      const tokensEl = document.getElementById('stat-tokens');
      if (tokensEl) tokensEl.textContent = data.tokens.toLocaleString();
      const planEl = document.getElementById('stat-plan');
      if (planEl) planEl.textContent = data.plan;
      const reqEl = document.getElementById('stat-requests');
      if (reqEl) reqEl.textContent = data.requests;

      const latEl = document.getElementById('stat-latency');
      if (latEl && data.lastLatency) {
        const ms = data.lastLatency;
        latEl.textContent = ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's';
        latEl.style.color = ms < 800 ? '#00ff88' : ms < 2000 ? '#ffd700' : '#ff4444';
      }

      const poolEl = document.getElementById('stat-pool');
      if (poolEl && data.pool) {
        const { opus = 0, sonnet = 0, haiku = 0 } = data.pool;
        poolEl.textContent = `O${opus} S${sonnet} H${haiku}`;
        poolEl.style.color = (opus + sonnet + haiku) > 4 ? '#00ff88' : '#ffd700';
      }
    } catch {}
  }

  // ── Clock ──
  function updateClock() {
    const el = document.getElementById('clock');
    if (el) el.textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
  }

  // ── HUD Metrics (Tasks / Uptime / Voice) ──
  let startTime = Date.now();
  let taskCount = parseInt(localStorage.getItem('jarvis-tasks-today') || '0');
  const lastTaskDate = localStorage.getItem('jarvis-last-task-date');
  const today = new Date().toDateString();
  if (lastTaskDate !== today) {
    taskCount = 0;
    localStorage.setItem('jarvis-tasks-today', '0');
    localStorage.setItem('jarvis-last-task-date', today);
  }

  function updateMetrics() {
    const tasksEl = document.getElementById('metric-tasks');
    const uptimeEl = document.getElementById('metric-uptime');
    const voiceEl = document.getElementById('metric-voice');

    if (tasksEl) tasksEl.textContent = taskCount;

    if (uptimeEl) {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const mh = Math.floor(elapsed / 3600);
      const mm = Math.floor((elapsed % 3600) / 60);
      uptimeEl.textContent = `${String(mh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
    }

    if (voiceEl) {
      const micBtn = document.getElementById('mic-btn');
      voiceEl.textContent = micBtn?.classList.contains('recording') ? 'REC' : 'MUTE';
    }
  }

  window.jarvisHUD = window.jarvisHUD || {};
  window.jarvisHUD.incrementTasks = () => {
    taskCount++;
    localStorage.setItem('jarvis-tasks-today', String(taskCount));
    updateMetrics();
  };

  // ── Quick Access Buttons (hud-qbtn) ──
  function initQuickAccess() {
    document.querySelectorAll('.hud-qbtn[data-quick-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetTab = btn.dataset.quickTab;
        const tabBtn = document.querySelector(`.tab-btn[data-tab="${targetTab}"]`);
        if (tabBtn) tabBtn.click();
      });
    });
  }

  // ── Desktop Pet Launcher ──
  function initPetLauncher() {
    const petBtn = document.getElementById('btn-launch-pet');
    let petActive = false;
    if (!petBtn) return;

    petBtn.addEventListener('click', async () => {
      petBtn.style.opacity = '0.5';
      try {
        const r = await fetch('/api/pet/launch', { method: 'POST' });
        const data = await r.json();
        if (data.ok) {
          petActive = data.action === 'opened';
          const span = petBtn.querySelector('span');
          if (span) span.textContent = petActive ? '✅ ON' : 'Pet';
          petBtn.style.borderColor = petActive ? 'rgba(0,255,100,0.5)' : 'rgba(255,215,0,0.3)';
        }
      } catch {
        const span = petBtn.querySelector('span');
        if (span) { span.textContent = '❌ Erro'; setTimeout(() => { span.textContent = 'Pet'; }, 2000); }
      }
      petBtn.style.opacity = '1';
    });
  }

  // ── Date/Time Widget ──
  function initDateTime() {
    const days = ['DOMINGO','SEGUNDA-FEIRA','TERÇA-FEIRA','QUARTA-FEIRA','QUINTA-FEIRA','SEXTA-FEIRA','SÁBADO'];
    function updateDateTime() {
      const now = new Date();
      const dayEl = document.getElementById('date-day');
      const timeEl = document.getElementById('date-time');
      const fullEl = document.getElementById('date-full');
      if (dayEl) dayEl.textContent = days[now.getDay()];
      if (timeEl) timeEl.textContent = now.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
      if (fullEl) {
        const d = String(now.getDate()).padStart(2,'0');
        const mo = String(now.getMonth()+1).padStart(2,'0');
        const y = String(now.getFullYear()).slice(-2);
        fullEl.textContent = `${d}/${mo}/${y}`;
      }
    }
    updateDateTime();
    setInterval(updateDateTime, 1000);
  }

  // ── Claude Activity Tracker ──
  function initActivityTracker() {
    const actEl = document.getElementById('metric-activity');
    if (!actEl) return;

    window.jarvisHUD.setActivity = function(text, isActive) {
      actEl.textContent = text || 'idle';
      if (isActive) actEl.classList.add('active');
      else actEl.classList.remove('active');
    };

    // Wrap addTerminalLine to detect activity
    const origAddTerminal = deps.addTerminalLine;
    if (typeof origAddTerminal === 'function') {
      deps.addTerminalLine = function(msg, cls) {
        origAddTerminal(msg, cls);
        if (!msg) return;
        const m = String(msg).toLowerCase();
        if (m.includes('[build-start]') || m.includes('creating') || m.includes('generating')) {
          window.jarvisHUD.setActivity('criando...', true);
        } else if (m.includes('[file]')) {
          const fname = msg.match(/\[file\]\s*(.+?)\s*\|/);
          window.jarvisHUD.setActivity(fname ? fname[1] : 'arquivo criado', true);
        } else if (m.includes('[system] done') || m.includes('concluido') || m.includes('pronto')) {
          window.jarvisHUD.setActivity('concluido', false);
          setTimeout(() => window.jarvisHUD.setActivity('idle', false), 5000);
        }
      };
      // Also wrap the global window.addTerminalLine if it exists
      if (window.addTerminalLine) {
        const origWin = window.addTerminalLine;
        window.addTerminalLine = function(msg, cls) {
          origWin(msg, cls);
          if (!msg) return;
          const m = String(msg).toLowerCase();
          if (m.includes('[build-start]') || m.includes('creating') || m.includes('generating')) {
            window.jarvisHUD.setActivity?.('criando...', true);
          } else if (m.includes('[file]')) {
            const fname = msg.match(/\[file\]\s*(.+?)\s*\|/);
            window.jarvisHUD.setActivity?.(fname ? fname[1] : 'arquivo criado', true);
          } else if (m.includes('[system] done') || m.includes('concluido') || m.includes('pronto')) {
            window.jarvisHUD.setActivity?.('concluido', false);
            setTimeout(() => window.jarvisHUD.setActivity?.('idle', false), 5000);
          }
        };
      }
    }
  }

  // ── Preflight Auto-Skip ──
  function initPreflightAutoSkip() {
    const overlay = document.getElementById('preflight-overlay');
    if (!overlay) return;

    setTimeout(() => {
      if (overlay.style.display !== 'none') {
        console.log('[JARVIS] Preflight timeout — fechando modal');
        overlay.style.display = 'none';
      }
    }, 5000);

    const okBtn = document.getElementById('preflight-ok');
    const retryBtn = document.getElementById('preflight-retry');
    if (okBtn) okBtn.addEventListener('click', () => { overlay.style.display = 'none'; });
    if (retryBtn) retryBtn.addEventListener('click', () => { location.reload(); });
  }

  // ── Init ──
  updateClock();
  setInterval(updateClock, 1000);
  updateStats();
  setInterval(updateStats, 4000);
  updateMetrics();
  setInterval(updateMetrics, 1000);

  initQuickAccess();
  initPetLauncher();
  initDateTime();
  initActivityTracker();
  initPreflightAutoSkip();
}
