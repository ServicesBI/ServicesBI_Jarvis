// Lightweight HUD stat-card polling.
(function() {
  let startTime = Date.now();
  let taskCount = parseInt(localStorage.getItem('jarvis-tasks-today') || '0');
  const lastTaskDate = localStorage.getItem('jarvis-last-task-date');
  const today = new Date().toDateString();
  if (lastTaskDate !== today) {
    taskCount = 0;
    localStorage.setItem('jarvis-tasks-today', '0');
    localStorage.setItem('jarvis-last-task-date', today);
  }

  async function updateStats() {
    try {
      const res = await fetch('/api/stats');
      const data = await res.json();

      const h = Math.floor(data.uptime / 3600000);
      const m = Math.floor((data.uptime % 3600000) / 60000);
      const s = Math.floor((data.uptime % 60000) / 1000);
      const sessionEl = document.getElementById('stat-session');
      if (sessionEl) sessionEl.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

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

  function updateMetrics() {
    const tasksEl = document.getElementById('metric-tasks');
    const uptimeEl = document.getElementById('metric-uptime');
    const voiceEl = document.getElementById('metric-voice');

    if (tasksEl) tasksEl.textContent = taskCount;

    if (uptimeEl) {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const h = Math.floor(elapsed / 3600);
      const m = Math.floor((elapsed % 3600) / 60);
      uptimeEl.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    if (voiceEl) {
      const micBtn = document.getElementById('mic-btn');
      voiceEl.textContent = micBtn?.classList.contains('recording') ? 'REC' : 'MUTE';
    }
  }

  async function updateSystemStats() {
    try {
      const r = await fetch('/api/system-stats', { signal: AbortSignal.timeout(5000) });
      if (!r.ok) return;
      const s = await r.json();

      const cpuTempEl = document.getElementById('cpu-temp');
      const cpuUsageEl = document.getElementById('cpu-usage');
      const cpuCoresEl = document.getElementById('cpu-cores');
      const cpuLabel = document.querySelector('#widget-cpu .widget-label');

      if (cpuLabel && s.cpu?.name) {
        const shortName = s.cpu.name.replace(/\(R\)|\(TM\)|CPU|Processor|@.*$/gi, '').trim();
        cpuLabel.textContent = shortName.length > 25 ? shortName.substring(0, 25) : shortName;
      }
      if (cpuTempEl) {
        if (s.cpu?.temp !== null && s.cpu?.temp !== undefined) {
          cpuTempEl.textContent = `${s.cpu.temp}°C`;
          cpuTempEl.style.color = s.cpu.temp > 80 ? '#ff4455' : s.cpu.temp > 65 ? '#ffaa00' : 'var(--cyan)';
        } else {
          cpuTempEl.textContent = '--';
        }
      }
      if (cpuUsageEl) cpuUsageEl.textContent = s.cpu?.usage !== null ? `${s.cpu.usage}%` : '--%';
      if (cpuCoresEl) cpuCoresEl.textContent = `${s.cpu?.cores || '--'} cores`;

      const gpuTempEl = document.getElementById('gpu-temp');
      const gpuStatusEl = document.getElementById('gpu-status');
      const gpuLabel = document.querySelector('#widget-gpu .widget-label');

      if (gpuLabel && s.gpu?.name) gpuLabel.textContent = s.gpu.name;
      if (gpuTempEl) {
        if (s.gpu?.temp !== null && s.gpu?.temp !== undefined) {
          gpuTempEl.textContent = `${s.gpu.temp}°C`;
          gpuTempEl.style.color = s.gpu.temp > 80 ? '#ff4455' : s.gpu.temp > 65 ? '#ffaa00' : 'var(--cyan)';
        } else {
          gpuTempEl.textContent = '--';
        }
      }
      if (gpuStatusEl) {
        const gpuInfo = [];
        if (s.gpu?.vram) gpuInfo.push(s.gpu.vram + 'GB');
        if (s.gpu?.usage !== null && s.gpu?.usage !== undefined) gpuInfo.push(s.gpu.usage + '%');
        gpuStatusEl.textContent = gpuInfo.length ? gpuInfo.join(' · ') : (s.gpu?.name ? 'dedicada' : 'N/A');
      }

      const ramVal = document.getElementById('ram-value');
      const ramDetail = document.getElementById('ram-detail');
      if (ramVal && s.ram) ramVal.textContent = `${s.ram.usage}%`;
      if (ramDetail && s.ram) {
        const ramType = s.ram.type || '';
        ramDetail.textContent = `${s.ram.total}GB ${ramType}`.trim();
      }

      const serverLabel = document.querySelector('#widget-health .widget-label');
      if (serverLabel) serverLabel.textContent = 'SERVER · ONLINE';

      const cpuGauge = document.querySelector('#widget-cpu .gauge-ring, #widget-cpu [style*="--value"]');
      if (cpuGauge && s.cpu?.usage !== null) cpuGauge.style.setProperty('--value', s.cpu.usage);
      document.querySelectorAll('#widget-cpu .gauge-ring').forEach(g => {
        if (s.cpu?.usage !== null) g.style.setProperty('--value', s.cpu.usage);
      });
      const cpuGaugeVal = document.querySelector('#widget-cpu .gauge-value, #widget-cpu .gauge-pct');
      if (cpuGaugeVal && s.cpu?.usage !== null) cpuGaugeVal.textContent = s.cpu.usage + '%';

      document.querySelectorAll('#widget-gpu .gauge-ring').forEach(g => {
        g.style.setProperty('--value', s.gpu?.vram ? Math.min(100, Math.round(s.gpu.vram / 16 * 100)) : 0);
      });
      const gpuGaugeVal = document.querySelector('#widget-gpu .gauge-value, #widget-gpu .gauge-pct');
      if (gpuGaugeVal) gpuGaugeVal.textContent = s.gpu?.vram ? s.gpu.vram + 'GB' : '--';

      document.querySelectorAll('#widget-ram .gauge-ring, .widget-ram .gauge-ring').forEach(g => {
        if (s.ram?.usage !== null) g.style.setProperty('--value', s.ram.usage);
      });
      const ramGaugeVal = document.querySelector('#widget-ram .gauge-value, #widget-ram .gauge-pct, .widget-ram .gauge-value');
      if (ramGaugeVal && s.ram?.usage !== null) ramGaugeVal.textContent = s.ram.usage + '%';

      document.querySelectorAll('[data-metric="cpu"]').forEach(g => {
        if (s.cpu?.usage !== null) g.style.setProperty('--value', s.cpu.usage);
      });
      document.querySelectorAll('[data-metric="ram"]').forEach(g => {
        if (s.ram?.usage !== null) g.style.setProperty('--value', s.ram.usage);
      });

      const uptimeEl = document.querySelector('.sys-uptime-value, #sys-uptime');
      if (uptimeEl) uptimeEl.textContent = new Date().toLocaleTimeString('pt-BR');
    } catch {}
  }

  function incrementTasks() {
    taskCount++;
    localStorage.setItem('jarvis-tasks-today', String(taskCount));
    updateMetrics();
  }

  function init() {
    updateStats();
    updateMetrics();
    updateSystemStats();
    setInterval(updateStats, 4000);
    setInterval(updateMetrics, 1000);
    setInterval(updateSystemStats, 5000);
  }

  window.jarvisHUD = window.jarvisHUD || {};
  window.jarvisHUD.incrementTasks = incrementTasks;
  window.JarvisHudStatus = { init, updateStats, updateMetrics, updateSystemStats, incrementTasks };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
