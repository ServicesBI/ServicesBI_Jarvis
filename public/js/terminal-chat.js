(function() {
  function getTerminalOutput() {
    return document.getElementById('terminal-output');
  }

  function addTerminalLine(text, type = '') {
    const terminal = getTerminalOutput();
    if (!terminal) return;

    const line = document.createElement('div');
    line.className = `terminal-line ${type}`;
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = `[${window.getTimestamp()}]`;
    const msg = document.createElement('span');
    msg.className = 'msg';

    if (type === '' || type === 'jarvis-line') {
      msg.innerHTML = window.renderMarkdown(text);
      window.addCopyButtons(msg);
    } else {
      msg.textContent = text;
    }

    line.appendChild(ts);
    line.appendChild(document.createTextNode(' '));
    line.appendChild(msg);
    terminal.appendChild(line);
    terminal.scrollTop = terminal.scrollHeight;
  }

  function addDownloadCard(fileName, filePath) {
    const terminal = getTerminalOutput();
    if (!terminal) return;

    const card = document.createElement('div');
    card.className = 'download-card';
    card.innerHTML = `
      <span class="file-icon">&#128196;</span>
      <span class="file-name">${fileName}</span>
      <a class="dl-btn" href="/api/files/download?path=${encodeURIComponent(filePath)}" download>Download</a>
    `;
    terminal.appendChild(card);
    terminal.scrollTop = terminal.scrollHeight;
  }

  function getLocalDateTimeAnswer(text) {
    const normalized = String(text || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    const asksDay = /\b(que dia|dia e hoje|data de hoje|qual a data)\b/.test(normalized);
    const asksTime = /\b(que horas|quantas horas|hora e|horario|agora sao)\b/.test(normalized);
    if (!asksDay && !asksTime) return '';

    const now = new Date();
    const dayNames = ['domingo', 'segunda-feira', 'ter\u00E7a-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 's\u00E1bado'];
    const d = String(now.getDate()).padStart(2, '0');
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const y = now.getFullYear();
    const h = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const dayName = dayNames[now.getDay()];

    if (asksDay && asksTime) return `Hoje \u00E9 ${dayName}, ${d}/${m}/${y}, e agora s\u00E3o ${h}:${min}.`;
    if (asksDay) return `Hoje \u00E9 ${dayName}, ${d}/${m}/${y}.`;
    return `Agora s\u00E3o ${h}:${min}.`;
  }

  window.addTerminalLine = addTerminalLine;
  window.addDownloadCard = addDownloadCard;
  window.getLocalDateTimeAnswer = getLocalDateTimeAnswer;
  window.JarvisTerminalChat = {
    addTerminalLine,
    addDownloadCard,
    getLocalDateTimeAnswer
  };
})();
