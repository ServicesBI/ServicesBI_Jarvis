// ═══ AI MODELS MODULE ═══
// Setor 5: Cards dos modelos LLM, badges, seleção visual

export function initAiModelsModule(deps) {

  // ── Model Badge Updates (DEEP, BUILD, FAST, VOICE, QUICK) ──
  // badges são controlados via CSS classes .active-model nos cards em script.js
  // este módulo gerencia o estado visual dos cards de modelo no cockpit

  function getEntityActive(name) {
    const row = document.querySelector(`[data-entity="${name}"]`);
    return row?.classList.contains('active') || false;
  }

  // ── Model Entity Detection via jarvis-log ──
  // Complementa o server-online.module.js com detecção de modelos por texto
  function detectModelFromText(text) {
    if (!text) return;
    const modelPatterns = [
      { p: /opus/i, e: 'opus' },
      { p: /sonnet/i, e: 'sonnet' },
      { p: /haiku/i, e: 'haiku' },
      { p: /realtime|gpt-4o-rt/i, e: 'gpt-realtime' },
      { p: /gpt-4o-mini/i, e: 'gpt-mini' },
    ];
    const pulse = deps.modules.pulseEntity || window.jarvisHUD?.pulseEntity;
    if (pulse) modelPatterns.forEach(r => { if (r.p.test(text)) pulse(r.e, 20000); });
  }

  // ── Model Card Status on Active Selection ──
  // Actualiza o card visual ativo quando o modelo muda no HUD
  function syncModelCardStatus() {
    const activeModelEl = document.getElementById('active-model');
    if (!activeModelEl) return;

    const modelText = activeModelEl.textContent.toLowerCase();
    document.querySelectorAll('.model-card').forEach(c => c.classList.remove('active-model'));
    if (modelText.includes('opus')) document.getElementById('model-opus')?.classList.add('active-model');
    else if (modelText.includes('sonnet')) document.getElementById('model-sonnet')?.classList.add('active-model');
    else if (modelText.includes('haiku')) document.getElementById('model-haiku')?.classList.add('active-model');
  }

  // ── Listen for model activity from terminal output ──
  window.addEventListener('jarvis-model-active', (e) => {
    const model = e.detail?.model;
    if (model) detectModelFromText(model);
  });

  // ── Expose via jarvisHUD ──
  window.jarvisHUD = window.jarvisHUD || {};
  window.jarvisHUD.detectModelFromText = detectModelFromText;
  window.jarvisHUD.syncModelCardStatus = syncModelCardStatus;

  // ── Init ──
  syncModelCardStatus();

  // Expose to cross-module registry
  deps.modules.detectModelFromText = detectModelFromText;
}
