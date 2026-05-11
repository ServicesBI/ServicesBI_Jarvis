// === DATE + TIME WIDGET ===
(function() {
  var days = ['DOMINGO', 'SEGUNDA-FEIRA', 'TER\u00c7A-FEIRA', 'QUARTA-FEIRA', 'QUINTA-FEIRA', 'SEXTA-FEIRA', 'S\u00c1BADO'];

  function updateJarvisClock() {
    var now = new Date();
    var dayEl = document.getElementById('date-day');
    var timeEl = document.getElementById('date-time');
    var fullEl = document.getElementById('date-full');

    if (dayEl) dayEl.textContent = days[now.getDay()];
    if (timeEl) {
      timeEl.textContent = now.toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    }
    if (fullEl) {
      var d = String(now.getDate()).padStart(2, '0');
      var m = String(now.getMonth() + 1).padStart(2, '0');
      var y = String(now.getFullYear()).slice(-2);
      fullEl.textContent = d + '/' + m + '/' + y;
    }
  }

  window.updateJarvisClock = updateJarvisClock;
  updateJarvisClock();
  setInterval(updateJarvisClock, 1000);
})();
