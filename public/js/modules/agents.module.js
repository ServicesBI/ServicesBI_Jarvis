// ═══ AGENTS MODULE ═══
// Setor 4: Cards dos agentes, ativação de entidades, seleção visual

export function initAgentsModule(deps) {

  // ── Entity Activation (modelos/agentes/conclave) ──
  function setEntityActive(name, active) {
    const row = document.querySelector(`[data-entity="${name}"]`);
    if (!row) return;
    if (active) { row.classList.add('active'); row.classList.remove('idle'); }
    else { row.classList.remove('active'); row.classList.add('idle'); }
  }

  function pulseEntity(name, ms) {
    setEntityActive(name, true);
    setTimeout(() => setEntityActive(name, false), ms || 15000);
  }

  const rules = [
    { p: /opus/i, e: 'opus' }, { p: /sonnet/i, e: 'sonnet' }, { p: /haiku/i, e: 'haiku' },
    { p: /realtime|gpt-4o-rt/i, e: 'gpt-realtime' }, { p: /gpt-4o-mini/i, e: 'gpt-mini' },
    { p: /@architect|aria/i, e: 'architect' }, { p: /@dev\b|dex/i, e: 'dev' },
    { p: /@qa|quinn/i, e: 'qa' }, { p: /@pm|morgan/i, e: 'pm' },
    { p: /@po\b|pax/i, e: 'po' }, { p: /@analyst|atlas/i, e: 'analyst' },
    { p: /@ux|uma/i, e: 'ux' }, { p: /@devops|gage/i, e: 'devops' },
    { p: /@sm\b|river/i, e: 'sm' }, { p: /data.engineer|dara/i, e: 'data-engineer' },
    { p: /aios.master|orion/i, e: 'aios-master' }, { p: /squad.creator|craft/i, e: 'squad-creator' },
    { p: /conclave.critico|critico/i, e: 'conclave-critico' },
    { p: /conclave.advogado|advogado/i, e: 'conclave-advogado' },
    { p: /conclave.sintetizador|sintetizador/i, e: 'conclave-sintetizador' },
  ];

  // ── Active Agents Panel ──
  const agentsList = document.getElementById('agents-list');
  const activeAgents = new Set();

  function addAgent(name) { activeAgents.add(name); renderAgents(); }
  function removeAgent(name) { activeAgents.delete(name); renderAgents(); }
  function renderAgents() {
    if (!agentsList) return;
    if (activeAgents.size === 0) { agentsList.innerHTML = '<span class="agent-pill idle">nenhum</span>'; return; }
    agentsList.innerHTML = [...activeAgents].map(a => `<span class="agent-pill active">${a}</span>`).join('');
  }

  // ── Expose via jarvisHUD ──
  window.jarvisHUD = window.jarvisHUD || {};
  window.jarvisHUD.setEntityActive = setEntityActive;
  window.jarvisHUD.pulseEntity = pulseEntity;
  window.jarvisHUD.addAgent = addAgent;
  window.jarvisHUD.removeAgent = removeAgent;
  window.jarvisHUD.detectAgent = (text) => {
    const agents = ['architect', 'dev', 'qa', 'pm', 'po', 'analyst', 'ux', 'devops', 'conclave'];
    agents.forEach(a => {
      if (text?.toLowerCase().includes(`@${a}`) || text?.toLowerCase().includes(a)) {
        addAgent(a);
        setTimeout(() => removeAgent(a), 30000);
      }
    });
  };
  window.jarvisHUD.analyzeText = function(text) {
    if (!text) return;
    rules.forEach(r => { if (r.p.test(text)) pulseEntity(r.e, 20000); });
  };

  // ── Agent Chip Click → insert @mention + highlight model ──
  document.querySelectorAll('.agent-chip[data-agent]').forEach(chip => {
    chip.style.cursor = 'pointer';
    chip.addEventListener('click', () => {
      const agent = chip.dataset.agent;
      const mention = `@${agent} `;
      const input = document.getElementById('chat-input');
      if (!input) return;
      if (!input.value.startsWith('@')) input.value = mention + input.value;
      else input.value = mention;
      input.focus();
      if (typeof deps.setModelFromAgent === 'function') deps.setModelFromAgent(chip);
      document.querySelectorAll('.agent-chip').forEach(c => c.classList.remove('active-agent'));
      chip.classList.add('active-agent');
    });
  });

  // ── Cross-module registry ──
  deps.modules.setEntityActive = setEntityActive;
  deps.modules.pulseEntity = pulseEntity;
  deps.modules.addAgent = addAgent;
  deps.modules.removeAgent = removeAgent;
}
