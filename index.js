// index.js — улучшенная версия (Vercel) с быстрым переключением и защитой от 429
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch'); // v2
const { SocksProxyAgent } = require('socks-proxy-agent');
const pLimit = require('p-limit');

const proxiesPath = path.join(__dirname, 'proxies.txt');
const requestsPerProxy = 20;
const proxyCooldownMs = 30000; // 30 секунд между использованиями одного прокси
const proxyBanMs = 3 * 60 * 1000; // 3 минуты бан за 429
const maxConsecutiveErrors = 3; // после 3 ошибок подряд прокси уходит в бан
const timeoutMs = 5000; // 5 сек таймаут запроса
const parallelLimit = 3; // одновременно запросов

// Загружаем прокси
let proxies = [];
try {
  proxies = fs.readFileSync(proxiesPath, 'utf8')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(p => ({
      host: p,
      lastUsed: 0,
      errorCount: 0,
      bannedUntil: 0,
      usageCount: 0
    }));
  console.log(`Загружено прокси: ${proxies.length}`);
} catch (e) {
  console.error('Ошибка чтения proxies.txt:', e && e.message);
}

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Получаем доступный прокси
function getAvailableProxy() {
  const now = Date.now();
  let candidate = null;

  for (let p of proxies) {
    if (now < p.bannedUntil) continue; // прокси в бане
    if (now - p.lastUsed < proxyCooldownMs) continue; // слишком часто
    if (p.usageCount >= requestsPerProxy) {
      p.usageCount = 0;
      continue;
    }
    candidate = p;
    break;
  }
  return candidate;
}

function createAgent(proxy) {
  return new SocksProxyAgent(`socks4://${proxy.host}`);
}

async function fetchWithProxy(url) {
  let proxy = getAvailableProxy();
  if (!proxy) throw new Error('Нет доступных прокси');

  proxy.lastUsed = Date.now();
  proxy.usageCount++;
  console.log(`Используем прокси: ${proxy.host} (${proxy.usageCount}/${requestsPerProxy})`);

  const agent = createAgent(proxy);

  try {
    const res = await fetch(url, { agent, timeout: timeoutMs });

    if (res.status === 429) {
      console.warn(`429 от TinEye → баним прокси ${proxy.host} на ${proxyBanMs / 1000} сек`);
      proxy.bannedUntil = Date.now() + proxyBanMs;
      throw new Error(`HTTP 429 Too Many Requests`);
    }

    if (!res.ok) throw new Error(`HTTP статус ${res.status}`);

    const json = await res.json();
    if (!json || Object.keys(json).length === 0) throw new Error('Пустой JSON');

    proxy.errorCount = 0; // успешный запрос
    return json;
  } catch (err) {
    proxy.errorCount++;
    console.error(`Ошибка через прокси ${proxy.host}: ${err.message} (ошибок подряд: ${proxy.errorCount})`);

    if (proxy.errorCount >= maxConsecutiveErrors) {
      console.warn(`Прокси ${proxy.host} временно в бане из-за ${maxConsecutiveErrors} ошибок`);
      proxy.bannedUntil = Date.now() + proxyBanMs;
      proxy.errorCount = 0;
    }
    throw err;
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
    if (tags) searchUrl += `&tags=${encodeURIComponent(tags)}`;

    const data = await fetchWithProxy(searchUrl);

    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(data));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: err.message || String(err) }));
  }
};

// Локальный тест
if (require.main === module) {
  const express = require('express');
  const app = express();
  const limit = pLimit(parallelLimit);

  app.get('/tineye', module.exports);

  // пример параллельной проверки
  app.get('/batch', async (req, res) => {
    const urls = (req.query.urls || '').split(',').map(u => u.trim()).filter(Boolean);
    const results = await Promise.allSettled(urls.map(url => limit(() =>
      fetchWithProxy(`https://tineye.com/api/v1/result_json/?page=1&url=${encodeURIComponent(url)}&tags=stock`)
    )));
    res.json(results);
  });

  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Local test server: http://localhost:${port}`));
}
