// ═══ MENU MODULE ═══
// Setor 2: Navegação, abas, arquivos, configurações

export function initMenuModule(deps) {

  // ── Bottom Panels Toggle ──
  function initBottomPanelsToggle() {
    const toggleBtn = document.getElementById('toggle-bottom-panels');
    const cockpit = document.querySelector('.cockpit-iron');
    if (!toggleBtn || !cockpit) return;

    const setCollapsed = (collapsed) => {
      cockpit.classList.toggle('bottom-panels-collapsed', collapsed);
      toggleBtn.setAttribute('aria-expanded', String(!collapsed));
      const label = collapsed ? 'Expandir paineis inferiores' : 'Recolher paineis inferiores';
      toggleBtn.setAttribute('aria-label', label);
      toggleBtn.title = label;
      localStorage.setItem('jarvis-bottom-panels-collapsed', collapsed ? '1' : '0');
    };

    setCollapsed(localStorage.getItem('jarvis-bottom-panels-collapsed') === '1');
    toggleBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      setCollapsed(!cockpit.classList.contains('bottom-panels-collapsed'));
    });
  }

  // ── Tab Navigation + Back to Cockpit ──
  function initTabNavigation() {
    const backToCockpitBtn = document.createElement('button');
    backToCockpitBtn.id = 'back-to-cockpit';
    backToCockpitBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;vertical-align:middle;margin-right:4px;"><polyline points="15 18 9 12 15 6"/></svg>COCKPIT';
    backToCockpitBtn.style.cssText = 'display:none;position:fixed;top:12px;left:12px;z-index:9999;padding:8px 16px;background:rgba(0,20,40,0.9);border:1px solid var(--cyan);border-radius:6px;color:var(--cyan);font-family:Orbitron,sans-serif;font-size:10px;letter-spacing:1px;cursor:pointer;transition:all 0.3s;backdrop-filter:blur(10px);box-shadow:0 0 15px rgba(0,228,255,0.2);';
    backToCockpitBtn.onmouseenter = function() { this.style.background = 'rgba(0,228,255,0.15)'; this.style.boxShadow = '0 0 20px rgba(0,228,255,0.4)'; };
    backToCockpitBtn.onmouseleave = function() { this.style.background = 'rgba(0,20,40,0.9)'; this.style.boxShadow = '0 0 15px rgba(0,228,255,0.2)'; };
    backToCockpitBtn.onclick = function() {
      const cockpitTab = document.querySelector('.tab-btn[data-tab="principal"]');
      if (cockpitTab) cockpitTab.click();
    };
    document.body.appendChild(backToCockpitBtn);

    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        const panel = document.getElementById(`tab-${btn.dataset.tab}`);
        if (panel) panel.classList.add('active');
        backToCockpitBtn.style.display = btn.dataset.tab === 'principal' ? 'none' : 'block';
        if (btn.dataset.tab === 'file') loadFiles();
      });
    });
  }

  // ── File Browser ──
  async function loadFiles() {
    try {
      const res = await fetch('/api/files');
      const data = await res.json();
      const fileList = document.getElementById('file-list');
      if (!fileList) return;

      if (!data.files || data.files.length === 0) {
        fileList.innerHTML = '<div class="file-empty">No files yet. Ask JARVIS to create something.</div>';
        return;
      }

      const icons = {
        '.pdf': '📕', '.md': '📝', '.txt': '📄', '.html': '🌐', '.css': '🎨',
        '.js': '⚡', '.ts': '💠', '.py': '🐍', '.json': '📋', '.png': '🖼️',
        '.jpg': '🖼️', '.jpeg': '🖼️', '.gif': '🖼️', '.svg': '🖼️',
        '.xlsx': '📊', '.pptx': '📽️', '.docx': '📃', '.zip': '📦',
        '.mp3': '🎵', '.mp4': '🎬', '.wav': '🎵'
      };

      const byProject = {};
      for (const f of data.files) {
        const proj = f.project || 'General';
        if (!byProject[proj]) byProject[proj] = [];
        byProject[proj].push(f);
      }

      fileList.innerHTML = Object.entries(byProject).map(([project, files]) => {
        const items = files.map(f => {
          const icon = icons[f.ext] || '📄';
          const size = f.size > 1024*1024 ? `${(f.size/1024/1024).toFixed(1)} MB` : `${(f.size/1024).toFixed(1)} KB`;
          const date = new Date(f.createdAt).toLocaleDateString();
          return `<div class="file-item">
            <span class="file-item-icon">${icon}</span>
            <div class="file-item-info">
              <div class="file-item-name">${f.name}</div>
              <div class="file-item-meta">${size} · ${date}</div>
            </div>
            <div class="file-item-actions">
              <a href="/api/files/view?path=${encodeURIComponent(f.path)}" target="_blank">Preview</a>
              <a href="${f.downloadUrl}" download>Download</a>
            </div>
          </div>`;
        }).join('');
        return `<div class="file-project-group"><div class="file-project-header">${project}</div>${items}</div>`;
      }).join('');
    } catch {
      const fileList = document.getElementById('file-list');
      if (fileList) fileList.innerHTML = '<div class="file-empty">Error loading files.</div>';
    }
  }

  // ── Config Event Listeners ──
  function initConfigListeners() {
    document.getElementById('save-api-key')?.addEventListener('click', async () => {
      const key = document.getElementById('config-api-key')?.value;
      if (!key) return;
      try {
        await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'OPENAI_API_KEY', value: key }) });
        deps.addTerminalLine('[system] API key updated. Restart server for changes to take effect.', 'system-line');
      } catch (err) {
        deps.addTerminalLine(`[error] Failed to save config: ${err.message}`, 'error-line');
      }
    });

    document.getElementById('config-voice')?.addEventListener('change', (e) => {
      deps.voiceEnabled = e.target.checked;
      deps.setVoiceStatus('auto');
      deps.addTerminalLine(`[system] Voice ${deps.voiceEnabled ? 'enabled' : 'disabled'}`, 'system-line');
    });

    document.getElementById('config-wakeword')?.addEventListener('change', (e) => {
      deps.wakeWordEnabled = e.target.checked;
      localStorage.setItem('jarvis-wakeword-disabled', deps.wakeWordEnabled ? 'false' : 'true');
      if (deps.wakeWordEnabled) {
        try {
          deps.startWakeWord();
          deps.addTerminalLine('[system] Wake word "Jarvis" activated', 'system-line');
        } catch (err) {
          deps.wakeWordEnabled = false;
          e.target.checked = false;
          deps.addTerminalLine(`[error] Wake word failed: ${err.message || err}`, 'error-line');
        }
      } else {
        deps.stopWakeWord();
        deps.addTerminalLine('[system] Wake word deactivated', 'system-line');
      }
    });

    const ttsVoiceSelect = document.getElementById('config-tts-voice');
    if (ttsVoiceSelect) {
      ttsVoiceSelect.value = deps.ttsVoice;
      ttsVoiceSelect.addEventListener('change', (e) => {
        deps.ttsVoice = e.target.value;
        localStorage.setItem('ttsVoice', deps.ttsVoice);
        deps.addTerminalLine(`[info] TTS voice set to: ${deps.ttsVoice}`, 'info-line');
      });
    }
  }

  // ── Wake Word Auto-Start ──
  function initWakeWordAutoStart() {
    const canWebSpeech = 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;
    setTimeout(() => {
      const userDisabled = localStorage.getItem('jarvis-wakeword-disabled') === 'true';
      if (canWebSpeech && !deps.wakeWordEnabled && !userDisabled) {
        try {
          deps.wakeWordEnabled = true;
          deps.startWakeWord();
          console.log('[JARVIS] Wake word "JARVIS" auto-activated');
          const wakeChk = document.getElementById('config-wakeword');
          if (wakeChk) wakeChk.checked = true;
        } catch (err) {
          console.warn('[JARVIS] Wake word auto-start failed (mic denied?):', err.message || err);
          deps.wakeWordEnabled = false;
        }
      }
    }, 2000);
  }

  // ── Init ──
  initBottomPanelsToggle();
  initTabNavigation();
  initConfigListeners();
  initWakeWordAutoStart();
}
