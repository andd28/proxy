const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch'); // v2
const { HttpsProxyAgent } = require('https-proxy-agent');

const proxiesPath = path.join(__dirname, 'proxies.txt');
let proxies = [];
try {
  proxies = fs.readFileSync(proxiesPath, 'utf8')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);
} catch (e) {
  console.error('Ошибка чтения proxies.txt:', e && e.message);
}

let currentProxyIndex = 0;
let requestCounter = 0;
const requestsPerProxy = 10;

process.on('uncaughtException', (err) => {
  console.error('uncaughtException', err);
});
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection', err);
});

function switchToNextProxy() {
  if (!proxies.length) return;
  currentProxyIndex = (currentProxyIndex + 1) % proxies.length;
  requestCounter = 0;
}

async function fetchWithProxy(url) {
  if (!proxies.length) {
    throw new Error('No proxies configured (proxies.txt is empty or missing)');
  }

  let attempts = 0;
  let lastError = null;
  const total = proxies.length;

  while (attempts < total) {
    if (requestCounter >= requestsPerProxy) {
      switchToNextProxy();
    }

    const proxy = proxies[currentProxyIndex];
    console.log(`Пытаемся прокси [${currentProxyIndex}]: ${proxy} (использовано ${requestCounter}/${requestsPerProxy})`);

    const agent = new HttpsProxyAgent(`http://${proxy}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000); // 2s

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
        lastError = 'Empty JSON from TinEye';
        console.warn(`Прокси ${proxy} вернул пустой JSON, переключаемся`);
        switchToNextProxy();
        attempts++;
        continue;
      }

      requestCounter++;
      return { proxyUsed: proxy, proxyIndex: currentProxyIndex, requestCountForProxy: requestCounter, data: json };

    } catch (err) {
      clearTimeout(timeoutId);
      lastError = err && err.message ? err.message : String(err);
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

    const searchUrl = `https://tineye.com/api/v1/result_json/?page=${page}&url=${encodeURIComponent(imageUrl)}`;

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

// -- локальный тестовый сервер (запускается если файл запущен напрямую)
if (require.main === module) {
  const express = require('express');
  const app = express();
  app.get('/tineye', module.exports);
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Local test server listening: http://localhost:${port}/tineye`));
}
