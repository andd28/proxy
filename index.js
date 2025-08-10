const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

const POOL_SIZE = 5; // количество одновременно запущенных браузеров
const MAX_PAGE_TIMEOUT = 15000; // таймаут страницы в ms

// Список user-agent
const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15",
];

// Прокси и пул браузеров
let proxies = [];
let browsersPool = [];
let browserProxyMap = new Map(); // браузер -> прокси
let currentBrowserIndex = 0;

function loadProxies() {
  const proxiesPath = path.resolve('./proxies.txt');
  const data = fs.readFileSync(proxiesPath, 'utf-8');
  proxies = data
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);

  if (proxies.length === 0) {
    throw new Error('Прокси список пуст');
  }
}

// Возвращает user-agent случайный
function getRandomUserAgent() {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

// Форматируем прокси для puppeteer
function formatProxy(proxyRaw) {
  if (!proxyRaw.startsWith('http://') && !proxyRaw.startsWith('https://')) {
    return `http://${proxyRaw}`;
  }
  return proxyRaw;
}

// Инициализация пула браузеров с прокси
async function initBrowsersPool() {
  if (browsersPool.length > 0) return; // Уже инициализирован

  for (let i = 0; i < POOL_SIZE; i++) {
    const proxyRaw = proxies[i % proxies.length];
    const proxy = formatProxy(proxyRaw);

    console.log(`Запускаю браузер ${i} с прокси ${proxy}`);

    const browser = await puppeteer.launch({
      args: [...chromium.args, `--proxy-server=${proxy}`],
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    browsersPool.push(browser);
    browserProxyMap.set(browser, proxyRaw);
  }
}

// Получить следующий браузер из пула (циклично)
function getNextBrowser() {
  if (browsersPool.length === 0) throw new Error('Пул браузеров пуст');

  const browser = browsersPool[currentBrowserIndex];
  currentBrowserIndex = (currentBrowserIndex + 1) % browsersPool.length;
  return browser;
}

// Закрыть и перезапустить браузер с новым прокси
async function restartBrowser(index) {
  try {
    const oldBrowser = browsersPool[index];
    await oldBrowser.close();

    const proxyRaw = proxies[index % proxies.length];
    const proxy = formatProxy(proxyRaw);

    console.log(`Перезапускаю браузер ${index} с прокси ${proxy}`);

    const newBrowser = await puppeteer.launch({
      args: [...chromium.args, `--proxy-server=${proxy}`],
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    browsersPool[index] = newBrowser;
    browserProxyMap.set(newBrowser, proxyRaw);
  } catch (err) {
    console.error(`Ошибка перезапуска браузера ${index}:`, err);
  }
}

// Основная функция запроса
async function fetchWithPool(searchUrl, maxRetries = 10) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const browser = getNextBrowser();
    const browserIndex = browsersPool.indexOf(browser);
    const proxyRaw = browserProxyMap.get(browser);
    const userAgent = getRandomUserAgent();

    let page;

    try {
      page = await browser.newPage();
      await page.setUserAgent(userAgent);
      // Если прокси требует аутентификацию — надо реализовать page.authenticate здесь

      const response = await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: MAX_PAGE_TIMEOUT });

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

      await page.close();
      return json;

    } catch (err) {
      console.warn(`Попытка ${attempt} не удалась с прокси ${proxyRaw} и user-agent ${userAgent}: ${err.message}`);

      if (page) await page.close();

      // Перезапускаем браузер, чтобы обновить прокси/сессию
      await restartBrowser(browserIndex);
    }
  }

  throw new Error('Все попытки запроса не удались');
}

app.get('/tineye', async (req, res) => {
  try {
    if (proxies.length === 0) loadProxies();
    await initBrowsersPool();
  } catch (err) {
    return res.status(500).json({ error: err.toString() });
  }

  const { page = 1, url } = req.query;
  if (!url) return res.status(400).json({ error: 'Отсутствует параметр "url"' });

  const searchUrl = `https://tineye.com/api/v1/result_json/?page=${page}&url=${encodeURIComponent(url)}&tags=stock`;

  try {
    const result = await fetchWithPool(searchUrl);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.toString() });
  }
});

// Закрытие всех браузеров при завершении процесса
process.on('exit', async () => {
  for (const browser of browsersPool) {
    try {
      await browser.close();
    } catch {}
  }
});

app.listen(port, () => {
  console.log(`TinEye proxy listening on port ${port}`);
});
