(function() {
  const DEFAULT_CITY = 'Presidente Prudente';
  const UPDATE_INTERVAL_MS = 15 * 60 * 1000;
  let weatherIntervalId = null;
  let weatherAvailable = false;
  let weatherEnabled = false;

  function getWeatherElements() {
    return {
      city: document.getElementById('weather-city'),
      temp: document.getElementById('weather-temp'),
      desc: document.getElementById('weather-desc')
    };
  }

  function hasWeatherWidget() {
    const els = getWeatherElements();
    return !!(els.city || els.temp || els.desc);
  }

  function renderWeather(data) {
    if (!data) return;
    const els = getWeatherElements();
    if (els.city) els.city.textContent = String(data.city || DEFAULT_CITY).toUpperCase();
    if (els.temp) els.temp.textContent = `${data.temp}\u00B0C`;
    if (els.desc) els.desc.textContent = data.desc || '';
  }

  function renderOffline() {
    const els = getWeatherElements();
    if (els.city) els.city.textContent = 'OFFLINE';
    if (els.temp) els.temp.textContent = '--\u00B0C';
    if (els.desc) els.desc.textContent = 'sem conexao';
  }

  function getBrowserPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('geolocation unavailable'));
        return;
      }
      navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 5000, maximumAge: 300000 });
    });
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`request failed: ${response.status}`);
    return response.json();
  }

  async function detectCity() {
    let city = DEFAULT_CITY;

    try {
      const pos = await getBrowserPosition();
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      const geo = await fetchJson(`https://wttr.in/${lat},${lon}?format=j1`);
      const area = geo.nearest_area?.[0];
      if (area) city = area.areaName?.[0]?.value || area.region?.[0]?.value || city;
      return city;
    } catch {}

    try {
      const geo = await fetchJson('https://ipapi.co/json/');
      if (geo.city) return geo.city;
    } catch {}

    try {
      const geo = await fetchJson('https://ip-api.com/json/?fields=city');
      if (geo.city) return geo.city;
    } catch {}

    return city;
  }

  async function fetchWeather(city) {
    try {
      return await fetchJson(`/api/weather?city=${encodeURIComponent(city)}`);
    } catch {}

    const weather = await fetchJson(`https://wttr.in/${encodeURIComponent(city)}?format=j1`);
    const current = weather.current_condition?.[0];
    if (!current) return null;

    return {
      city,
      temp: current.temp_C,
      desc: current.lang_pt?.[0]?.value || current.weatherDesc?.[0]?.value || ''
    };
  }

  async function loadWeather() {
    if (!hasWeatherWidget()) {
      weatherAvailable = false;
      weatherEnabled = false;
      return null;
    }

    weatherAvailable = true;
    weatherEnabled = true;

    try {
      const city = await detectCity();
      const data = await fetchWeather(city);
      if (data) renderWeather(data);
      return data || null;
    } catch {
      renderOffline();
      return null;
    }
  }

  function start() {
    if (!hasWeatherWidget()) {
      weatherAvailable = false;
      weatherEnabled = false;
      return false;
    }

    weatherAvailable = true;
    weatherEnabled = true;
    loadWeather();
    if (!weatherIntervalId) weatherIntervalId = setInterval(loadWeather, UPDATE_INTERVAL_MS);
    return true;
  }

  window.JarvisWeather = {
    init: start,
    loadWeather,
    detectCity,
    fetchWeather,
    hasWeatherWidget,
    renderWeather,
    renderOffline,
    get available() {
      return weatherAvailable;
    },
    get enabled() {
      return weatherEnabled;
    },
    get intervalActive() {
      return !!weatherIntervalId;
    }
  };

  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', start, { once: true })
    : start();
})();
