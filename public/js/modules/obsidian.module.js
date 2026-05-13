// ═══ OBSIDIAN MODULE ═══
// Setor 7: Obsidian Brain Explorer, vault, notas, stats

export function initObsidianModule(deps) {

  // ── Obsidian Stats Cards ──
  function _setObs(id, val) { const e = document.getElementById(id); if (e) e.textContent = val; }

  async function loadObsidianStats() {
    try {
      const r = await fetch('/api/obsidian/stats');
      if (!r.ok) throw new Error('offline');
      const data = await r.json();
      if (data.connected) {
        _setObs('obsidian-notes', data.notes + ' notas');
        _setObs('obsidian-status', 'conectado');
        _setObs('obs-folders', data.folders);
        _setObs('obs-links', data.links);
        _setObs('obs-name', data.name || 'Obsidian');
        _setObs('obs-status', 'Conectado');
        _setObs('obs-val-folders', data.folders ?? '?');
        _setObs('obs-val-links', data.links ?? '?');
        _setObs('obs-val-brain', data.brain ?? '?');
        _setObs('obs-val-agents', data.agents ?? '15');
      } else {
        _setObs('obsidian-notes', 'N/A');
        _setObs('obsidian-status', 'vault nao instalado');
        _setObs('obs-name', 'N/A');
        _setObs('obs-status', 'Offline');
      }
    } catch {
      _setObs('obsidian-notes', 'N/A');
      _setObs('obsidian-status', 'offline');
      _setObs('obs-name', 'N/A');
      _setObs('obs-status', 'Offline');
    }
  }

  // ── Brain Viewer Modal ──
  function initBrainViewer() {
    const brainModal = document.getElementById('brain-modal');
    const btnBrain = document.getElementById('btn-brain');
    const brainClose = document.getElementById('brain-close');
    const brainMaximize = document.getElementById('brain-maximize');
    const brainTree = document.getElementById('brain-tree');
    const brainPreview = document.getElementById('brain-preview');
    const brainSearch = document.getElementById('brain-search');

    function openBrainModal() {
      if (brainModal) { brainModal.style.display = 'flex'; loadBrainTree(); }
    }
    function closeBrainModal() {
      if (brainModal) brainModal.style.display = 'none';
    }

    if (btnBrain) btnBrain.addEventListener('click', openBrainModal);
    if (brainClose) brainClose.addEventListener('click', closeBrainModal);

    if (brainMaximize) {
      brainMaximize.addEventListener('click', () => {
        const card = brainModal?.querySelector('.modal-brain');
        if (!card) return;
        card.classList.toggle('maximized');
        brainMaximize.textContent = card.classList.contains('maximized') ? '✐' : '⬜';
      });
    }

    // Close modals on overlay click
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.style.display = 'none';
      });
    });

    // ── Brain Tree ──
    async function loadBrainTree() {
      if (!brainTree) return;
      brainTree.innerHTML = '<div class="brain-loading">Carregando vault...</div>';
      try {
        const r = await fetch('/api/obsidian/tree');
        const data = await r.json();
        if (!data.tree || !data.tree.length) { brainTree.innerHTML = '<div class="brain-loading">Vault vazio ou nao encontrado</div>'; return; }
        brainTree.innerHTML = '';
        renderTree(data.tree, brainTree);
      } catch (err) {
        brainTree.innerHTML = `<div class="brain-loading">Erro: ${err.message}</div>`;
      }
    }

    function renderTree(items, parent) {
      items.forEach(item => {
        if (item.type === 'folder') {
          const folder = document.createElement('div');
          folder.className = 'brain-folder';
          const header = document.createElement('div');
          header.className = 'brain-folder-header';
          header.innerHTML = `<span class="folder-icon">📁</span><span class="folder-name">${item.name}</span><span class="folder-count">${item.children ? item.children.length : 0}</span>`;
          const items_div = document.createElement('div');
          items_div.className = 'brain-folder-items';
          items_div.style.display = 'none';
          header.addEventListener('click', () => {
            items_div.style.display = items_div.style.display === 'none' ? 'block' : 'none';
            header.querySelector('.folder-icon').textContent = items_div.style.display === 'none' ? '📁' : '📂';
          });
          folder.appendChild(header);
          folder.appendChild(items_div);
          if (item.children) renderTree(item.children, items_div);
          parent.appendChild(folder);
        } else {
          const note = document.createElement('div');
          note.className = 'brain-note';
          note.innerHTML = `<span class="note-icon">📄</span> ${item.name}`;
          note.addEventListener('click', () => {
            document.querySelectorAll('.brain-note').forEach(n => n.classList.remove('active'));
            note.classList.add('active');
            loadNote(item.path);
          });
          parent.appendChild(note);
        }
      });
    }

    async function loadNote(notePath) {
      if (!brainPreview) return;
      brainPreview.innerHTML = '<div class="brain-loading">Carregando...</div>';
      try {
        const r = await fetch('/api/obsidian/note?path=' + encodeURIComponent(notePath));
        const data = await r.json();
        if (data.content) {
          let html = (typeof marked !== 'undefined' ? marked.parse(data.content) : data.content);
          html = html.replace(/\[\[([^\]|#]+)\]\]/g, '<span class="brain-link" data-link="$1">$1</span>');
          brainPreview.innerHTML = html;
          brainPreview.querySelectorAll('.brain-link').forEach(link => {
            link.addEventListener('click', () => {
              const target = link.dataset.link;
              let noteEl = null;
              document.querySelectorAll('.brain-note').forEach(n => { if (n.textContent.trim().includes(target)) noteEl = n; });
              if (noteEl) noteEl.click();
            });
          });
        } else {
          brainPreview.innerHTML = '<div class="brain-empty"><p>Nota nao encontrada</p></div>';
        }
      } catch (err) {
        brainPreview.innerHTML = `<div class="brain-empty"><p>Erro: ${err.message}</p></div>`;
      }
    }

    // Brain search
    if (brainSearch) {
      brainSearch.addEventListener('input', () => {
        const q = brainSearch.value.toLowerCase();
        document.querySelectorAll('.brain-note').forEach(n => {
          n.style.display = n.textContent.toLowerCase().includes(q) ? '' : 'none';
        });
        document.querySelectorAll('.brain-folder-items').forEach(fi => {
          const hasVisible = fi.querySelector('.brain-note:not([style*="display: none"])');
          fi.style.display = q && hasVisible ? 'block' : (q ? 'none' : '');
        });
      });
    }

    // Expose global functions for compatibility
    window.openBrainModal = openBrainModal;
    window.closeBrainModal = closeBrainModal;
    window.loadBrainTree = loadBrainTree;
    window.loadBrainNote = loadNote;

    deps.modules.openBrainModal = openBrainModal;
    deps.modules.closeBrainModal = closeBrainModal;
    deps.modules.loadBrainTree = loadBrainTree;
  }

  // ── Init ──
  loadObsidianStats();
  setInterval(loadObsidianStats, 60000);
  initBrainViewer();

  // Cross-module registry
  deps.modules.loadObsidianStats = loadObsidianStats;
  window.jarvisModules = window.jarvisModules || {};
  window.jarvisModules.loadObsidianStats = loadObsidianStats;
}
