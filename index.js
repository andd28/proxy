const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

const proxiesPath = path.join(__dirname, 'proxies.txt');
const proxies = fs.readFileSync(proxiesPath, 'utf-8')
  .split(/\r?\n/)
  .map(line => line.trim())
  .filter(Boolean);

if (!proxies.length) {
  console.error('Нет доступных прокси');
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
  let finalError = null;

  // Перебираем прокси, пока не найдём рабочий
  for (let attempt = 0; attempt < proxies.length; attempt++) {
    const proxy = getCurrentProxy();
    console.log(`🔍 Проверяем прокси ${proxy} (попытка ${attempt + 1})`);

    try {
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

      // Быстрый таймаут 2 секунды
      await pageP.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 2000 });

      const content = await pageP.evaluate(() => document.body.innerText);
      let json;

      try {
        json = JSON.parse(content);
      } catch {
        throw new Error(`JSON parse error: ${content.slice(0, 200)}`);
      }

      // Если TinEye вернул пустой ответ, идём к следующему прокси
      if (!json || Object.keys(json).length === 0) {
        throw new Error('TinEye вернул пустой ответ');
      }

      // Счётчик использования прокси
      currentProxyCount++;
      if (currentProxyCount >= maxRequestsPerProxy) {
        console.log(`🔄 Прокси ${proxy} достиг лимита, переключаемся`);
        switchToNextProxy();
      }

      return res.status(200).json({
        proxyUsed: proxy,
        proxyIndex: currentProxyIndex,
        requestCountForProxy: currentProxyCount,
        data: json
      });

    } catch (err) {
      console.error(`❌ Прокси ${getCurrentProxy()} не сработал: ${err.message}`);
      finalError = err;
      switchToNextProxy();
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
