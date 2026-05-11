// ========== SIMPLE FRONTEND UTILITIES ==========
function getTimestamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function renderMarkdown(text) {
  try {
    if (typeof marked !== 'undefined') {
      marked.setOptions({
        highlight: function(code, lang) {
          if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
            return hljs.highlight(code, { language: lang }).value;
          }
          return code;
        },
        breaks: true,
        gfm: true
      });
      return marked.parse(text);
    }
    return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  } catch {
    return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

function copyToClipboard(text) {
  return navigator.clipboard.writeText(text);
}

function addCopyButtons(container) {
  container.querySelectorAll('pre').forEach(pre => {
    pre.style.position = 'relative';
    const btn = document.createElement('button');
    btn.className = 'code-copy-btn';
    btn.textContent = 'Copy';
    btn.onclick = () => {
      const code = pre.querySelector('code')?.textContent || pre.textContent;
      copyToClipboard(code);
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 1500);
    };
    pre.appendChild(btn);
  });
}

window.getTimestamp = getTimestamp;
window.renderMarkdown = renderMarkdown;
window.copyToClipboard = copyToClipboard;
window.addCopyButtons = addCopyButtons;
