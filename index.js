const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Прокси из файла
let proxies = [];
let currentProxyIndex = 0;

// Список user-agent
const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15",
  // Добавь сюда свои UA
];

const badUserAgents = new Set();

function getRandomUserAgent() {
  const available = userAgents.filter(ua => !badUserAgents.has(ua));
  if (available.length === 0) {
    badUserAgents.clear();
    return userAgents[Math.floor(Math.random() * userAgents.length)];
  }
  return available[Math.floor(Math.random() * available.length)];
}

function loadProxies() {
  const proxiesPath = path.resolve('./proxies.txt');
  const data = fs.readFileSync(proxiesPath, 'utf-8');
  proxies = data
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
  if (proxies.length === 0) {
    throw new Error('Список прокси пуст');
  }
}

// Получаем следующий прокси циклично
function getNextProxy() {
  if (proxies.length === 0) {
    throw new Error('Прокси не загружены');
  }
  const proxy = proxies[currentProxyIndex];
  currentProxyIndex = (currentProxyIndex + 1) % proxies.length;
  return proxy;
}

async function fetchWithRetry(searchUrl) {
  let browser;
  let lastError = null;
  // Максимум попыток — длина списка прокси
  const maxRetries = proxies.length;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const proxyRaw = getNextProxy();
    const userAgent = getRandomUserAgent();

    // Формат прокси для puppeteer: если нет протокола — добавляем http://
    const proxy = proxyRaw.match(/^https?:\/\//) ? proxyRaw : `http://${proxyRaw}`;

    try {
      browser = await puppeteer.launch({
        args: [...chromium.args, `--proxy-server=${proxy}`],
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
      });

      const page = await browser.newPage();
      await page.setUserAgent(userAgent);

      // Если твои прокси требуют аутентификацию - добавь здесь, например:
      // await page.authenticate({username: 'user', password: 'pass'});

      const response = await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 20000 });

      if (!response || !response.ok()) {
        throw new Error(`HTTP status ${response ? response.status() : 'no response'}`);
      }

      // Ждём 1 секунду для загрузки JSON
      await new Promise(r => setTimeout(r, 1000));

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
        await browser.close();
      }

      console.warn(`Попытка ${attempt} не удалась с прокси ${proxyRaw} и user-agent ${userAgent}: ${err.message}`);

      // Сразу переключаемся на следующий прокси без задержек
      // (если хочешь — можешь добавить небольшую паузу)
    }
  }

  throw lastError;
}

app.get('/tineye', async (req, res) => {
  try {
    if (proxies.length === 0) {
      loadProxies();
    }
  } catch (err) {
    return res.status(500).json({ error: err.toString() });
  }

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
