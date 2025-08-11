const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch'); // v2
const https = require('https');
const { SocksProxyAgent } = require('socks-proxy-agent');

const proxiesPath = path.join(__dirname, 'proxies.txt');

let proxies = [];
try {
  proxies = fs.readFileSync(proxiesPath, 'utf8')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);
  console.log(`Загружено прокси из proxies.txt: ${proxies.length}`);
} catch (e) {
  console.error('Ошибка чтения proxies.txt:', e && e.message);
}

let currentProxyIndex = 0;
let requestCounter = 0;
const requestsPerProxy = 20;

function switchToNextProxy() {
  if (!proxies.length) return;
  currentProxyIndex = (currentProxyIndex + 1) % proxies.length;
  requestCounter = 0;
}

function createAgent(proxy) {
  // Отключаем проверку SSL сертификата (для TinEye через прокси с проблемами SSL)
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  // Возвращаем SocksProxyAgent для SOCKS4
  return new SocksProxyAgent(`socks4://${proxy}`);
}

async function fetchWithProxy(url) {
  if (proxies.length === 0) {
    throw new Error('Список прокси пуст или не загружен!');
  }

  let attempts = 0;
  let lastError = null;

  while (attempts < proxies.length) {
    if (requestCounter >= requestsPerProxy) {
      switchToNextProxy();
    }

    const proxy = proxies[currentProxyIndex];
    console.log(`Используем прокси #${currentProxyIndex}: ${proxy} (${requestCounter}/${requestsPerProxy})`);

    const agent = createAgent(proxy);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // таймаут 5 секунд

    try {
      const res = await fetch(url, { agent, signal: controller.signal });
      clearTimeout(timeoutId);

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
      clearTimeout(timeoutId);
      lastError = err.message || String(err);
      console.error(`Прокси ${proxy} не сработал: ${lastError}`);
      switchToNextProxy();
      attempts++;
      continue;
    }
  }

  throw new Error(`Все прокси не сработали. Последняя ошибка: ${lastError}`);
}

// Vercel / Serverless handler
module.exports = async (req, res) => {
  try {
    // Парсим параметры запроса
    const base = `https://${req.headers.host || 'example.com'}`;
    const reqUrl = new URL(req.url, base);
    const page = reqUrl.searchParams.get('page') || '1';
    const imageUrl = reqUrl.searchParams.get('url');

    if (!imageUrl) {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Missing "url" query parameter' }));
      return;
    }

    // Формируем url запроса к TinEye API
    const searchUrl = `https://tineye.com/api/v1/result_json/?page=${page}&url=${encodeURIComponent(imageUrl)}`;

    // Выполняем запрос через прокси
    const result = await fetchWithProxy(searchUrl);

    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(result));
  } catch (err) {
    console.error('Handler error:', err && err.stack ? err.stack : err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: err && err.message ? err.message : String(err) }));
  }
};

// Локальный тестовый сервер (запускается при node index.js)
if (require.main === module) {
  const express = require('express');
  const app = express();

  app.get('/tineye', module.exports);

  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Local test server listening: http://localhost:${port}/tineye`));
}
