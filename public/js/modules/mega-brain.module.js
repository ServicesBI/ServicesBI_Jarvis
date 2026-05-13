// ═══ MEGA BRAIN MODULE ═══
// Setor 6: Conclave, ingestão de conhecimento, Mega-Brain

export function initMegaBrainModule(deps) {

  // ── Conclave Toggle (sincroniza com deps.conclaveEnabled de script.js) ──
  function initConclaveToggle() {
    const cb = document.getElementById('conclave-checkbox');
    const chip = cb?.closest('.mega-chip');
    if (!cb) return;

    cb.checked = deps.conclaveEnabled;
    if (!deps.conclaveEnabled) chip?.classList.add('conclave-off');

    cb.addEventListener('change', () => {
      deps.conclaveEnabled = cb.checked;
      localStorage.setItem('jarvis-conclave', deps.conclaveEnabled);
      if (deps.conclaveEnabled) chip?.classList.remove('conclave-off');
      else chip?.classList.add('conclave-off');
    });
  }

  // ── Ingest Modal ──
  function initIngestModal() {
    const ingestModal = document.getElementById('ingest-modal');
    const btnIngest = document.getElementById('btn-ingest');
    const ingestClose = document.getElementById('ingest-close');
    const ingestCancel = document.getElementById('ingest-cancel');
    const ingestSubmit = document.getElementById('ingest-submit');
    const ingestStatus = document.getElementById('ingest-status');

    function openIngestModal() { if (ingestModal) ingestModal.style.display = 'flex'; }
    function closeIngestModal() { if (ingestModal) ingestModal.style.display = 'none'; }

    if (btnIngest) btnIngest.addEventListener('click', openIngestModal);
    if (ingestClose) ingestClose.addEventListener('click', closeIngestModal);
    if (ingestCancel) ingestCancel.addEventListener('click', closeIngestModal);

    // Ingest tabs
    document.querySelectorAll('.ingest-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.ingest-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.ingest-panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        const panel = document.getElementById('ingest-' + tab.dataset.ingest);
        if (panel) panel.classList.add('active');
      });
    });

    // File dropzone
    const dropzone = document.getElementById('ingest-dropzone');
    const fileInput = document.getElementById('ingest-file-input');
    const fileNameEl = document.getElementById('ingest-file-name');
    let selectedFile = null;

    if (dropzone) {
      dropzone.addEventListener('click', () => fileInput?.click());
      dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
      dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
      dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        if (e.dataTransfer.files.length) {
          selectedFile = e.dataTransfer.files[0];
          if (fileNameEl) fileNameEl.textContent = `✅ ${selectedFile.name} (${Math.round(selectedFile.size/1024)}KB)`;
        }
      });
      if (fileInput) {
        fileInput.addEventListener('change', () => {
          if (fileInput.files.length) {
            selectedFile = fileInput.files[0];
            if (fileNameEl) fileNameEl.textContent = `✅ ${selectedFile.name} (${Math.round(selectedFile.size/1024)}KB)`;
          }
        });
      }
    }

    // Submit ingest
    if (ingestSubmit) {
      ingestSubmit.addEventListener('click', async () => {
        const activeTab = document.querySelector('.ingest-tab.active');
        const tabType = activeTab ? activeTab.dataset.ingest : 'text';
        if (ingestStatus) ingestStatus.textContent = '⏳ Processando...';
        ingestSubmit.disabled = true;

        try {
          let body = {};

          if (tabType === 'text') {
            const text = document.getElementById('ingest-text-input')?.value.trim();
            const cat = document.getElementById('ingest-text-category')?.value;
            if (!text) { if (ingestStatus) ingestStatus.textContent = '❌ Digite algo primeiro'; ingestSubmit.disabled = false; return; }
            body = { type: 'text', text, category: cat };
          }

          if (tabType === 'file') {
            if (!selectedFile) { if (ingestStatus) ingestStatus.textContent = '❌ Selecione um arquivo'; ingestSubmit.disabled = false; return; }
            const reader = new FileReader();
            const content = await new Promise(resolve => { reader.onload = () => resolve(reader.result); reader.readAsText(selectedFile); });
            body = { type: 'file', fileName: selectedFile.name, fileContent: content };
          }

          if (tabType === 'session') {
            body = { type: 'session' };
          }

          const r = await fetch('/api/obsidian/ingest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
          const data = await r.json();

          if (data.ok) {
            if (ingestStatus) ingestStatus.textContent = `✅ Salvo no Obsidian: ${data.title || data.count + ' notas'}`;
            const loadStats = deps.modules.loadObsidianStats || window.jarvisModules?.loadObsidianStats;
            if (loadStats) loadStats();
            setTimeout(() => { closeIngestModal(); if (ingestStatus) ingestStatus.textContent = ''; }, 2000);
          } else {
            if (ingestStatus) ingestStatus.textContent = `❌ ${data.error || 'Erro desconhecido'}`;
          }
        } catch (err) {
          if (ingestStatus) ingestStatus.textContent = `❌ ${err.message}`;
        }
        ingestSubmit.disabled = false;
      });
    }

    window.openIngestModal = openIngestModal;
    window.closeIngestModal = closeIngestModal;
    deps.modules.openIngestModal = openIngestModal;
    deps.modules.closeIngestModal = closeIngestModal;
  }

  // ── Init ──
  initConclaveToggle();
  initIngestModal();
}
