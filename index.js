const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch'); // v2
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

if (proxies.length === 0) {
  console.warn('Внимание! Список прокси пуст.');
}

let currentProxyIndex = 0;
let requestCounter = 0;
const requestsPerProxy = 20;

function switchToNextProxy() {
  currentProxyIndex = (currentProxyIndex + 1) % proxies.length;
  requestCounter = 0;
  console.log(`Сменили прокси на #${currentProxyIndex}: ${proxies[currentProxyIndex]}`);
}

function createAgent(proxy) {
  // Отключаем проверку сертификата (TinEye иногда может иметь проблемы)
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  return new SocksProxyAgent(`socks4://${proxy}`);
}

async function fetchWithProxy(url) {
  if (proxies.length === 0) {
    throw new Error('Список прокси пуст или не загружен!');
  }

  // Переключаем прокси, если достигли лимита запросов на текущем
  if (requestCounter >= requestsPerProxy) {
    switchToNextProxy();
  }

  const proxy = proxies[currentProxyIndex];
  console.log(`Используем прокси #${currentProxyIndex}: ${proxy} (${requestCounter + 1}/${requestsPerProxy})`);

  const agent = createAgent(proxy);

  try {
    const res = await fetch(url, { agent, timeout: 8000 });
    if (!res.ok) {
      throw new Error(`HTTP статус ${res.status}`);
    }

    const json = await res.json();
    if (!json || Object.keys(json).length === 0) {
      throw new Error('Пустой JSON');
    }

    requestCounter++;
    return {
      proxyUsed: proxy,
      proxyIndex: currentProxyIndex,
      requestCountForProxy: requestCounter,
      data: json,
    };
  } catch (err) {
    console.error(`Прокси ${proxy} не сработал: ${err.message}`);

    // При ошибке меняем прокси и повторяем попытку (рекурсивно)
    switchToNextProxy();

    // Рекурсивно повторяем запрос
    return fetchWithProxy(url);
  }
}

// Vercel handler
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

// Локальный тестовый сервер (при node index.js)
if (require.main === module) {
  const express = require('express');
  const app = express();

  app.get('/tineye', module.exports);

  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Local test server listening: http://localhost:${port}/tineye`));
}
