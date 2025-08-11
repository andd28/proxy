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
  console.log(`Loaded proxies from proxies.txt: ${proxies.length}`);
} catch (e) {
  console.error('Error reading proxies.txt:', e && e.message);
}

let currentProxyIndex = 0;
let requestCounter = 0;
const requestsPerProxy = 20;

function switchToNextProxy() {
  if (!proxies.length) return;
  currentProxyIndex = (currentProxyIndex + 1) % proxies.length;
  requestCounter = 0;
  console.log(`Switched to proxy #${currentProxyIndex}: ${proxies[currentProxyIndex]}`);
}

function createAgent(proxy) {
  // Отключаем проверку SSL (для теста, осторожно!)
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  return new SocksProxyAgent(`socks4://${proxy}`);
}

async function fetchWithProxy(url) {
  if (proxies.length === 0) {
    throw new Error('Proxy list is empty or not loaded');
  }

  let attempts = 0;
  let lastError = null;

  while (attempts < proxies.length) {
    if (requestCounter >= requestsPerProxy) {
      switchToNextProxy();
    }

    const proxy = proxies[currentProxyIndex];
    console.log(`Using proxy #${currentProxyIndex}: ${proxy} (${requestCounter}/${requestsPerProxy})`);

    const agent = createAgent(proxy);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s таймаут

    try {
      const res = await fetch(url, {
        agent,
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        }
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        lastError = `HTTP status ${res.status}`;
        console.warn(`Proxy ${proxy} returned status ${res.status}, switching proxy`);
        switchToNextProxy();
        attempts++;
        continue;
      }

      const text = await res.text();

      if (!text || text.trim().length === 0) {
        lastError = 'Empty response body';
        console.warn(`Proxy ${proxy} returned empty body, switching proxy`);
        switchToNextProxy();
        attempts++;
        continue;
      }

      let json;
      try {
        json = JSON.parse(text);
      } catch (parseErr) {
        lastError = `JSON parse error: ${parseErr.message}`;
        console.warn(`Proxy ${proxy} JSON parse failed, switching proxy`);
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
      console.error(`Proxy ${proxy} failed: ${lastError}`);
      switchToNextProxy();
      attempts++;
    }
  }

  throw new Error(`All proxies failed. Last error: ${lastError}`);
}

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

// Локальный тест (express)
if (require.main === module) {
  const express = require('express');
  const app = express();

  app.get('/tineye', module.exports);

  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Local server listening on http://localhost:${port}/tineye`));
}
