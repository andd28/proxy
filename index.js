const express = require('express');
const fs = require('fs');
const fetch = require('node-fetch');
const HttpsProxyAgent = require('https-proxy-agent');

const app = express();
const port = process.env.PORT || 3000;

// Загружаем список прокси
let proxies = fs.readFileSync('proxies.txt', 'utf-8')
  .split('\n')
  .map(p => p.trim())
  .filter(p => p.length > 0);

if (proxies.length === 0) {
  console.error('Файл proxies.txt пуст!');
  process.exit(1);
}

let currentProxyIndex = 0;
let requestCounter = 0;
const requestsPerProxy = 10;

console.log(`Загружено ${proxies.length} прокси`);

// Функция запроса через прокси с таймаутом
async function fetchWithProxy(url) {
  let attempts = 0;
  let lastError = null;

  while (attempts < proxies.length) {
    // Если сделали requestsPerProxy запросов — переключаем прокси
    if (requestCounter >= requestsPerProxy) {
      currentProxyIndex = (currentProxyIndex + 1) % proxies.length;
      requestCounter = 0;
    }

    const proxy = proxies[currentProxyIndex];
    console.log(`Пробуем прокси: ${proxy} (попытка ${attempts + 1})`);

    const agent = new HttpsProxyAgent(`http://${proxy}`);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);

      const res = await fetch(url, {
        agent,
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        // Переключаемся на следующий прокси
        currentProxyIndex = (currentProxyIndex + 1) % proxies.length;
        attempts++;
        continue;
      }

      const json = await res.json();
      requestCounter++;
      return json;

    } catch (err) {
      lastError = err.message;
      currentProxyIndex = (currentProxyIndex + 1) % proxies.length;
      attempts++;
      continue;
    }
  }

  throw new Error(`Все прокси не сработали. Последняя ошибка: ${lastError}`);
}

// API-эндпоинт
app.get('/tineye', async (req, res) => {
  const { page = 1, url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Missing "url" parameter' });
  }

  const searchUrl = `https://tineye.com/api/v1/result_json/?page=${page}&url=${encodeURIComponent(url)}`;

  try {
    const data = await fetchWithProxy(searchUrl);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => {
  console.log(`TinEye proxy listening on port ${port}`);
});
