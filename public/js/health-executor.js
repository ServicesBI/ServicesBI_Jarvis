(function() {
  const EXECUTOR_MODES = ['auto', 'claude', 'codex'];
  let selectedExecutor = 'auto';
  let executorSelectReady = false;
  let healthIntervalId = null;

  function normalizeExecutorMode(mode) {
    return EXECUTOR_MODES.includes(mode) ? mode : 'auto';
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
    if (status === 'error' || status === 'limit' || status === 'off') return { text: 'ERROR', ok: false };
    return { text: 'UNKNOWN', ok: false };
  }

  function getAutoExecutorStatus(providers) {
    if (providers?.claude?.status === 'ok') return { status: 'ok' };
    if (providers?.codex?.status === 'ok') return { status: 'ok' };
    return { status: 'error' };
  }

  function setCompactExecutorStatus(formatted, isOffline) {
    const dot = document.getElementById('exec-dot');
    const stat = document.getElementById('exec-status');
    const ok = !isOffline && (formatted.compactOk ?? formatted.ok);

    if (dot) {
      dot.style.background = ok ? '#19ff82' : '#ff5d6c';
      dot.style.boxShadow = ok ? '0 0 8px rgba(25,255,130,.9)' : '0 0 8px rgba(255,93,108,.9)';
    }
    if (stat) stat.textContent = isOffline ? 'ERR' : (ok ? 'OK' : 'OFF');
  }

  function setExecutorHudStatus(providerStatus, options) {
    const barClaude = document.getElementById('bar-claude');
    const sClaude = document.getElementById('bar-claude-status');
    const dotClaude = document.getElementById('dot-claude');
    const formatted = formatProviderStatus(providerStatus);
    if (typeof options?.compactOk === 'boolean') formatted.compactOk = options.compactOk;

    if (barClaude) barClaude.className = formatted.ok ? 'bar-fill ok' : 'bar-fill err';
    if (dotClaude) dotClaude.className = formatted.ok ? 'server-dot' : 'server-dot err';
    if (sClaude) {
      sClaude.textContent = formatted.text;
      sClaude.style.color = formatted.ok ? 'var(--green, #00ff88)' : '#ff4455';
    }
    setCompactExecutorStatus(formatted, options?.offline);
  }

  async function updateHealth() {
    const barApi = document.getElementById('bar-api');
    const barVoice = document.getElementById('bar-voice');
    const sApi = document.getElementById('bar-api-status');
    const sVoice = document.getElementById('bar-voice-status');
    const activeExecutor = normalizeExecutorMode(getExecutorSelect()?.value || selectedExecutor);
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
        if (sApi) {
          sApi.textContent = 'OK';
          sApi.style.color = 'var(--green, #00ff88)';
        }

        if (data.capabilities?.voice_realtime) {
          if (barVoice) barVoice.className = 'bar-fill ok';
          if (sVoice) {
            sVoice.textContent = 'OK';
            sVoice.style.color = 'var(--green, #00ff88)';
          }
        } else {
          if (barVoice) barVoice.className = 'bar-fill err';
          if (sVoice) {
            sVoice.textContent = 'OFF';
            sVoice.style.color = '#ff4455';
          }
        }

        if (providers) {
          setExecutorHudStatus(
            activeExecutor === 'auto' ? getAutoExecutorStatus(providers) : providers[activeExecutor],
            { compactOk: activeExecutor === 'auto' }
          );
        } else {
          setExecutorHudStatus({ status: data.capabilities?.task_execution ? 'ok' : 'error' });
        }
        return;
      }
    } catch {}

    if (barApi) barApi.className = 'bar-fill err';
    if (barVoice) barVoice.className = 'bar-fill err';
    if (sApi) {
      sApi.textContent = 'ERR';
      sApi.style.color = '#ff4455';
    }
    if (sVoice) {
      sVoice.textContent = 'ERR';
      sVoice.style.color = '#ff4455';
    }
    setExecutorHudStatus({ status: 'error' }, { offline: true });
  }

  async function initExecutorSelect() {
    const select = getExecutorSelect();
    if (!select || executorSelectReady) return;
    executorSelectReady = true;

    try {
      const r = await fetch('/api/executor/mode', { cache: 'no-store' });
      if (r.ok) {
        const data = await r.json();
        selectedExecutor = normalizeExecutorMode(data.mode);
        select.value = selectedExecutor;
      }
    } catch {
      selectedExecutor = normalizeExecutorMode(select.value);
    }

    updateHealth();

    select.addEventListener('change', async () => {
      const mode = normalizeExecutorMode(select.value);
      const stat = document.getElementById('exec-status');
      selectedExecutor = mode;
      if (stat) stat.textContent = '...';

      try {
        const r = await fetch('/api/executor/mode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode })
        });
        if (!r.ok) throw new Error('executor mode update failed');
        const data = await r.json().catch(() => ({ mode }));
        selectedExecutor = normalizeExecutorMode(data.mode || mode);
        select.value = selectedExecutor;
      } catch {
        setExecutorHudStatus({ status: 'error' }, { offline: true });
        return;
      }

      updateHealth();
    });
  }

  function start() {
    initExecutorSelect();
    updateHealth();
    if (!healthIntervalId) healthIntervalId = setInterval(updateHealth, 10 * 1000);
  }

  window.JarvisHealthExecutor = {
    init: start,
    initExecutorSelect,
    updateHealth,
    setExecutorHudStatus,
    normalizeExecutorMode
  };

  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', start)
    : start();
})();
