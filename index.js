const fetch = require('node-fetch'); // v2
const { SocksProxyAgent } = require('socks-proxy-agent');

// Жёстко заданный SOCKS4 прокси
const PROXY = '159.65.128.194:1080';

// Создаём агент для SOCKS4
function createAgent() {
  // Отключаем проверку сертификата (для теста)
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  return new SocksProxyAgent(`socks4://${PROXY}`);
}

async function fetchWithProxy(url) {
  const agent = createAgent();

  const controller = new AbortController();
  const timeoutMs = 10000;
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const res = await fetch(url, {
      agent,
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      throw new Error(`HTTP status ${res.status}`);
    }

    const json = await res.json();
    return json;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
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

    const data = await fetchWithProxy(searchUrl);

    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ proxyUsed: PROXY, data }));
  } catch (err) {
    console.error('Handler error:', err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: err.message || String(err) }));
  }
};

// Локальный запуск для теста
if (require.main === module) {
  const express = require('express');
  const app = express();

  app.get('/tineye', module.exports);

  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Local server listening on http://localhost:${port}/tineye`));
}
