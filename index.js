const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch');
const { SocksProxyAgent } = require('socks-proxy-agent');

let proxies = [];
let currentProxyIndex = 0;
let requestCounter = 0;
const requestsPerProxy = 20;

// Цикл переключения прокси
function switchToNextProxy() {
  if (proxies.length === 0) return;
  currentProxyIndex = (currentProxyIndex + 1) % proxies.length;
  requestCounter = 0;
}

async function fetchWithProxy(url) {
  if (proxies.length === 0) {
    throw new Error('Прокси не загружены или список пуст');
  }

  let attempts = 0;
  let lastError = null;

  while (attempts < proxies.length) {
    if (requestCounter >= requestsPerProxy) {
      switchToNextProxy();
    }

    const proxy = proxies[currentProxyIndex];
    console.log(`Используем прокси #${currentProxyIndex}: ${proxy} (${requestCounter}/${requestsPerProxy})`);

    // SOCKS4 прокси URL формат для socks-proxy-agent: "socks4://host:port"
    const agent = new SocksProxyAgent(`socks4://${proxy}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    try {
      const res = await fetch(url, { agent, signal: controller.signal });
      clearTimeout(timeout);

      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        console.warn(`Прокси ${proxy} вернул статус ${res.status}, переключаемся`);
        switchToNextProxy();
        attempts++;
        continue;
      }

      const json = await res.json();
      if (!json || Object.keys(json).length === 0) {
        lastError = 'Пустой JSON из TinEye';
        console.warn(`Прокси ${proxy} вернул пустой JSON, переключаемся`);
        switchToNextProxy();
        attempts++;
        continue;
      }

      requestCounter++;
      return {
        proxyUsed: proxy,
        proxyIndex: currentProxyIndex,
        requestCountForProxy: requestCounter,
        data: json,
      };
    } catch (err) {
      clearTimeout(timeout);
      lastError = err.message || String(err);
      console.error(`Прокси ${proxy} не сработал: ${lastError}`);
      switchToNextProxy();
      attempts++;
      continue;
    }
  }

  throw new Error(`Все прокси не сработали. Последняя ошибка: ${lastError}`);
}

async function loadProxies() {
  try {
    const proxiesPath = path.join(__dirname, 'proxies.txt');
    const content = await fs.readFile(proxiesPath, 'utf8');
    proxies = content
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean);
    console.log(`Загружено прокси: ${proxies.length}`);
  } catch (err) {
    console.error('Ошибка чтения proxies.txt:', err);
    proxies = [];
  }
}

module.exports = async (req, res) => {
  try {
    if (proxies.length === 0) {
      await loadProxies();
      if (proxies.length === 0) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Прокси не загружены или список пуст' }));
        return;
      }
    }

    const base = `https://${req.headers.host || 'example.com'}`;
    const reqUrl = new URL(req.url, base);
    const page = reqUrl.searchParams.get('page') || '1';
    const imageUrl = reqUrl.searchParams.get('url');

    if (!imageUrl) {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Отсутствует параметр "url"' }));
      return;
    }

    const searchUrl = `https://tineye.com/api/v1/result_json/?page=${page}&url=${encodeURIComponent(imageUrl)}`;

    const result = await fetchWithProxy(searchUrl);

    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(result));
  } catch (err) {
    console.error('Ошибка в обработчике:', err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: err.message || String(err) }));
  }
};

// Для локального теста (запуск node index.js)
if (require.main === module) {
  const express = require('express');
  const app = express();

  app.get('/tineye', module.exports);

  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Локальный сервер запущен: http://localhost:${port}/tineye`));
}
