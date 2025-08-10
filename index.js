const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// User-Agent список (можно расширить)
const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.5993.90 Safari/537.36",
];

// Глобальные переменные для прокси и индексов
let proxies = [];
let proxyIndex = 0;
const badUserAgents = new Set();

// Загрузка прокси из файла proxies.txt (один прокси на строку)
async function loadProxies() {
  const proxiesPath = path.resolve('./proxies.txt');
  const data = await fs.promises.readFile(proxiesPath, 'utf-8');
  proxies = data
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
  if (proxies.length === 0) {
    throw new Error('Список прокси пуст');
  }
}

// Получить следующий прокси по кругу
function getNextProxy() {
  if (proxies.length === 0) throw new Error('Прокси не загружены');
  const proxy = proxies[proxyIndex];
  proxyIndex = (proxyIndex + 1) % proxies.length;
  return proxy.startsWith('http://') || proxy.startsWith('https://') ? proxy : 'http://' + proxy;
}

// Получить случайный рабочий user-agent
function getRandomUserAgent() {
  const available = userAgents.filter(ua => !badUserAgents.has(ua));
  if (available.length === 0) {
    badUserAgents.clear();
    return userAgents[Math.floor(Math.random() * userAgents.length)];
  }
  return available[Math.floor(Math.random() * available.length)];
}

// Основная функция с retry и сменой прокси и user-agent
async function fetchWithRetry(searchUrl, maxRetries = 10) {
  let browser;
  let lastError = null;

  if (proxies.length === 0) {
    await loadProxies();
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const proxy = getNextProxy();
    const userAgent = getRandomUserAgent();

    try {
      browser = await puppeteer.launch({
        args: [
          ...chromium.args,
          `--proxy-server=${proxy}`,
          '--no-sandbox',
          '--disable-setuid-sandbox',
        ],
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
      });

      const page = await browser.newPage();
      await page.setUserAgent(userAgent);

      // Отключаем загрузку тяжелых ресурсов
      await page.setRequestInterception(true);
      page.on('request', request => {
        const resourceType = request.resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
          request.abort();
        } else {
          request.continue();
        }
      });

      const response = await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });

      if (!response || !response.ok()) {
        throw new Error(`HTTP status ${response ? response.status() : 'no response'}`);
      }

      const content = await page.evaluate(() => document.body.innerText);

      let json;
      try {
        json = JSON.parse(content);
      } catch {
        throw new Error('Не удалось распарсить JSON от TinEye');
      }

      await browser.close();
      return json;

    } catch (err) {
      lastError = err;
      badUserAgents.add(userAgent);

      if (browser) {
        try {
          await browser.close();
        } catch {}

      }

      console.warn(`Попытка ${attempt} не удалась с прокси ${proxy} и user-agent ${userAgent}: ${err.message}`);

      // Пауза не нужна — переходим сразу к следующему
    }
  }

  throw lastError;
}

app.get('/tineye', async (req, res) => {
  const { page = 1, url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Отсутствует параметр "url"' });
  }

  const searchUrl = `https://tineye.com/api/v1/result_json/?page=${page}&url=${encodeURIComponent(url)}&tags=stock`;

  try {
    const result = await fetchWithRetry(searchUrl);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.toString() });
  }
});

app.listen(port, () => {
  console.log(`TinEye proxy listening on port ${port}`);
});
