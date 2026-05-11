// ========== TERMINAL ATTACHMENTS ==========
(function() {
  let currentAttachment = null;

  function getAttachment() {
    return currentAttachment;
  }

  function isImageAttachment(attachment) {
    if (!attachment) return false;
    const name = String(attachment.name || '').toLowerCase();
    const type = String(attachment.type || '').toLowerCase();
    return type === 'image' || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name);
  }

  function removeAttachmentPreview() {
    document.getElementById('att-preview')?.remove();
  }

  function showAttachmentPreview(name) {
    removeAttachmentPreview();
    const terminal = document.getElementById('terminal-output');
    if (!terminal) return;

    const preview = document.createElement('div');
    preview.className = 'terminal-line info-line attachment-preview';
    preview.id = 'att-preview';
    preview.innerHTML = `<span class="msg">📎 ${name}</span><button class="remove-att" onclick="removeAttachment()">✕</button>`;
    terminal.appendChild(preview);
    terminal.scrollTop = terminal.scrollHeight;
  }

  function removeAttachment() {
    currentAttachment = null;
    removeAttachmentPreview();
  }

  async function handleFileChange(e) {
    const file = e.target.files[0];
    if (!file) return;

    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/attach', { method: 'POST', body: formData });
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
      const data = await res.json();

      currentAttachment = {
        id: data.attachmentId,
        name: data.name || file.name,
        type: data.type || (file.type.startsWith('image/') ? 'image' : ''),
        path: data.path || ''
      };
      showAttachmentPreview(currentAttachment.name);
    } catch (err) {
      if (typeof window.addTerminalLine === 'function') {
        window.addTerminalLine(`[error] Upload failed: ${err.message}`, 'error-line');
      }
    }
    e.target.value = '';
  }

  function initAttachments() {
    const fileAttach = document.getElementById('file-attach');
    if (!fileAttach || fileAttach.dataset.attachmentsBound) return;
    fileAttach.dataset.attachmentsBound = '1';
    fileAttach.addEventListener('change', handleFileChange);
  }

  window.JarvisAttachments = {
    get: getAttachment,
    clear: removeAttachment,
    isImage: isImageAttachment,
    init: initAttachments
  };
  window.removeAttachment = removeAttachment;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAttachments, { once: true });
  } else {
    initAttachments();
  }
})();
