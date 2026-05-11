// Lightweight modal open/close bindings.
(function() {
  function getModal(id) {
    return document.getElementById(id);
  }

  function openModal(id, zIndex) {
    const modal = getModal(id);
    if (!modal) return;
    modal.style.display = 'flex';
    modal.style.visibility = 'visible';
    modal.style.opacity = '1';
    modal.style.pointerEvents = 'auto';
    if (zIndex) modal.style.zIndex = String(zIndex);
  }

  function closeModal(id) {
    const modal = getModal(id);
    if (modal) modal.style.display = 'none';
  }

  function openIngestModal() {
    openModal('ingest-modal', 9999);
  }

  function closeIngestModal() {
    closeModal('ingest-modal');
  }

  function openBrainModal() {
    openModal('brain-modal', 999999);
  }

  function closeBrainModal() {
    closeModal('brain-modal');
  }

  function toggleBrainMaximize() {
    const modal = getModal('brain-modal');
    const card = modal?.querySelector('.modal-brain, .modal-card');
    const button = document.getElementById('brain-maximize');
    if (!card) return;
    card.classList.toggle('maximized');
    if (button) button.textContent = card.classList.contains('maximized') ? '\u2750' : '\u2B1C';
  }

  function bindOnce(el, key, event, handler) {
    if (!el || el.dataset[key]) return;
    el.dataset[key] = '1';
    el.addEventListener(event, handler);
  }

  function bindOpenTargets(selector, opener) {
    document.querySelectorAll(selector).forEach((el) => {
      bindOnce(el, 'modalUiBound', 'click', (event) => {
        event.preventDefault();
        opener();
      });
      bindOnce(el, 'modalUiKeyBound', 'keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        opener();
      });
    });
  }

  function init() {
    bindOpenTargets('#btn-ingest, [data-action="open-ingest"]', openIngestModal);
    bindOpenTargets('[data-action="open-brain"], #btn-brain', openBrainModal);

    bindOnce(document.getElementById('ingest-close'), 'modalUiBound', 'click', closeIngestModal);
    bindOnce(document.getElementById('ingest-cancel'), 'modalUiBound', 'click', closeIngestModal);
    bindOnce(document.getElementById('brain-close'), 'modalUiBound', 'click', closeBrainModal);
    bindOnce(document.getElementById('brain-maximize'), 'modalUiBound', 'click', toggleBrainMaximize);

    document.querySelectorAll('.modal-overlay').forEach((overlay) => {
      bindOnce(overlay, 'modalUiOverlayBound', 'click', (event) => {
        if (event.target === overlay) closeModal(overlay.id);
      });
    });
  }

  window.JarvisModalsUI = {
    init,
    openModal,
    closeModal,
    openIngestModal,
    closeIngestModal,
    openBrainModal,
    closeBrainModal,
    toggleBrainMaximize
  };

  window.openIngestModalSafe = window.openIngestModalSafe || openIngestModal;
  window.closeIngestModalSafe = window.closeIngestModalSafe || closeIngestModal;
  window.openBrainModalSafe = window.openBrainModalSafe || openBrainModal;
  window.closeBrainModalSafe = window.closeBrainModalSafe || closeBrainModal;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
