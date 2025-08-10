const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Загружаем список прокси
const proxiesPath = path.join(__dirname, 'proxies.txt');
const proxies = fs.readFileSync(proxiesPath, 'utf-8')
  .split(/\r?\n/)
  .map(line => line.trim())
  .filter(line => line.length > 0);

if (proxies.length === 0) {
  console.error('Нет доступных прокси в proxies.txt');
  process.exit(1);
}

let currentProxyIndex = 0;
let currentProxyCount = 0;
const maxRequestsPerProxy = 10;

function getCurrentProxy() {
  return proxies[currentProxyIndex];
}

function switchToNextProxy() {
  currentProxyIndex = (currentProxyIndex + 1) % proxies.length;
  currentProxyCount = 0;
}

app.get('/tineye', async (req, res) => {
  const { page = 1, url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Missing "url" parameter' });
  }

  const searchUrl = `https://tineye.com/api/v1/result_json/?page=${page}&url=${encodeURIComponent(url)}`;

  let browser;
  let proxy = getCurrentProxy();
  let attempt = 0;
  let maxProxyAttempts = proxies.length;
  let finalError = null;

  while (attempt < maxProxyAttempts) {
    try {
      console.log(`🔍 Попытка ${attempt + 1}: используем прокси ${proxy} (запрос ${currentProxyCount + 1}/${maxRequestsPerProxy})`);

      browser = await puppeteer.launch({
        args: [
          ...chromium.args,
          `--proxy-server=${proxy}`
        ],
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
      });

      const pageP = await browser.newPage();
      await pageP.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
      );

      await pageP.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });

      const content = await pageP.evaluate(() => document.body.innerText);
      let json;

      try {
        json = JSON.parse(content);
      } catch (e) {
        throw new Error(`JSON parse error: ${content.slice(0, 200)}`);
      }

      // Считаем использование прокси
      currentProxyCount++;
      if (currentProxyCount >= maxRequestsPerProxy) {
        console.log(`🔄 Прокси ${proxy} достиг лимита ${maxRequestsPerProxy}, переключаемся`);
        switchToNextProxy();
      }

      return res.status(200).json({
        proxyUsed: proxy,
        proxyIndex: currentProxyIndex,
        requestCountForProxy: currentProxyCount,
        data: json
      });

    } catch (err) {
      console.error(`❌ Ошибка на прокси ${proxy}:`, err.message);
      finalError = err;
      switchToNextProxy();
      proxy = getCurrentProxy();
      attempt++;
    } finally {
      if (browser) {
        try { await browser.close(); } catch {}
      }
    }
  }

  res.status(500).json({
    error: 'Все прокси не сработали',
    lastError: finalError ? finalError.message : null
  });
});

app.listen(port, () => {
  console.log(`🚀 TinEye proxy listening on port ${port}`);
});
