// index.js — версия с быстрым переключением на следующий прокси при долгом подключении
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

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

function switchToNextProxy() {
  if (proxies.length === 0) return;
  currentProxyIndex = (currentProxyIndex + 1) % proxies.length;
  requestCounter = 0;
  console.log(`Сменили прокси на #${currentProxyIndex}: ${proxies[currentProxyIndex]}`);
}

function createAgent(proxy) {
  return new SocksProxyAgent(`socks4://${proxy}`);
}

// Функция с быстрым переключением при зависании
async function fetchWithProxy(url, attemptsLeft = proxies.length) {
  if (proxies.length === 0) {
    throw new Error('Список прокси пуст или не загружен!');
  }
  if (attemptsLeft <= 0) {
    throw new Error('Все прокси не сработали (исчерпаны попытки).');
  }

  if (requestCounter >= requestsPerProxy) {
    switchToNextProxy();
  }

  const proxy = proxies[currentProxyIndex];
  console.log(`Используем прокси #${currentProxyIndex}: ${proxy} (${requestCounter + 1}/${requestsPerProxy})`);

  const agent = createAgent(proxy);

  // Таймаут подключения (не всего запроса!)
  const CONNECT_TIMEOUT = 1500; // 1.5 секунды
  const REQUEST_TIMEOUT = 5000; // общий таймаут запроса

  try {
    const controller = new AbortController();
    const connectTimer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT);

    const res = await fetch(url, { agent, timeout: REQUEST_TIMEOUT, signal: controller.signal });
    clearTimeout(connectTimer);

    if (!res.ok) {
      if (res.status === 429) {
        throw new Error('HTTP 429 Too Many Requests');
      }
      throw new Error(`HTTP статус ${res.status}`);
    }

    const json = await res.json();
    if (!json || (typeof json === 'object' && Object.keys(json).length === 0)) {
      throw new Error('Пустой JSON от TinEye');
    }

    requestCounter++;
    return json;
  } catch (err) {
    clearTimeout();
    console.error(`Прокси ${proxy} не сработал: ${err.message}. Переходим к следующему...`);
    switchToNextProxy();
    return fetchWithProxy(url, attemptsLeft - 1);
  }
}

// Vercel handler
module.exports = async (req, res) => {
  try {
    const base = `https://${req.headers.host || 'example.com'}`;
    const reqUrl = new URL(req.url, base);
    const page = reqUrl.searchParams.get('page') || '1';
    const imageUrl = reqUrl.searchParams.get('url');
    const tags = reqUrl.searchParams.get('tags');

    if (!imageUrl) {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Missing "url" query parameter' }));
      return;
    }

    let searchUrl = `https://tineye.com/api/v1/result_json/?page=${page}&url=${encodeURIComponent(imageUrl)}`;
    if (tags) {
      searchUrl += `&tags=${encodeURIComponent(tags)}`;
    }

    console.log('Запрос к TinEye:', searchUrl);

    const tineyeJson = await fetchWithProxy(searchUrl);

    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(tineyeJson));
  } catch (err) {
    console.error('Handler error:', err && err.stack ? err.stack : err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: err && err.message ? err.message : String(err) }));
  }
};

// Локальный тестовый сервер
if (require.main === module) {
  const express = require('express');
  const app = express();
  app.get('/tineye', module.exports);
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Local test server listening: http://localhost:${port}/tineye`));
}
