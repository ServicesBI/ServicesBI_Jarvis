// ═══ SERVER ONLINE MODULE ═══
// Setor 3: Status do servidor, saúde dos providers, sistema, clima

export function initServerOnlineModule(deps) {

  // ── Weather Widget ──
  async function loadWeather() {
    try {
      let city = 'Presidente Prudente';
      try {
        const pos = await new Promise((resolve, reject) => {
          if (!navigator.geolocation) reject('no geo');
          navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 5000, maximumAge: 300000 });
        });
        const lat = pos.coords.latitude, lon = pos.coords.longitude;
        const geoR = await fetch(`https://wttr.in/${lat},${lon}?format=j1`);
        if (geoR.ok) {
          const geoD = await geoR.json();
          const area = geoD.nearest_area?.[0];
          if (area) city = area.areaName?.[0]?.value || area.region?.[0]?.value || city;
        }
      } catch {
        try {
          const geoRes = await fetch('https://ipapi.co/json/');
          if (geoRes.ok) { const geo = await geoRes.json(); if (geo.city) city = geo.city; }
        } catch {
          try {
            const geoRes2 = await fetch('https://ip-api.com/json/?fields=city');
            if (geoRes2.ok) { const geo2 = await geoRes2.json(); if (geo2.city) city = geo2.city; }
          } catch {}
        }
      }

      let data = null;
      try {
        const r = await fetch(`/api/weather?city=${encodeURIComponent(city)}`);
        if (r.ok) data = await r.json();
      } catch {}

      if (!data) {
        const r2 = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`);
        if (r2.ok) {
          const w = await r2.json();
          const cur = w.current_condition[0];
          data = { city, temp: cur.temp_C, desc: cur.lang_pt?.[0]?.value || cur.weatherDesc[0].value };
        }
      }

      if (data) {
        const wCity = document.getElementById('weather-city');
        const wTemp = document.getElementById('weather-temp');
        const wDesc = document.getElementById('weather-desc');
        if (wCity) wCity.textContent = data.city.toUpperCase();
        if (wTemp) wTemp.textContent = `${data.temp}°C`;
        if (wDesc) wDesc.textContent = data.desc;
      }
    } catch {
      const wCity = document.getElementById('weather-city');
      const wTemp = document.getElementById('weather-temp');
      const wDesc = document.getElementById('weather-desc');
      if (wCity) wCity.textContent = 'OFFLINE';
      if (wTemp) wTemp.textContent = '--°C';
      if (wDesc) wDesc.textContent = 'sem conexao';
    }
  }

  // ── Executor Select + Health Bars ──
  let selectedExecutor = 'auto';
  let executorSelectReady = false;

  function normalizeHudExecutor(mode) {
    return ['auto', 'claude', 'codex'].includes(mode) ? mode : 'auto';
  }

  function getExecutorSelect() {
    return document.getElementById('executor-select');
  }

  function formatProviderStatus(provider) {
    const status = provider?.status || 'unknown';
    if (status === 'ok') return { text: 'OK', ok: true };
    if (status === 'not_installed') return { text: 'OFF', ok: false };
    if (status === 'auth') return { text: 'AUTH', ok: false };
    if (status === 'checking') return { text: 'CHECK', ok: false };
    return { text: 'ERROR', ok: false };
  }

  function getAutoExecutorStatus(providers) {
    if (providers?.claude?.status === 'ok') return { status: 'ok' };
    if (providers?.codex?.status === 'ok') return { status: 'ok' };
    return { status: 'error' };
  }

  function setExecutorHudStatus(providerStatus) {
    const barClaude = document.getElementById('bar-claude');
    const sClaude = document.getElementById('bar-claude-status');
    const dotClaude = document.getElementById('dot-claude');
    const formatted = formatProviderStatus(providerStatus);
    if (barClaude) barClaude.className = formatted.ok ? 'bar-fill ok' : 'bar-fill err';
    if (dotClaude) dotClaude.className = formatted.ok ? 'server-dot' : 'server-dot err';
    if (sClaude) { sClaude.textContent = formatted.text; sClaude.style.color = formatted.ok ? 'var(--green, #00ff88)' : '#ff4455'; }
  }

  async function initExecutorSelect() {
    const select = getExecutorSelect();
    if (!select || executorSelectReady) return;
    executorSelectReady = true;

    try {
      const r = await fetch('/api/executor/mode', { cache: 'no-store' });
      if (r.ok) { const data = await r.json(); selectedExecutor = normalizeHudExecutor(data.mode); select.value = selectedExecutor; }
    } catch {
      selectedExecutor = normalizeHudExecutor(select.value);
    }
    updateHealth();

    select.addEventListener('change', async () => {
      const mode = normalizeHudExecutor(select.value);
      selectedExecutor = mode;
      try {
        const r = await fetch('/api/executor/mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
        if (!r.ok) throw new Error('executor mode update failed');
      } catch { setExecutorHudStatus({ status: 'error' }); return; }
      updateHealth();
    });
  }

  async function updateHealth() {
    const barApi = document.getElementById('bar-api');
    const barVoice = document.getElementById('bar-voice');
    const sApi = document.getElementById('bar-api-status');
    const sVoice = document.getElementById('bar-voice-status');
    const activeExecutor = normalizeHudExecutor(getExecutorSelect()?.value || selectedExecutor);
    selectedExecutor = activeExecutor;

    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 8000);
      const [r, providersRes] = await Promise.all([
        fetch('/api/health', { signal: ctrl.signal, cache: 'no-store' }),
        fetch('/api/providers/health', { signal: ctrl.signal, cache: 'no-store' }).catch(() => null)
      ]).finally(() => clearTimeout(tid));

      if (r.ok) {
        const data = await r.json();
        const providers = providersRes?.ok ? await providersRes.json() : null;
        if (barApi) barApi.className = 'bar-fill ok';
        if (sApi) { sApi.textContent = 'OK'; sApi.style.color = 'var(--green, #00ff88)'; }
        if (data.capabilities?.voice_realtime) {
          if (barVoice) barVoice.className = 'bar-fill ok';
          if (sVoice) { sVoice.textContent = 'OK'; sVoice.style.color = 'var(--green, #00ff88)'; }
        } else {
          if (barVoice) barVoice.className = 'bar-fill err';
          if (sVoice) { sVoice.textContent = 'OFF'; sVoice.style.color = '#ff4455'; }
        }
        if (providers) setExecutorHudStatus(activeExecutor === 'auto' ? getAutoExecutorStatus(providers) : providers[activeExecutor]);
        else setExecutorHudStatus({ status: data.capabilities?.task_execution ? 'ok' : 'error' });
        return;
      }
    } catch {}

    if (barApi) barApi.className = 'bar-fill err';
    if (barVoice) barVoice.className = 'bar-fill err';
    if (sApi) { sApi.textContent = 'ERR'; sApi.style.color = '#ff4455'; }
    if (sVoice) { sVoice.textContent = 'ERR'; sVoice.style.color = '#ff4455'; }
    setExecutorHudStatus({ status: 'error' });
  }

  // ── Active Model Display (HUD) ──
  function updateModel(model, status) {
    const modelEl = document.getElementById('active-model');
    const statusEl = document.getElementById('model-status');
    if (!modelEl) return;
    const modelMap = {
      'claude-opus-4-6': 'Opus 4.6', 'claude-sonnet-4-6': 'Sonnet 4.6', 'claude-haiku-4-5': 'Haiku 4.5',
      'opus': 'Opus 4.6', 'sonnet': 'Sonnet 4.6', 'haiku': 'Haiku 4.5',
    };
    modelEl.textContent = modelMap[model] || model || 'Sonnet 4.6';
    if (statusEl) statusEl.textContent = status || 'standby';
  }

  window.addEventListener('jarvis-log', (e) => {
    const msg = e.detail || '';
    if (msg.includes('opus')) updateModel('opus', 'executing');
    else if (msg.includes('sonnet')) updateModel('sonnet', 'executing');
    else if (msg.includes('haiku')) updateModel('haiku', 'executing');
  });

  // ── System Stats (CPU/GPU/RAM) ──
  async function updateSystemStats() {
    try {
      const r = await fetch('/api/system-stats', { signal: AbortSignal.timeout(5000) });
      if (!r.ok) return;
      const s = await r.json();

      const cpuTempEl = document.getElementById('cpu-temp');
      const cpuUsageEl = document.getElementById('cpu-usage');
      const cpuCoresEl = document.getElementById('cpu-cores');
      const cpuLabel = document.querySelector('#widget-cpu .widget-label');
      if (cpuLabel && s.cpu?.name) { const n = s.cpu.name.replace(/\(R\)|\(TM\)|CPU|Processor|@.*$/gi, '').trim(); cpuLabel.textContent = n.length > 25 ? n.substring(0,25) : n; }
      if (cpuTempEl) { if (s.cpu?.temp != null) { cpuTempEl.textContent = `${s.cpu.temp}°C`; cpuTempEl.style.color = s.cpu.temp > 80 ? '#ff4455' : s.cpu.temp > 65 ? '#ffaa00' : 'var(--cyan)'; } else cpuTempEl.textContent = '—'; }
      if (cpuUsageEl) cpuUsageEl.textContent = s.cpu?.usage != null ? `${s.cpu.usage}%` : '--%';
      if (cpuCoresEl) cpuCoresEl.textContent = `${s.cpu?.cores || '--'} cores`;

      const gpuTempEl = document.getElementById('gpu-temp');
      const gpuStatusEl = document.getElementById('gpu-status');
      const gpuLabel = document.querySelector('#widget-gpu .widget-label');
      if (gpuLabel && s.gpu?.name) gpuLabel.textContent = s.gpu.name;
      if (gpuTempEl) { if (s.gpu?.temp != null) { gpuTempEl.textContent = `${s.gpu.temp}°C`; gpuTempEl.style.color = s.gpu.temp > 80 ? '#ff4455' : s.gpu.temp > 65 ? '#ffaa00' : 'var(--cyan)'; } else gpuTempEl.textContent = '—'; }
      if (gpuStatusEl) { let gpuInfo = []; if (s.gpu?.vram) gpuInfo.push(s.gpu.vram+'GB'); if (s.gpu?.usage != null) gpuInfo.push(s.gpu.usage+'%'); gpuStatusEl.textContent = gpuInfo.length ? gpuInfo.join(' · ') : (s.gpu?.name ? 'dedicada' : 'N/A'); }

      const ramVal = document.getElementById('ram-value');
      const ramDetail = document.getElementById('ram-detail');
      if (ramVal && s.ram) ramVal.textContent = `${s.ram.usage}%`;
      if (ramDetail && s.ram) ramDetail.textContent = `${s.ram.total}GB ${s.ram.type || ''}`.trim();

      const serverLabel = document.querySelector('#widget-health .widget-label');
      if (serverLabel) serverLabel.textContent = 'SERVER · ONLINE';

      document.querySelectorAll('#widget-cpu .gauge-ring').forEach(g => { if (s.cpu?.usage != null) g.style.setProperty('--value', s.cpu.usage); });
      const cpuGaugeVal = document.querySelector('#widget-cpu .gauge-value, #widget-cpu .gauge-pct');
      if (cpuGaugeVal && s.cpu?.usage != null) cpuGaugeVal.textContent = s.cpu.usage + '%';

      document.querySelectorAll('#widget-gpu .gauge-ring').forEach(g => { g.style.setProperty('--value', s.gpu?.vram ? Math.min(100, Math.round(s.gpu.vram/16*100)) : 0); });
      const gpuGaugeVal = document.querySelector('#widget-gpu .gauge-value, #widget-gpu .gauge-pct');
      if (gpuGaugeVal) gpuGaugeVal.textContent = s.gpu?.vram ? s.gpu.vram+'GB' : '--';

      document.querySelectorAll('#widget-ram .gauge-ring, .widget-ram .gauge-ring').forEach(g => { if (s.ram?.usage != null) g.style.setProperty('--value', s.ram.usage); });
      const ramGaugeVal = document.querySelector('#widget-ram .gauge-value, #widget-ram .gauge-pct, .widget-ram .gauge-value');
      if (ramGaugeVal && s.ram?.usage != null) ramGaugeVal.textContent = s.ram.usage + '%';

      document.querySelectorAll('[data-metric="cpu"]').forEach(g => { if (s.cpu?.usage != null) g.style.setProperty('--value', s.cpu.usage); });
      document.querySelectorAll('[data-metric="ram"]').forEach(g => { if (s.ram?.usage != null) g.style.setProperty('--value', s.ram.usage); });

      const uptimeEl = document.querySelector('.sys-uptime-value, #sys-uptime');
      if (uptimeEl) uptimeEl.textContent = new Date().toLocaleTimeString('pt-BR');
    } catch {}
  }

  // ── Init ──
  loadWeather();
  initExecutorSelect();
  updateHealth();
  updateSystemStats();

  setInterval(loadWeather, 15 * 60 * 1000);
  setInterval(updateHealth, 10 * 1000);
  setInterval(updateSystemStats, 5 * 1000);

  // Expose for other modules
  deps.modules.updateHealth = updateHealth;
  deps.modules.updateModel = updateModel;
}
